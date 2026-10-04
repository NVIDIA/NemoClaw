#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Premium-grant bridge: pull paid/invited premium emails from the supachad-landing
# Worker and merge them into CHAD_OPERATOR_ALLOWLIST in the HOST credentials.json,
# then run `chad-ops gate-sync` (which pushes host -> pod and restarts the shim).
#
# The Worker records KV `premium:<email>` for every Stripe checkout and every
# `premium` invite redemption; `GET /api/premium/list` (X-Admin-Secret) returns them.
# The shim gate reads CHAD_OPERATOR_ALLOWLIST, so this is the one bridge that turns a
# paid signup into premium `chad` model access. Idempotent: merge is set-union, and
# gate-sync is itself idempotent. Wire as a host cron (e.g. every 15 min).
#
# Env / config (from the host creds file unless overridden):
#   PREMIUM_LIST_URL   e.g. https://supachad.com/api/premium/list   (required)
#   PREMIUM_ADMIN_SECRET  the Worker's ADMIN_SECRET                 (required)
#   CHAD_HOST_CREDS    path to host credentials.json (default ~/.nemoclaw/credentials.json)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_CREDS="${CHAD_HOST_CREDS:-${HOME}/.nemoclaw/credentials.json}"
CHAD_OPS="${CHAD_OPS_BIN:-${here}/../chad-ops.sh}"

[ -f "$HOST_CREDS" ] || { echo "error: $HOST_CREDS not found" >&2; exit 1; }

# Pull URL + secret from env, else from the creds file.
URL="${PREMIUM_LIST_URL:-$(python3 -c "import json;print(json.load(open('$HOST_CREDS')).get('PREMIUM_LIST_URL',''))" 2>/dev/null || true)}"
SECRET="${PREMIUM_ADMIN_SECRET:-$(python3 -c "import json;print(json.load(open('$HOST_CREDS')).get('PREMIUM_ADMIN_SECRET',''))" 2>/dev/null || true)}"
[ -n "$URL" ] && [ -n "$SECRET" ] || { echo "error: set PREMIUM_LIST_URL + PREMIUM_ADMIN_SECRET (env or $HOST_CREDS)" >&2; exit 1; }

echo "[premium-sync] fetching $URL"
resp="$(curl -fsS -H "X-Admin-Secret: $SECRET" "$URL" 2>/dev/null || true)"
[ -n "$resp" ] || { echo "error: empty/failed response from Worker" >&2; exit 1; }

# Merge the Worker's premium emails into CHAD_OPERATOR_ALLOWLIST (set union, lowercased).
# Writes atomically and reports whether anything changed. RESP is passed via env.
changed="$(RESP="$resp" python3 - "$HOST_CREDS" <<'PY'
import json, sys, os, tempfile
creds_path = sys.argv[1]
resp = json.loads(os.environ["RESP"])
if not resp.get("ok"):
    print("error: Worker returned not-ok: %s" % resp.get("error"), file=sys.stderr); sys.exit(2)
new = {e.strip().lower() for e in resp.get("emails", []) if e and "@" in e}
creds = json.load(open(creds_path))
cur = creds.get("CHAD_OPERATOR_ALLOWLIST", [])
cur = cur if isinstance(cur, list) else [x.strip() for x in str(cur).split(",") if x.strip()]
cur_set = {x.strip().lower() for x in cur}
merged = sorted(cur_set | new)
if merged == sorted(cur_set):
    print("NOCHANGE"); sys.exit(0)
creds["CHAD_OPERATOR_ALLOWLIST"] = merged
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(creds_path))
with os.fdopen(fd, "w") as f:
    json.dump(creds, f, indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, creds_path)
print("CHANGED added=%d total=%d" % (len(new - cur_set), len(merged)))
PY
)"

echo "[premium-sync] $changed"
case "$changed" in
  CHANGED*) echo "[premium-sync] allowlist grew — running gate-sync"; "$CHAD_OPS" gate-sync ;;
  NOCHANGE) echo "[premium-sync] nothing to do" ;;
  *)        echo "[premium-sync] merge step failed" >&2; exit 1 ;;
esac
