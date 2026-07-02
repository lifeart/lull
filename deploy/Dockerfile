# Build the hub image with its deps installed FOR THE TARGET ARCH (never bind-mount host
# node_modules — that would be the dev machine's arch and can fail to load). (finding: deploy)
FROM node:20-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN node pipeline/bake.js \
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
