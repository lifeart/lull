# Build the hub image with its deps installed FOR THE TARGET ARCH (never bind-mount host
# node_modules — that would be the dev machine's arch and can fail to load). (finding: deploy)
FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# CACHEBUST busts the layer cache from here down on every build (podman-build.sh passes a fresh value)
# WITHOUT re-running the npm ci above. Without it, podman can reuse a stale COPY layer and silently
# ship OLD app code — a deploy that "changes nothing". (finding: stale COPY layer)
ARG CACHEBUST=0
RUN echo "cachebust=${CACHEBUST}" > /tmp/.cachebust
COPY . .
# Prefer loops baked NATIVELY on the host (deploy/podman-build.sh does this). The DSP miscompiles
# under CPU emulation (baking a linux/amd64 image on an Apple-Silicon host runs bake under Rosetta),
# shipping clipping/silent/DC loops. A .wav is arch-independent, so we bake on the host and copy the
# result in; bake.js also self-validates (throws) so a corrupt in-image fallback bake fails the build
# loudly instead of shipping garbage. (finding: emulated-bake corruption)
RUN if [ -f web/player/assets/manifest.json ] && [ -f web/player/assets/pink.wav ]; then \
      echo "[docker] using pre-baked (host-native) audio assets"; \
    else \
      echo "[docker] no pre-baked assets found — baking in-image (must NOT be under emulation)"; \
      node pipeline/bake.js; \
    fi \
 && mkdir -p /data \
 && chown -R node:node /app /data \
 && chmod +x deploy/entrypoint.sh

# The entrypoint starts as root, fixes /data ownership for the `node` user (so a pre-existing
# root-owned volume from an older deploy stays writable across the upgrade), then drops privileges
# and execs the hub as `node` — the app itself never runs as root. (review finding #4 / finding #17)
ENTRYPOINT ["/app/deploy/entrypoint.sh"]

EXPOSE 8080

# Let the orchestrator restart a hung-but-alive hub. /healthz returns 503 if state persistence has
# started failing, so an unwritable /data can't masquerade as healthy either. (finding: healthcheck)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "hub/server.js"]
