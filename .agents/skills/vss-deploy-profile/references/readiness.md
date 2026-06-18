# Deploy Readiness Gate

`docker compose up -d` returns when containers are *created*, not when
the processes inside have finished initialising. Cold deploys
(first-time NIM image pulls, model warmup, vLLM CUDA-graph capture)
can legitimately take 10–20 min. Use this gate before declaring a
deploy "done".

## Step 1 — wait for the compose project to settle

**Gate 0 first — confirm a non-zero, expected container count and healthy
container states together.** A state-only `ps --format json | jq ...` filter
passes *vacuously* when no services started (the missing `--env-file` / unset
`COMPOSE_PROFILES` failure mode — `up -d` exits 0 with "no service selected"),
so keep the count guard in the same snippet as the state guard:

```bash
expected=$(docker compose --env-file "$ENV_GEN" -f resolved.yml config --services | wc -l)
actual=$(docker compose -f resolved.yml ps -q | wc -l)
if [ "$expected" -le 0 ] || [ "$actual" -le 0 ] || [ "$actual" -lt "$expected" ]; then
  echo "FAIL: expected $expected services, got $actual — re-check Step 5 --env-file" >&2
  exit 1
fi

# docker compose 2.21+ emits NDJSON (one bare object per line) from
# `ps --format json`, not a JSON array — so no `.[]` here; jq's default
# input loop already iterates each line. The filter accepts only
# `running` and `exited 0`; everything else (restarting, unhealthy,
# exited with non-zero code) is a failure.
mapfile -t bad < <(
  docker compose -f resolved.yml ps --format json \
    | jq -r 'select((.State == "running" or (.State == "exited" and .ExitCode == 0)) | not)
             | "\(.Name)\t\(.State)\texit=\(.ExitCode // "?")\t\(.Status)"'
)
if [ "${#bad[@]}" -gt 0 ]; then
  printf 'FAIL: %s\n' "${bad[@]}" >&2
  exit 1
fi
```

Every container must be either `running` or cleanly `exited 0`. One-shot init
jobs (e.g. `vss-kibana-init`) legitimately exit 0 and stay exited, which is
fine. Anything `restarting`, `unhealthy`, or `exited <N≠0>` is a deploy
failure even though `up -d` returned 0.

## Step 2 — probe the profile's documented readiness endpoints

Container state alone isn't enough — the processes inside may still be
importing modules, loading models, and binding ports. Each profile reference
(`base.md`, `lvs-profile.md`, `alerts.md`, `warehouse.md`, …) lists the
endpoints that must be reachable for that profile (agent REST API, UI,
inference NIMs, etc., on the ports the profile actually opens). Run those
`curl` checks with a generous deadline (15 min is reasonable for cold NIM
warmup) and only declare the deploy done once every documented endpoint
returns the expected success exit code.

**Cross-profile gate — the VSS Agent must answer on `:8000/health`.** Every
profile runs the agent, so this probe is required regardless of profile. A
`running` agent container does not mean the NAT-serve process is listening —
it can be up while `:8000` never bound (config error, unreachable model
endpoint), and Step 1 would still pass:

```bash
curl -sf --max-time 15 http://localhost:8000/health >/dev/null && echo "agent OK"
```

## Step 3 — triage slow containers

If any probe times out, dump `docker compose ps` and
`docker compose logs --tail 100 <slow-service>` and report the slow
container. Never claim success on a half-warm stack.
