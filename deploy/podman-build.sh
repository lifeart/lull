#!/usr/bin/env bash
# Build the Lull hub image with Podman and produce a Synology-ready docker-archive
# whose image name has NO `localhost/` prefix.
#
# WHY THIS EXISTS ────────────────────────────────────────────────────────────────
# `podman build -t lull-hub` stores the image as `localhost/lull-hub` — Podman
# prefixes every short, locally-built name with the `localhost/` registry. That
# prefix travels inside `podman save`, so after you `docker load` the tarball on the
# Synology the image is `localhost/lull-hub:latest`, and a Container-Manager /
# compose reference of `image: lull-hub:latest` silently fails to match (it then
# tries to PULL `docker.io/library/lull-hub` and errors). This script strips the
# `localhost/` prefix from the saved archive so it lands on the NAS as a clean, bare
# `lull-hub:latest` that the compose file references directly.
#
# CROSS-ARCH ─────────────────────────────────────────────────────────────────────
# Most Synology models that run Container Manager are x86_64, so we default to
# `--platform linux/amd64`. If you build on an Apple-Silicon / ARM machine this uses
# QEMU emulation inside the podman machine (slower, but correct). For an ARM Synology
# (e.g. some j/value models) pass `--platform linux/arm64`. Building the wrong arch
# is the classic "works on my laptop, exits 1 on the NAS" trap — the Dockerfile bakes
# deps for the target arch precisely so this stays honest.
#
# USAGE ──────────────────────────────────────────────────────────────────────────
#   deploy/podman-build.sh                              # linux/amd64 → deploy/lull-hub.tar
#   deploy/podman-build.sh --platform linux/arm64       # for an ARM Synology
#   deploy/podman-build.sh --tag v1 --output /tmp/x.tar
#   deploy/podman-build.sh --load                       # also load into local docker (to test)
#   deploy/podman-build.sh --no-bake                    # skip the native host bake (assets already fresh)
#
# It bakes the audio loops NATIVELY on the host first (the synthesis DSP miscompiles under CPU
# emulation, so an in-image amd64 bake on an Apple-Silicon host would ship corrupt loops) and copies
# those arch-independent .wav files into the image.
#
# Then on the NAS (Container Manager → or SSH):
#   docker load -i lull-hub.tar
#   docker compose -f deploy/docker-compose.synology.yml up -d
set -euo pipefail

# ── Resolve repo root (this script lives in deploy/) so it runs from anywhere ─────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Defaults (override via flags or env) ──────────────────────────────────────────
IMAGE="${IMAGE:-lull-hub}"
TAG="${TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
OUTPUT="${OUTPUT:-$REPO_ROOT/deploy/${IMAGE}.tar}"
DO_LOAD=0
SKIP_BAKE=0
NO_CACHE=0

usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --image)    IMAGE="$2"; shift 2 ;;
    --tag)      TAG="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --output|-o) OUTPUT="$2"; shift 2 ;;
    --load)     DO_LOAD=1; shift ;;
    --no-bake)  SKIP_BAKE=1; shift ;;
    --no-cache) NO_CACHE=1; shift ;;
    -h|--help)  usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

REF="${IMAGE}:${TAG}"                 # the clean name we WANT (e.g. lull-hub:latest)
LOCAL_REF="localhost/${IMAGE}:${TAG}" # what Podman actually stores it as

# ── Preflight: podman present and its machine reachable ───────────────────────────
command -v podman >/dev/null 2>&1 || { echo "✗ podman not found on PATH." >&2; exit 1; }
if ! podman info >/dev/null 2>&1; then
  echo "✗ podman can't reach its engine." >&2
  echo "  On macOS/Windows start the VM first:  podman machine start" >&2
  exit 1
fi

# ── Bake the audio loops NATIVELY on the host, BEFORE the (possibly emulated) image build ─────────
# The synthesis DSP miscompiles under CPU emulation: building a linux/amd64 image on an Apple-Silicon
# host runs the in-image `node pipeline/bake.js` under Rosetta, which corrupts the loops (clipping /
# near-silence / DC steps) — recordings survive only because they're pre-made files. A .wav is
# arch-independent, so we bake here on the native host (correct, and self-validated: bake.js throws
# on a bad loop) and the Dockerfile copies these in instead of re-baking under emulation.
# Skip with --no-bake if you've already baked natively. (finding: emulated-bake corruption)
if [ "$SKIP_BAKE" -ne 1 ]; then
  command -v node >/dev/null 2>&1 || { echo "✗ node not found on PATH (needed to bake loops natively)." >&2; exit 1; }
  echo "▶ Baking loops natively on the host ($(uname -m)) — arch-independent audio"
  node "$REPO_ROOT/pipeline/bake.js"
fi

echo "▶ Building $REF  (platform: $PLATFORM)"
echo "  context: $REPO_ROOT   dockerfile: deploy/Dockerfile"

# ── Build. -t sets the SHORT name; Podman stores it as localhost/$IMAGE:$TAG ───────
# --format docker is REQUIRED: Podman defaults to the OCI image format, which does NOT
# support HEALTHCHECK and silently drops the Dockerfile's — the compose file + Container
# Manager rely on /healthz health, so we build in Docker (v2s2) format to keep it.
BUILD_ARGS=(--format docker --platform "$PLATFORM" --build-arg "CACHEBUST=$(date +%s)" -t "$REF" -f "$REPO_ROOT/deploy/Dockerfile")
[ "$NO_CACHE" -eq 1 ] && BUILD_ARGS+=(--no-cache)
podman build "${BUILD_ARGS[@]}" "$REPO_ROOT"

# Podman normalizes the short tag to localhost/… — confirm which ref actually exists
# (belt-and-suspenders: also accept the bare form in case a future Podman changes this).
if podman image exists "$LOCAL_REF"; then
  SRC_REF="$LOCAL_REF"
elif podman image exists "$REF"; then
  SRC_REF="$REF"
else
  echo "✗ Built image not found as '$LOCAL_REF' or '$REF'." >&2; exit 1
fi
echo "✓ Built (stored by podman as: $SRC_REF)"

# ── Save to a docker-archive with the localhost/ prefix STRIPPED from RepoTags ────
mkdir -p "$(dirname "$OUTPUT")"

if command -v skopeo >/dev/null 2>&1; then
  # Cleanest path: skopeo lets us name the destination RepoTag directly (no prefix).
  echo "▶ Saving via skopeo → $OUTPUT  (RepoTag: $REF)"
  skopeo copy --quiet \
    "containers-storage:$SRC_REF" \
    "docker-archive:$OUTPUT:$REF"
else
  # Fallback: save the archive, then rewrite manifest.json/repositories to drop the
  # localhost/ prefix. Portable (Python's tarfile — no fragile `tar --delete`, works
  # on macOS + Linux) and streams the (large) layer members through untouched.
  command -v python3 >/dev/null 2>&1 || {
    echo "✗ Need either 'skopeo' or 'python3' to strip the localhost/ prefix." >&2
    echo "  Install one, or run:  docker load then 'docker tag $LOCAL_REF $REF' on the NAS." >&2
    exit 1
  }
  TMP_TAR="${OUTPUT}.podman.tmp"
  echo "▶ Saving via podman → docker-archive, then stripping 'localhost/' from RepoTags"
  podman save --format docker-archive -o "$TMP_TAR" "$SRC_REF"
  IN="$TMP_TAR" OUT="$OUTPUT" STRIP="localhost/" python3 - <<'PY'
import io, os, json, tarfile
src, dst, strip = os.environ["IN"], os.environ["OUT"], os.environ["STRIP"]
def unprefix(t): return t[len(strip):] if t.startswith(strip) else t
with tarfile.open(src) as tin, tarfile.open(dst, "w") as tout:
    for m in tin.getmembers():
        if m.name in ("manifest.json", "repositories"):
            obj = json.loads(tin.extractfile(m).read())
            if m.name == "manifest.json":
                for e in obj:
                    e["RepoTags"] = [unprefix(t) for t in (e.get("RepoTags") or [])]
            else:  # legacy: { "localhost/lull-hub": {"latest": "<id>"} }
                obj = {unprefix(k): v for k, v in obj.items()}
            data = json.dumps(obj).encode()
            info = tarfile.TarInfo(m.name)
            info.size, info.mtime, info.mode = len(data), m.mtime, 0o644
            tout.addfile(info, io.BytesIO(data))
        else:
            tout.addfile(m, tin.extractfile(m) if m.isreg() else None)
PY
  rm -f "$TMP_TAR"
fi

# ── Verify the archive really is prefix-free before we claim success ──────────────
if command -v python3 >/dev/null 2>&1; then
  ARCHIVE="$OUTPUT" python3 - <<'PY'
import os, json, tarfile, sys
with tarfile.open(os.environ["ARCHIVE"]) as t:
    man = json.loads(t.extractfile("manifest.json").read())
tags = [tag for e in man for tag in (e.get("RepoTags") or [])]
bad = [x for x in tags if x.startswith("localhost/")]
print(f"  archive RepoTags: {tags}")
if bad:
    print(f"✗ still prefixed: {bad}", file=sys.stderr); sys.exit(1)
PY
fi

BYTES=$(wc -c < "$OUTPUT" | tr -d ' ')
echo "✓ Wrote $OUTPUT  (${BYTES} bytes)  image: $REF"

# ── Optional: load into the local docker so you can smoke-test before shipping ────
if [ "$DO_LOAD" -eq 1 ]; then
  if command -v docker >/dev/null 2>&1; then
    echo "▶ docker load -i $OUTPUT"
    docker load -i "$OUTPUT"
    echo "  Note: Docker Desktop (containerd store) DISPLAYS registry-less tags under"
    echo "  'localhost/…'; Synology's classic dockerd loads the bare '$REF'. The tarball is correct."
  else
    echo "  (--load skipped: docker not on PATH; the image is in podman storage as $SRC_REF)"
  fi
fi

cat <<EOF

Next — copy to the NAS and run:
  scp "$OUTPUT" admin@<nas-ip>:/volume1/docker/lull/
  # then on the NAS (SSH), or via Container Manager → Image → Import:
  docker load -i /volume1/docker/lull/$(basename "$OUTPUT")
  docker compose -f deploy/docker-compose.synology.yml up -d

The compose file references  image: $REF  — which now matches exactly (no localhost/ prefix).
EOF
