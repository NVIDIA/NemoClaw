<!-- markdownlint-disable MD041 -->
## Outcome
Attaching an existing llama.cpp server no longer reports success when only host loopback `127.0.0.1:8081` is reachable. Onboarding now probes the sandbox hop at `host.openshell.internal:8081` and stops with dual-bind / firewall guidance when that TCP connect fails. Host fingerprint success with a loopback-only Docker publish (`-p 127.0.0.1:8081:8081`) no longer leaves chat hanging on a SYN blackhole.

## Reason
The sandbox inference route rewrites `http://127.0.0.1:8081/v1` to `http://host.openshell.internal:8081/v1` (the OpenShell Docker bridge IP). Host-side fingerprint and `inference set --no-verify` never test that hop, so a documented loopback-only publish looks healthy until every in-sandbox request times out.

### Related issues
Fixes #11626
Relates to #5744
Relates to #8161

## Changes
- After a successful llama.cpp host fingerprint and OpenAI-like validation, `createLlamaCppSelectionHandler` runs the existing host-service sandbox TCP probe on port 8081 (`probeHostServiceSandboxReachability`).
- A `tcp_failed` result is fail-closed (non-interactive exit 1; interactive retry-selection). `probe_unavailable` stays non-fatal, matching the Ollama proxy probe.
- The error names loopback-only Docker publish, the dual `-p <gateway-ip>:8081:8081` bind, and an optional UFW rule. Docs for attaching an existing server now require the bridge hop.
- Tests: `src/lib/onboard/llama-cpp-selection/index.test.ts` (#11626 handler cases) and `sandbox-reachability.test.ts` (message contract). Default unit-test probe stub keeps existing attach tests off live Docker.

## Verification
- `./node_modules/.bin/tsc -p tsconfig.src.json --noEmit` - passed via `npm ci` `prepare` / `build:cli` on Node v22.23.2
- `./node_modules/.bin/vitest run src/lib/onboard/llama-cpp-selection/index.test.ts src/lib/onboard/llama-cpp-selection/sandbox-reachability.test.ts` - 14 passed
- A/B: restore `index.ts` from `upstream/main`, rerun `index.test.ts` - 2 failed (`#11626` tcp_failed cases); restore fix - 14 passed
- `./node_modules/.bin/oxfmt --write` on the four changed TypeScript files - no remaining diff
- `./node_modules/.bin/oxlint` on those files - Found 0 warnings and 0 errors
- Brev `nemoclaw-518ae1`: mock llama.cpp in a container with `-p 127.0.0.1:8081:8081`. Host fingerprint 200; sandbox `nc` to `host.openshell.internal:8081` fails. `main` still prints `Attached Local llama.cpp`. After the patch, attach is fail-closed. Dual-bind `-p 172.19.0.1:8081:8081` then attaches.
- Broad `npm test` / `npm run check` / docs build not run (narrow onboard selection + one docs page)
- Diff reviewed: no secrets, API keys, or credentials

## Review notes
Onboarding and inference path: sandbox reachability probe reuses the #3340 host-service helper (short-lived busybox on the OpenShell Docker network). It does not start a private bridge or change operator-owned llama.cpp lifecycle. Maintainer review of the inference/onboard surface is requested.

---
Signed-off-by: Rui Luo <ruluo@nvidia.com>
