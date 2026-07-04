# Lull — Ambient Sound Library: Research Report + Integration Plan

> **Shipped (update):** the built-in library now includes **synthesized** ambient loops — rain, ocean,
> wind, fireplace, fan, womb, heartbeat — generated procedurally in `pipeline/bake.js` (zero deps, no
> license, fully offline). That satisfies "expand the library" with no download or legal step. The
> **download** path below (`npm run fetch:ambient`) is now optional, for real field recordings; for
> **personal/non-commercial use** its gate is relaxed (CC0/PD/BY/NC/SA all fine — only ND is refused —
> just don't commit downloaded audio to a public repo). The research below stands for that path.

> Output of a fan-out web-research pass with **adversarial per-source license verification**
> (83 sources found, 82 verified, 59 usable). Legal claims are cited but **AI-generated — do a
> final human license check on every file before shipping**, per §8. Prefer CC0/PD to keep the
> attribution burden near zero.

---

## 1. Executive recommendation

**Strategy: two-tier, CC0-first.**

- **Tier A — commit a small CC0/PD "core pack" in-repo (baked, iOS-ready).** For genuinely CC0 /
  public-domain files we are *legally allowed to redistribute*, committing the finished `.m4a`/`.mp3`
  loops is the most robust choice: no runtime network dependency, reproducible installs, and it
  matches how the repo already ships baked noise. CC0/PD explicitly permits hosting, transcoding,
  looping, and redistribution with no attribution. This is the primary deliverable.
- **Tier B — `pipeline/fetch-ambient.js` auto-downloads-once at first run, but ONLY from
  redistribution-clean *direct* hosts** — never the Freesound API. Clean hosts: CC0/permissive GitHub
  repos that already re-host verified files (`rafaelmardojai/blanket`, `Muges/ambientsounds`), FreePD
  (via the `0lhi/FreePD` CC0 mirror), OpenGameArt CC0 assets, archive.org direct-download (CC0/PD-Mark
  only), Wikimedia Commons (CC0/PD only). Redistribution comes purely from the per-file CC license.

**Do NOT wire the Freesound API into install-time fetch.** The Freesound **API** Terms of Use are the
single biggest trap: the free tier is *non-commercial only*, §4(a) forbids "distributing… Content from
any location or source other than your Application," §4(f) bans scraping/similar databases, §1(b)
requires intermediate copies be deleted — so *auto-download-via-API-then-serve-from-our-hub violates
the ToS even for CC0 files*. The lawful way to use a specific Freesound CC0/CC-BY file: a human
downloads it once from the website (the web ToS defers to the per-sound CC license, no re-hosting
restriction), verifies the `license` field on the sound page, and we vendor it into Tier A. The
redistribution right then comes from the file's irrevocable CC0/CC-BY grant, not from UPF.

**Focus downloads on NATURE/AMBIENCE + baby sounds.** We already synthesize white/pink/brown in
`bake.js` (equal-power crossfade, PCM16 WAV, zero external tools) — keep doing so. Keep womb + heartbeat
*synthesized* too (cleaner than the medium-quality Doppler clips; the `libHeartbeat`/`bencholmes` CC0
algorithms confirm the approach is unencumbered). Downloads add what we can't cheaply synthesize:
**rain, ocean, forest/night, fireplace, stream, wind**, plus **1–2 PD lullabies**.

---

## 2. Verified source table

Legend: R=redistributable, C=commercial-OK, M=modify/loop-OK, A=attribution-required.

### USE — redistribution-clean, directly fetchable (Tier B) or committable (Tier A)

| Source | License | R | C | M | A | Conf. | Method | Recommendation |
|---|---|---|---|---|---|---|---|---|
| **`rafaelmardojai/blanket`** (GitHub) | Per-file CC0 / CC-BY / PD (SoundBible); no NC/ND | yes | yes | yes | mixed | high | GitHub raw @ pinned SHA | **bundle-in-repo** — best single direct source; CC0+PD subset needs no attribution |
| **`Muges/ambientsounds`** (GitHub) | 2× CC0 + 4× CC-BY 4.0 | yes | yes | yes | yes (BY) | high | GitHub raw @ pinned SHA | **bundle-in-repo** — CC0 fireplace/wind free; rain/forest/stream/thunder need credit |
| **FreePD** via `0lhi/FreePD` mirror | CC0 1.0 (whole catalog) | yes | yes | yes | no | high | GitHub raw @ pinned SHA (origin site offline) | **bundle-in-repo** — PD lullaby/calm beds; verify hashes |
| **OpenGameArt (CC0)** e.g. Ylmir "Rain (loopable)", "Fireplace Sound loop" | CC0 (per-asset) | yes | yes | yes | no | high | Static download; verify License box == CC0 per asset | **bundle-in-repo** |
| **archive.org — Teemu Hautala white/pink/brown** | CC PD Dedication (≡ CC0) | yes | yes | yes | no | high | Direct `archive.org/download/…` | bundle — but *redundant*, we already synth these |
| **archive.org Metadata/Search API** | Per-item; whitelist only | cond. | — | — | — | high | Public read, no key | fetch-at-install **with strict licenseurl whitelist** (CC0/PD-Mark/BY/BY-SA) + per-item `/metadata/{id}` recheck |
| **Wikimedia Commons (audio)** | Per-file CC0/PD/BY/BY-SA (NC/ND banned by policy) | yes | yes | yes | yes (BY) | high | MediaWiki `imageinfo&extmetadata` | bundle — filter to CC0/PD; **exclude BY-SA** |
| **Kenney.nl Audio** | CC0 1.0 | yes | yes | yes | no | high | Direct download | bundle — but almost no long-form ambience |
| **Freesound — specific CC0 IDs** (BonnyOrbit rain/water/fire; jmehlferber 370938; samarobryn 414767; felix.blume 511009; n8daly 31785) | CC0 1.0 (verified per-ID) | yes | yes | yes | no | high | **Human website download once → vendor**; verify `license` per ID | bundle-in-repo (NOT via API) |
| **Freesound — qubodup Rain Loop 212580** | CC-BY 3.0 | yes | yes | yes | **yes** | high | Human download; store credit | bundle only if you accept attribution |
| **incompetech / Kevin MacLeod** | CC-BY 4.0 | yes | yes | yes | **yes** | high | Direct download | optional lullaby/calm beds *with* mandatory credit |
| **`imec-int/heartbeat` + `bencholmes/heartbeat`** | CC0 (generated output) | yes | yes | yes | no | high | Generate WAV, don't vendor the Java utils | bundle synthesized output — womb/heartbeat |
| **`pipeline/bake.js` (our synth)** | Ours (PD-equivalent); Paul Kellett pink filter is PD | yes | yes | yes | no | high | Already in repo | keep for white/pink/brown + womb + fan drone |

### AVOID — the NC / ND / "free-but-no-redistribution" / ARR traps

| Source | Why avoid |
|---|---|
| **Freesound *API* as install-time fetch** | ToS §4(a)/(f)/§1(b): no re-hosting Content outside your Application, no scraping, delete intermediate copies; free tier non-commercial. Use website-download-once instead. |
| **Pixabay (audio)** | Content License bans "Standalone" redistribution of audio *even after looping/transcoding*; §8 bans bulk/automated copying and competing services. Post-2019-01-09 not CC0. Serving a loop library is exactly the prohibited case. |
| **Mixkit / Uppbeat / ZapSplat / Sonniss** | Proprietary "free" EULAs forbid standalone redistribution / "sound library" / "relaxation" use; ZapSplat & Sonniss name the sound-app/relaxation case explicitly. |
| **BBC Sound Effects (RemArc)** | Non-commercial personal/education only; no self-hosting; revocable takedown at any time. |
| **myNoise.net** | All rights reserved; downloading stems / resampling forbidden; *not* CC-BY. Design reference only. |
| **Musopen** | ToS bans mirroring/modify/commercial/mass-copy; no working CC0 filter; classical only. |
| **Free Music Archive** | ToS bans deep-linking to mp3s and automated fetch/data-mining; no public API. |
| **ccMixter** | Dominated by CC-BY-NC and paid ccPlus; not worth it here. |
| **Freesound CC-BY-NC items** (hansendex 263994 fireplace, 263995 ocean) | NonCommercial → poisons a commercial-safe library. |
| **archive.org Great 78 lullabies** | No licenseurl; recording copyright undetermined (*UMG v. Internet Archive*). Composition PD ≠ recording PD. |
| **radio aporee** | Heterogeneous; ~26% NC + ND blocks; PD-Mark only; BY-SA. High-effort per-item filtering. |

---

## 3. Curated starter pack (11 CC0/PD + 1 optional CC-BY)

All CC0/PD (zero attribution) except one optional item.

| # | Slot | id | Source & asset | License | Attribution | Fetch |
|---|---|---|---|---|---|---|
| 1 | Rain | `rain` | OpenGameArt "Rain (loopable)" by Ylmir | CC0 | none | OGA direct |
| 2 | Ocean | `ocean` | Freesound felix.blume CC0 ocean (verify ID) — vendored | CC0 | none | human download → repo |
| 3 | Forest/night | `night` | Blanket "Summer night" (SoundBible PD) | PD | none | GitHub raw `blanket@SHA` |
| 4 | Fireplace | `fire` | Freesound samarobryn 414767 (CC0) *or* OGA "Fireplace loop" (CC0) | CC0 | none | OGA / vendored |
| 5 | Stream | `stream` | Blanket "Stream" (CC0) | CC0 | none | GitHub raw `blanket@SHA` |
| 6 | Wind | `wind` | Muges wind = felix.blume 139337 (CC0) | CC0 | none | GitHub raw `ambientsounds@SHA` |
| 7 | Fan/brown drone | `fan` | **Synthesized** (bake.js brown + low-pass) | ours | none | generated |
| 8 | Womb | `womb` | **Synthesized** (bake.js low-pass pink + ~60–70 BPM pulse) | ours | none | generated |
| 9 | Heartbeat | `heartbeat` | **Synthesized** (bencholmes/imec CC0 algorithm) | CC0 (output ours) | none | generated |
| 10 | Lullaby #1 | `lullaby1` | FreePD gentle instrumental | CC0 | none | GitHub raw `0lhi/FreePD@SHA` + hash |
| 11 | Lullaby #2 | `lullaby2` | FreePD second calm track | CC0 | none | GitHub raw `0lhi/FreePD@SHA` + hash |
| 12* | Thunderstorm (optional) | `storm` | Muges thunderstorm = RHumphries 2523 (CC-BY 4.0) | CC-BY | **required** | GitHub raw `ambientsounds@SHA` |

Items 1–11 need **no credits screen**. Freesound licenses are **per upload, not per user** — e.g.
qubodup Rain 212580 is CC-BY not CC0 — so `fetch-ambient.js` must verify each vendored file's recorded
license before baking.

---

## 4. Auto-download-once design (`pipeline/fetch-ambient.js`)

**Where files live**
- Curation manifest (committed): `pipeline/ambient-sources.json` (per-item spec).
- Download cache: `data/library/_cache/` (gitignored).
- Baked, iOS-ready output: `web/player/assets/ambient/<id>.m4a` (+ `.mp3` fallback), alongside the
  existing baked noise so `hub/server.js:libraryJson()` picks it up unchanged (it just reads
  `m.soundscapes`).
- Ambient manifest: extend the existing `web/player/assets/manifest.json` the baker already writes.
- Credits (committed): `web/player/assets/CREDITS.json` for any CC-BY item.

**`ambient-sources.json` (per item)**
```json
{ "id": "stream", "label": "Gentle stream", "category": "water",
  "url": "https://raw.githubusercontent.com/rafaelmardojai/blanket/<SHA>/…/stream.ogg",
  "sha256": "<pinned hash>", "license": "CC0-1.0", "attribution": null,
  "sourceUrl": "https://freesound.org/…", "loopSec": 60, "crossfadeSec": 2.0 }
```
`sha256` is load-bearing twice: **integrity** (a mirror swapping a file, or a takedown-replacement,
fails the hash and is discarded) and **provenance** (proves the byte-for-byte file we cleared shipped).

**Idempotent fetch → normalize → loop → transcode → manifest**
```
for each item:
  target = web/player/assets/ambient/<id>.m4a
  if exists(target) and recordedHash(id) == item.sha256: continue    # already done
  buf = download(item.url)
  if sha256(buf) != item.sha256: log+skip                            # integrity/license guard
  if license contains NC|ND|SA: throw                                # defensive allowlist
  norm = loudnorm(decode(buf), -23 LUFS, TP -1.5 dBTP)               # EBU R128, BEFORE crossfade
  loop = seamlessLoop(norm, loopSec, crossfadeSec)                   # reuse bake.js equal-power sqrt curve
  writeM4A + writeMP3; upsertManifest; if attribution: upsertCredits; recordHash
```

**Decode/transcode dependency — honest tradeoff.** `bake.js` is zero-tool but only *generates* PCM; it
can't decode mp3/ogg. Options:
1. **Recommended:** run `fetch-ambient.js` at *curation/build* time on a machine with ffmpeg and
   **commit the finished CC0/PD `.m4a`/`.mp3`** (Tier A). Running ffmpeg doesn't taint output audio.
   License-clean, network-free installs — best fit for a child's-room appliance.
2. **First-run fallback (Tier B):** run at hub first-run; require ffmpeg only for the ambient path;
   **if ffmpeg is absent, skip ambient and keep the synthesized noise library fully working.** Never
   block hub start on it.

Keep `seamlessLoop()`'s equal-power `sqrt(t)/sqrt(1-t)` crossfade (= FFmpeg `acrossfade=curve1=qsin`,
avoids the ~3 dB linear dip). For ocean, align the crossfade window to a wave trough.

**Network-failure handling:** per-item, best-effort, **never fatal**; a failure logs and the item just
doesn't appear that boot; retry next start (idempotent). Hub startup must not await ambient fetch.
Surface fetched counts/misses in `/api/health` (no silent swallowing).

**Commit-to-git vs fetch-on-demand:** **commit** the Tier A CC0/PD baked loops (lawful; removes runtime
risk — FreePD's origin is offline, archive.org items can be taken down). **Never commit** BY-SA/NC/ND.
Fetch-on-demand only from the clean direct hosts, never the Freesound API. Ship `CREDITS.json` rendered
on a controller "Licenses" screen for every CC-BY item.

---

## 5. Favorites design

**Favorites are a hub-synced flag, not controller-local** — because the existing display `order` is
already hub-synced (persisted in `uploads/index.json`, broadcast via `MSG.LIBRARY`, converges across
both parents' controllers). Favs are the same class of shared preference; controller-local would
diverge and violate the single-source-of-truth seam rule. A fav applies to **any** soundscape id
(baked, synth, or upload), keyed by id like `order`.

**Storage — extend `hub/uploads.js`** (`index.json` becomes `{ items, order, favs }`):
```js
// constructor: this.favs = [];   _load(): this.favs = raw.favs || [];
// _persist(): JSON.stringify({ items:this.index, order:this.order, favs:this.favs }, null, 2)
getFavs() { return this.favs.slice(); }
async setFav(id, on) { const s=new Set(this.favs); on?s.add(String(id)):s.delete(String(id)); this.favs=[...s]; await this._persist(); }
// remove(id): also this.favs = this.favs.filter((x) => x !== id);
```

**Library payload + sort — `hub/server.js:libraryJson()`** (pin favs first, then existing order rank):
```js
const favSet = new Set(uploads.getFavs());
for (const s of out) s.fav = favSet.has(s.id);
const rank = new Map(uploads.getOrder().map((id, i) => [id, i]));
out.sort((a, b) => a.fav !== b.fav ? (a.fav ? -1 : 1)
  : (rank.has(a.id)?rank.get(a.id):Infinity) - (rank.has(b.id)?rank.get(b.id):Infinity));
```

**API — mirror `/api/library/order` exactly** (same `authApi` gate, same `broadcastLibrary()`):
```js
if (p === '/api/library/fav' && req.method === 'POST') { await handleFav(req, res); return; }
async function handleFav(req, res) {
  if (!authApi(req, res)) return;
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id'); const on = q.get('on') !== '0';
  if (!id) { res.writeHead(400).end('missing id'); return; }
  await uploads.setFav(id, on);
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
  hub.broadcastLibrary();   // existing {t: MSG.LIBRARY} → clients refetch /api/library
}
```
**No new protocol message** — reuse `MSG.LIBRARY`; the `fav` boolean rides the existing `/api/library`
payload, so `shared/protocol.js` and the seam test stay untouched.

**Controller UI — `web/controller/controller.js`:** map `fav: !!s.fav` in `refreshLibrary()`; add a star
toggle in `libraryRow(s)` that POSTs `/api/library/fav?id=…&on=…` and resyncs on failure (same pattern
as reorder). Favorites already sort first server-side; reuse the `libraryBusy`/`flushLibraryRefresh`
deferral so a toggle mid-drag doesn't rebuild the list.

---

## 6. Formats, looping & loudness

- **Codecs:** primary **HE-AAC `.m4a`** (Apple's preferred HTML5 audio codec), **MP3 128 kbps CBR**
  fallback for LEGACY, **WAV** for on-the-fly synthesized noise (as today). Skip Opus/CAF (Safari 18.4+).
- **Bitrate:** ambience is forgiving → HE-AAC ~64–80 kbps transparent; MP3 128 fallback.
- **Duration:** 30–120 s; **60–90 s** for nature (hides loop recurrence). Noise stays ~30 s.
- **Looping:** reuse `bake.js seamlessLoop()` equal-power crossfade, 1–2 s window at zero-crossings; for
  ocean, place the seam in a wave trough.
- **Loudness:** EBU R128 two-pass `loudnorm`, target **~-23 LUFS** (deliberately quiet for a sleeping
  infant), TP -1.5 dBTP, applied **before** crossfade. Normalize *every* item (incl. synth noise) to the
  same target so switching soundscapes never jumps level. This is *digital* normalization — it cannot
  guarantee acoustic SPL at the crib (§7).

---

## 7. Safety (infant sound-machine SPL)

Grounded in **Hugh SC et al., "Infant Sleep Machines and Hazardous Sound Pressure Levels," *Pediatrics*
2014;133(4):677–681, DOI:10.1542/peds.2013-3617** (paywalled/ARR — cite/paraphrase facts, don't copy
text). Findings: all 14 machines exceeded 50 dBA at 30 cm; **3 exceeded 85 dBA** at 30 cm. Lay guidance
(AAP-aligned): keep volume **below ~50 dB**, place the machine **≥ ~2 ft / 60 cm** from the crib, and
**turn it off once the baby is asleep**.

Bake into the product:
1. **Low default, never max** — keep `GAIN_DEFAULT = 0.3` / `GAIN_SOFT_CAP = 0.6`; do not raise the cap.
2. **On-screen placement warning** (controller + player): "Place the device ≥ 2 ft (60 cm) from the crib
   and keep the volume low."
3. **Honest SPL disclaimer** — digital gain is not a decibel meter; start low.
4. **Auto-off timer on by default** — reuse the hub-owned sleep timer; default a bedtime duration.
5. Cite Hugh et al. 2014 (DOI 10.1542/peds.2013-3617); do not reproduce the paper.

---

## 8. Risks & open questions (human check before shipping)

- **Freesound API is non-commercial + no-rehost.** Resolved by design: never fetch from the API at
  install; website-download-once for specific IDs, direct CC0 hosts otherwise. If Lull ever
  ships commercially, license the API from UPF (`mtg@upf.edu`) or ensure every Freesound file was
  obtained/redistributed purely under its CC0/CC-BY grant.
- **Per-item license variance (#1 trap).** Freesound licenses are per-upload; the CC0 tag is
  user-applied and occasionally wrong. Verify each vendored file's recorded license; reject anything not
  matching `creativecommons.org/publicdomain/zero/1.0/` (or an accepted CC-BY). Landmines: qubodup
  212580 (CC-BY), CC-BY-NC 263994/263995.
- **GitHub repos have no root LICENSE for audio** — rests on the per-file Freesound/SoundBible licenses.
  Pin a commit SHA + store each file's own license/hash in `ambient-sources.json`.
- **FreePD origin offline** — only mirrors remain; CC0 is irrevocable but pin a mirror commit + hash.
- **PD-Mark ≠ CC0** (a label, not a waiver; weaker for recent recordings). Prefer CC0.
- **Hard-exclude BY-SA / ND / NC** in the ingest filter (BY-SA is viral; ND forbids looping; NC forbids
  commercial), plus a defensive reject-on-NC/ND/SA net.
- **Human license check required before shipping** any file: confirm license at source, provenance
  spot-check for user-upload sources, finalize CC-BY wording in `CREDITS.json`.
- **Womb/heartbeat synthesis DSP is unwritten** — budget time to tune a convincing low-pass-pink +
  ~60–70 BPM pulse.
- **Repo has no LICENSE file / `private:true`** — resolve before any public/commercial distribution.

**Files this plan touches:** `pipeline/bake.js`, `pipeline/fetch-ambient.js` (new),
`pipeline/ambient-sources.json` (new), `hub/uploads.js`, `hub/server.js` (`libraryJson`, new
`handleFav`, route table), `web/controller/controller.js`, `web/player/assets/manifest.json` +
`CREDITS.json` (new). **No change to `shared/protocol.js`** — favorites reuse the existing `MSG.LIBRARY`
broadcast.
