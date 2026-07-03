// WebRTC transport for the demo — a working proof that the UNMODIFIED player + controller apps and the
// real protocol run peer-to-peer over an RTCDataChannel instead of the WebSocket hub.
//
// Loaded BEFORE demo/mock-hub.js, it installs a {post, onAny} bus on self.__MP_BUS__ with the SAME
// interface as the BroadcastChannel bus. mock-hub.js then reuses its ENTIRE hub (protocol.js reducers,
// the sleep timer, the registry) unchanged — only the transport of app frames changes: instead of
// BroadcastChannel, the hub-host peer accepts a data channel from each other peer and relays over it.
//
// PROTOTYPE SCOPE: signaling (SDP/ICE) here rides BroadcastChannel, so this demonstrates the WebRTC path
// between contexts on the SAME device (they connect via loopback ICE — no STUN/TURN). For real
// cross-device P2P you swap THIS one signaling channel for a network one (a serverless endpoint, or the
// hub used purely as a signaler), keep everything else, and add STUN — plus a TURN relay for the cases
// where two peers can't connect directly (off-LAN, symmetric NAT). See docs/DEPLOY.md.

// Inert unless the page opted into the WebRTC transport with ?rtc — the normal demo (intro, /live/)
// keeps using the BroadcastChannel bus. Only the /rtc/ landing loads the apps with ?rtc.
if (new URLSearchParams(self.location ? self.location.search : '').has('rtc')) installRtcBus();

function installRtcBus() {
const ICE = []; // same-device demo: loopback candidates need no STUN. Real use: [{urls:'stun:stun.l.google.com:19302'}, …TURN]
const CTX = 'x' + Math.random().toString(36).slice(2, 8); // this context's signaling address
const sig = new BroadcastChannel('mp-rtc-sig');
const signal = (m) => sig.postMessage({ ...m, _c: CTX });
const localSinks = new Set();
const emit = (m) => { for (const fn of localSinks) queueMicrotask(() => fn(m)); }; // same-context delivery

let role = 'neutral';                 // 'host' (runs the hub) | 'client' | 'neutral'
const dcByConn = new Map();            // host: app connId -> data channel
const connsByDc = new Map();           // host: data channel -> Set(connId) (for clean offline on close)
const pcByPeer = new Map();            // host: peer ctxId -> RTCPeerConnection
let hostPc = null, hostDc = null, hostCtx = null; // client: the single link to the host
const outQ = [];                       // client: frames queued until the channel opens

function wireHostChannel(dc) {
  connsByDc.set(dc, new Set());
  dc.onopen = () => console.log('[rtc] host: peer channel open');
  dc.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.from) { dcByConn.set(m.from, dc); connsByDc.get(dc).add(m.from); } // learn connId -> channel
    emit(m); // → the host's MiniHub._route (same context)
  };
  dc.onclose = () => { // a peer left → mark its devices offline so the parent alarm can fire
    for (const id of connsByDc.get(dc) || []) { dcByConn.delete(id); emit({ to: 'hub', from: id, gone: true }); }
    connsByDc.delete(dc);
  };
}
function wireClientChannel(dc) {
  hostDc = dc;
  dc.onopen = () => { console.log('[rtc] client: channel open, flushing', outQ.length); while (outQ.length) dc.send(outQ.shift()); };
  dc.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } emit(m); }; // → global onAny → fake socket
}

async function hostHandleOffer(peer, sdp) {
  let pc = pcByPeer.get(peer);
  if (!pc) {
    pc = new RTCPeerConnection({ iceServers: ICE });
    pcByPeer.set(peer, pc);
    pc.onicecandidate = (e) => e.candidate && signal({ t: 'ice', to: peer, candidate: e.candidate.toJSON() });
    pc.ondatachannel = (e) => wireHostChannel(e.channel);
  }
  await pc.setRemoteDescription(sdp); // sdp is a plain {type, sdp} from the offer message
  const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
  console.log('[rtc] host: answering', peer);
  signal({ t: 'answer', to: peer, sdp: { type: ans.type, sdp: ans.sdp } });
}
async function clientConnect() {
  if (hostPc) return;
  hostPc = new RTCPeerConnection({ iceServers: ICE });
  hostPc.onicecandidate = (e) => e.candidate && hostCtx && signal({ t: 'ice', to: hostCtx, candidate: e.candidate.toJSON() });
  wireClientChannel(hostPc.createDataChannel('mp'));
  const off = await hostPc.createOffer(); await hostPc.setLocalDescription(off);
  signal({ t: 'offer', sdp: { type: off.type, sdp: off.sdp } });
}

sig.onmessage = async (ev) => {
  const m = ev.data; if (!m || m._c === CTX) return; // BroadcastChannel doesn't echo, but be safe
  try {
    if (role === 'host') {
      if (m.t === 'need-host') return signal({ t: 'host-up' });
      if (m.t === 'offer') return void hostHandleOffer(m._c, m.sdp);
      if (m.t === 'ice' && m.to === CTX) { const pc = pcByPeer.get(m._c); if (pc) await pc.addIceCandidate(m.candidate); return; }
    } else {
      if (m.t === 'host-up' && role === 'neutral') { hostCtx = m._c; role = 'client'; console.log('[rtc] became client → host', hostCtx); return void clientConnect(); }
      if (m.t === 'answer' && m.to === CTX && hostPc) return void hostPc.setRemoteDescription(m.sdp);
      if (m.t === 'ice' && m.to === CTX && hostPc) return void hostPc.addIceCandidate(m.candidate);
    }
  } catch (e) { console.warn('[rtc] signaling error', e); }
};

self.__MP_BUS__ = {
  post(m) {
    emit(m); // same-context sinks (host: MiniHub + its own app; client: global onAny, which ignores app→hub)
    if (role === 'host') {
      if (m.to && m.to !== 'hub') { const dc = dcByConn.get(m.to); if (dc && dc.readyState === 'open') dc.send(JSON.stringify(m)); }
      else if (!m.to) { for (const dc of dcByConn.values()) if (dc.readyState === 'open') dc.send(JSON.stringify(m)); } // broadcast (hubReady)
    } else if (m.to === 'hub') { // client app → hub, over the channel (queued until open)
      const s = JSON.stringify(m);
      if (hostDc && hostDc.readyState === 'open') hostDc.send(s); else outQ.push(s);
    }
  },
  onAny(fn) { localSinks.add(fn); },
  setHost() { role = 'host'; console.log('[rtc] became host'); signal({ t: 'host-up' }); }, // called by mock-hub when this context wins the hub lock
};

// Discovery: ask for a host until we've become one or connected to one.
let tries = 0;
const ping = setInterval(() => { if (role !== 'neutral' || tries++ > 20) { clearInterval(ping); return; } signal({ t: 'need-host' }); }, 800);
signal({ t: 'need-host' });
}
