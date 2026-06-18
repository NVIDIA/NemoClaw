# Brev Environment Reference

How to deploy VSS on a Brev GPU instance so the UI and API are reachable
from a browser via Brev **secure links** (a Cloudflare-fronted reverse proxy).

This reference derives from `deploy/docker/scripts/deploy_vss_launchable.ipynb`, which is the
interactive reference implementation.

## When this applies

A Brev-managed instance sets `BREV_ENV_ID=<instance-id>` in `/etc/environment`.
If that file doesn't contain `BREV_ENV_ID`, you're not on a Brev-provisioned
instance and this reference doesn't apply — use the normal host IP + port
access pattern from `base.md`.

## Architecture

```
Browser  ──https──>  7777-<BREV_ENV_ID>.brevlab.com  (Cloudflare Access)
                             │
                             ▼
                   Brev network tunnel
                             │
                             ▼
              vss-haproxy-ingress :7777 on the instance
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
        UI :3000      Agent API :8000     VST :30888
```

## Secure-link URL format

```
https://7777-<BREV_ENV_ID>.brevlab.com
```

- `<BREV_ENV_ID>` is the instance's ID from `/etc/environment`.
- `7777` is the haproxy ingress port that VSS exposes on the instance — Brev's secure-link domain just prefixes it. (Older Brev launchables used to add a trailing `0` giving `77770-...`; that's gone in current Brev, but if you inherit an older instance and find a `77770-...` link still works, see [Troubleshooting](#troubleshooting).)

## Per-profile secure link requirements

| Profile | Required links | Optional |
|---|---|---|
| `base` | **7777** (nginx proxy — UI + Agent + VST) | 6006 (Phoenix tracing) |
| `lvs` | **7777**, **5601** (Kibana) | 6006 |
| `search` | **7777**, **5601**, **31000** (nvstreamer) | 6006 |
| `alerts` | **7777**, **5601**, **31000** (nvstreamer) | 6006 |

Ports that should NOT get their own secure link (they're behind the nginx proxy):
3000 (UI), 8000 (Agent), 30888 (VST).

## Setup flow

Before `docker compose up`, set the Brev secure-link overrides in the profile
`generated.env` (the skill's per-deploy working copy — see ``SKILL.md`` (see
`../SKILL.md`) Step 1c/1d). **`EXTERNAL_IP` alone is not enough** — the Brev secure
link is served over **HTTPS on 443**, but the profile `.env` ships
`VSS_PUBLIC_HTTP_PROTOCOL=http`, `VSS_PUBLIC_WS_PROTOCOL=ws`, and
`VSS_PUBLIC_PORT=${HAPROXY_PORT}` (7777). Leaving those at the defaults makes the
agent emit `http://…:7777` UI/API/WS URLs from an `https://` page → the browser
blocks them as mixed content. Set the host, protocol, and port together:

```bash
brev_env_id=$(awk -F= '/^BREV_ENV_ID=/ {gsub(/"/, "", $2); print $2; exit}' /etc/environment)
GEN=deploy/docker/developer-profiles/dev-profile-<profile>/generated.env
host="7777-${brev_env_id}.brevlab.com"
sed -i \
  -e "s|^EXTERNAL_IP=.*|EXTERNAL_IP=${host}|" \
  -e "s|^VSS_PUBLIC_HOST=.*|VSS_PUBLIC_HOST=${host}|" \
  -e "s|^VSS_PUBLIC_HTTP_PROTOCOL=.*|VSS_PUBLIC_HTTP_PROTOCOL=https|" \
  -e "s|^VSS_PUBLIC_WS_PROTOCOL=.*|VSS_PUBLIC_WS_PROTOCOL=wss|" \
  -e "s|^VSS_PUBLIC_PORT=.*|VSS_PUBLIC_PORT=443|" \
  "$GEN"
```

## Verifying the deploy is reachable externally

After `docker compose up -d`:

```bash
# 1. Nginx proxy is up and routing
curl -sf http://localhost:7777/health >/dev/null && echo "proxy OK"

# 2. UI reachable through the proxy (internally)
curl -sfI http://localhost:7777/ | head -1

# 3. Print the browser URL the user should open
brev_env_id=$(awk -F= '/^BREV_ENV_ID=/ {gsub(/"/, "", $2); print $2; exit}' /etc/environment)
echo "https://7777-${brev_env_id}.brevlab.com"
```

If step 1 fails, the haproxy container (`vss-haproxy-ingress`) hasn't come up — check
`docker logs vss-haproxy-ingress`. Common reason: another service on the host is
already bound to port 7777, or `EXTERNAL_IP` in the profile `.env` doesn't
match the secure-link domain (haproxy's `known_host` ACL rejects the
request as 404 from the browser even though `curl localhost:7777` works).

## Troubleshooting

| Symptom | Cause |
|---|---|
| User says the Brev link won't load at all | Ask how the secure link was exposed. The skill's default assumes the current Brev secure-link convention: `7777-<id>.brevlab.com` (no trailing `0`). An older inherited launchable may still serve `77770-<id>.brevlab.com` (legacy trailing-`0` form), or a manually-created link may use a different port entirely — in that case set `EXTERNAL_IP` to whatever the actual secure-link domain is and redeploy. |
| UI loads but AJAX calls to `/api/*` CORS-fail | A second secure link was created for port 8000 → browser treats it as a different origin. Delete the extra link; the UI should use the proxy only. |
| `curl https://7777-...brevlab.com` → 502 | nginx container (`vss-haproxy-ingress`) is down — `docker logs vss-haproxy-ingress` |
| `curl https://7777-...brevlab.com` → Cloudflare Access login page forever | User hasn't been granted access in the Brev org; not a deploy issue |
| Agent-generated report URLs don't open | `EXTERNAL_IP` in the profile `generated.env` is still the internal `${HOST_IP}` default → reports hard-code internal IPs. Set `EXTERNAL_IP=7777-${BREV_ENV_ID}.brevlab.com` in the profile `generated.env` (see [Setup flow](#setup-flow)) and redeploy. |
