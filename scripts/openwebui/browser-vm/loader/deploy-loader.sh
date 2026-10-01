#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Deploy the built static/loader.js into the running OpenWebUI container AND
# bust the browser/Cloudflare cache so the new loader is actually fetched.
#
# Why the cache-bust is mandatory: /app/build/index.html references the loader
# as `loader.js?v=<hash>` with a FIXED hash baked at container-build time. That
# URL is cached by both the browser and the Cloudflare edge, so a plain
# `docker cp` of a new loader is invisible — the page keeps loading the old one
# under the unchanged URL (this is exactly why several "deployed" fixes never
# reached the user). Bumping ?v= to the loader's content hash makes the URL a
# guaranteed cache miss at every layer.
#
# Caveat: index.html lives in the image layer (not a bind mount), so a
# `docker restart` reverts the ?v= bump. loader.js itself survives (it is
# bind-mounted from static/loader.js and re-copied into STATIC_DIR at boot),
# but re-run this script after any restart to re-bust the cache.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
loader="${here}/../../static/loader.js"
container="${1:-nemoclaw-openwebui}"
static_dir="/app/backend/open_webui/static/loader.js"
index_html="/app/build/index.html"

[[ -f "${loader}" ]] || { echo "error: ${loader} missing — run build.sh first" >&2; exit 1; }
docker inspect "${container}" >/dev/null 2>&1 || { echo "error: container ${container} not found" >&2; exit 1; }

ver="$(md5 -q "${loader}" 2>/dev/null | cut -c1-12 || md5sum "${loader}" | cut -c1-12)"

# 1. Copy the loader into STATIC_DIR (what the app serves). A cp into
#    /app/build/static fails "device or resource busy" — it is a live bind mount.
docker cp "${loader}" "${container}:${static_dir}"

# 2. Verify by copying back OUT (docker cp is authoritative; md5sum over exec can
#    be stale on Docker Desktop's bind-mount read path).
tmp="$(mktemp)"; trap 'rm -f "${tmp}"' EXIT
docker cp "${container}:${static_dir}" "${tmp}"
host_md5="$(md5 -q "${loader}" 2>/dev/null || md5sum "${loader}" | cut -d' ' -f1)"
served_md5="$(md5 -q "${tmp}" 2>/dev/null || md5sum "${tmp}" | cut -d' ' -f1)"
[[ "${host_md5}" == "${served_md5}" ]] || { echo "error: served digest ${served_md5} != host ${host_md5}" >&2; exit 1; }

# 3. Bump the ?v= in index.html to the loader hash so the new bytes are fetched.
docker exec "${container}" sh -c "
  sed -i -E 's#(loader\.js\?v=)[a-z0-9]+#\1${ver}#' '${index_html}'
  grep -n 'loader.js' '${index_html}'
"

echo "deployed loader ${host_md5} to ${container}; index.html now loads loader.js?v=${ver}"
echo "tell the browser to reload (a normal reload is enough now: the ?v= changed)."
