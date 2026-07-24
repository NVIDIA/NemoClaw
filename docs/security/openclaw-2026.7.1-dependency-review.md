<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw 2026.7.1 dependency review

Review date: 2026-07-21

## Decision

Pin the production OpenClaw runtime and matching official plugins to the
non-prerelease `v2026.7.1` release. This replaces `2026.6.10`, whose bundled
graph contains the newly disclosed critical `tar` advisory. The reviewed
`openclaw@2026.7.1` graph contains `tar@7.5.19`; the audit report contains no
`tar` finding. NemoClaw's plugin also consumes `tar` directly for guarded
migration archives, so its manifest and lock move from `7.5.11` to `7.5.20`;
the exact plugin graph reports no vulnerabilities after that update.

The release lineage is unusually wide and divergent: the direct upstream
comparison reports 4,407 commits ahead and 34 behind. The maintainer requested
this exact stable release after reviewing that risk. The long-term source of
truth for these behaviors remains upstream OpenClaw, and this upgrade does not
turn NemoClaw's compiled-dist shims into supported upstream APIs.

OpenClaw now requires Node `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.
NemoClaw therefore moves its exact `node:22-trixie-slim` digest to the image
whose amd64 config reports Node `22.23.1`.

## Reviewed identities

- `openclaw@2026.7.1`
  - `sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==`
  - `https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz`
- `@openclaw/diagnostics-otel@2026.7.1`
  - `sha512-XXhMifYWTgoR6yFN4T3JkHxdPvQCe8k1cNZjVIgXNmk1svCdBWuALfQQicmpemlmWwauIQuHYgBURY6k63e+rw==`
- `@openclaw/brave-plugin@2026.7.1`
  - `sha512-7Z+GZ/6K6a8LlkTsWVnAZ1hv8EarORzHQvFHD7ekcg033FGJOXYPEZSbvvE3qR9vM+vnoZplNjMZ7vFMRcvQgw==`
- `@openclaw/discord@2026.7.1`
  - `sha512-tZfdC1YA8oVLvc2BK1w0F6rUljS5ugCOp2uWe0vPsbG1fbzVVIO4V32RoqZznGHe5u2R9u4n1aV5Z/qa1m2oFg==`
- `@openclaw/slack@2026.7.1`
  - `sha512-dwVGEVCmoTQrOIeZaSCIOPg8pT7hB883QQEXdp9EZUDzTGuvSc+KxH2iERSOV/59hROQctYdcobGn/vdB1H4XA==`
  - remediated package tree: `sha512-4ThnsNS+yBlFSkTaQn2xosxrDu1s0vrxcqka5QqFj+8dCEaTa9JVLRgNniYV/QNhO53wc7a2R5oQFElzYspT2w==`
- `@openclaw/whatsapp@2026.7.1`
  - `sha512-wLY/Omc5fleRpl2lKGN8sxt/8hYfHGwLRezmWsk8oCbea5pRKUPE6ZX+wJO1O52NOJkAGCuiXvS7x0qIeKxXbQ==`
- `@openclaw/msteams@2026.7.1`
  - `sha512-gG/Yk6HZAguHwrmKjsqdONbFz5WNy126PEAXQWNW/TulO1kIifQ6tktM16BQPNLnkmWqLbj+TrrO55Cjas1aFg==`
  - remediated package tree: `sha512-FL4l65gEbbwtDd9Ogr69+xBNzIfE4YS8Hib36G+kcmX+T0oB1zL+/qs6b4bJc+ygTsh60H3yqpFbXoQeN05JYQ==`
- `@zed-industries/codex-acp@0.11.1`
  - `sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==`
  - `https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz`
- `@tencent-weixin/openclaw-weixin@2.4.3`
  - `sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==`
- `tar@7.5.20` (NemoClaw plugin direct dependency)
  - `sha512-9FcyK4PA6+WbzlTM9WhQm6vB5W7cP7dUiPsv1g7YDwEQnQ1CGpK3MGlKk/ITVWMk05kHZuBhmVhiv8LZoy/PFQ==`
  - `https://registry.npmjs.org/tar/-/tar-7.5.20.tgz`

## Audit result and temporary dependency remediations

The exact reviewed archive graph contains `823` total dependencies and reports
`13` moderate, `0` high, and `0` critical vulnerabilities. The critical `tar`
finding that blocked the previous pin and the high Jaeger finding are gone. npm
audit expands the remaining `@hono/node-server` advisory through its affected
OpenClaw and MCP dependents, alongside the separate moderate `protobufjs`
finding. Both advisories are below the configured `high` threshold.

The independently installed `nemoclaw/` plugin graph reports `0`
vulnerabilities after resolving its direct `tar` dependency to `7.5.20`.

The separately locked `mcporter@0.7.3` runtime graph originally resolved
`@hono/node-server@1.19.14`, affected by `GHSA-frvp-7c67-39w9`. Its former
`2.0.5` override became affected when `GHSA-9mqv-5hh9-4cgg` was published for
releases through `2.0.9`. The locked `@modelcontextprotocol/sdk@1.29.0` still
declares `@hono/node-server@^1.19.9`, so the dedicated runtime manifest now pins
reviewed `2.0.11`, outside both affected ranges. Its Node `>=20`
requirement remains inside the image's Node contract, and real ESM plus
CommonJS Streamable HTTP transport construction/start/close probes cover the
major-version compatibility boundary.

The SDK's locked AJV graph also requests `fast-uri@^3.0.1`; the newly published
`GHSA-v2hh-gcrm-f6hx` affects releases through `3.1.3`. The same manifest pins
the first compatible release outside that range, `3.1.4`. The resulting
`138`-dependency graph reports `0` known vulnerabilities; image assembly reports
lower-severity findings and blocks unaccepted high or critical findings through
the empty-by-default audit exception registry. Signature verification and the
exact committed lock remain mandatory. Remove either override when the declared
graph resolves to a reviewed patched release.

The published Slack and Microsoft Teams plugin archives bundle `axios@1.16.0`.
That version is in the affected range for the newly disclosed Axios
inherited-proxy advisory. NemoClaw therefore rebuilds only these two reviewed
plugin archives with this exact replacement graph:

- `axios@1.18.0`,
  `sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==`;
- `https-proxy-agent@5.0.1`,
  `sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==`;
- `agent-base@6.0.2`,
  `sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==`.

The diagnostics plugin bundles `@opentelemetry/sdk-node@0.219.0`, whose exact
dependency on `@opentelemetry/propagator-jaeger@2.8.0` is affected by
`GHSA-45rx-2jwx-cxfr`. The helper changes only that bundled SDK dependency edge
to the first patched release and installs the matching Core package beneath it:

- `@opentelemetry/propagator-jaeger@2.9.0`,
  `sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==`,
  `https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz`;
- nested `@opentelemetry/core@2.9.0`,
  `sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==`,
  `https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz`.

Both replacements declare `Apache-2.0`. The nested Core keeps every other
consumer on the plugin's reviewed `2.8.0` graph while satisfying Jaeger's exact
`2.9.0` dependency. The helper fails closed unless the source archive still
contains diagnostics `2026.7.1`, SDK Node `0.219.0`, Jaeger `2.8.0`, and no
preexisting nested Core. The resulting package tree is pinned to
`sha512-2qyDTRPqNs97jo/pAWWfxAkVZyCXYqui/IjrGf4eEfYop1eGN8qBMJ/Kp/bJ/V18RNnYpMxHi5ECFelekVxcAQ==`.
The trusted main-only
`test/openclaw-diagnostics-jaeger-runtime.test.ts` harness runs with
`NEMOCLAW_REAL_OPENCLAW_JAEGER_HARNESS=1`.
It materializes the exact reviewed diagnostics archive, applies the production
remediation, and installs that local archive with lifecycle scripts disabled.
The child-process probe confirms these results:

- malformed percent-encoded `uber-trace-id` and `uberctx-*` headers do not throw;
- malformed baggage is ignored;
- valid `uberctx-test` baggage remains available;
- a valid Jaeger header produces the expected trace and span context.

`scripts/lib/openclaw-npm-remediation.mts` verifies the original plugin and
replacement package identities before it writes the archive. It rejects an
upstream graph that no longer resolves Axios `1.16.0`. It then verifies the
deterministic remediated package-tree integrity before installation. This
canonical tree digest is independent of npm-generated tar metadata, which can
vary between npm patch releases without changing package contents. The
production plugin installer and `reviewed-npm-audit` use this same function.
The tree hash opens each regular file without following symbolic links and
validates the opened descriptor before it reads the content. This keeps the
metadata and content checks bound to the same file.

The Axios remediation is limited to `@openclaw/slack@2026.7.1` and
`@openclaw/msteams@2026.7.1`; the Jaeger remediation is limited to
`@openclaw/diagnostics-otel@2026.7.1`. Remove each branch when a reviewed stable
OpenClaw plugin release bundles the corresponding patched graph and passes the
repository audit.
Issue #7337 tracks removal of the Jaeger branch and its exact replacement pins.

The reviewed installer verifies each registry identity and downloaded tarball
integrity. `scripts/lib/reviewed-npm-archive.mts` uses `npm pack --json` and
rejects reported archive filenames containing unsafe archive paths. Its checks
bind reviewed npm installs to verified local archives and check each reviewed
npm plugin registry integrity. The helper returns only the verified local `.tgz`
path.

## OpenClaw Compiled-Dist Patch Runtime Boundary

`test/openclaw-real-patched-dist-harness.test.ts` materializes the exact public
archive under `NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1`, applies every current
NemoClaw patch, verifies syntax, and exercises the live device self-approval
proof. This is not a substitute for focused nightly E2E proof.

The `2026.7.1` dist changed seven reviewed shapes:

- strict managed-proxy activation now uses `isStrictManagedProxyActive`; the
  patch still activates only inside OpenShell and only without an explicit
  dispatcher policy;
- queued follow-up execution now resolves inbound context before allocating a
  run id; `scripts/patch-openclaw-chat-send.mts` preserves the submitted run id
  at that new boundary. It also suppresses the premature empty final event that
  the new queue acknowledgment emits before the correlated follow-up completes;
- device-token authentication now rejects a requested scope upgrade before the
  canonical pairing gate can create its pending request. The compatibility
  patch continues only an exact CLI/operator request limited to
  `operator.pairing`, `operator.read`, and `operator.write` into that gate; the
  requested operation remains blocked until canonical pairing approval;
- shared and per-agent SQLite state now run during the required gateway startup
  checkpoint and apply owner-only modes on each open.
  `scripts/patch-openclaw-shared-state-permissions.mts` keeps the upstream
  `0700` directory and `0600` file modes in same-UID OpenShell sandboxes.
  The entrypoint derives `NEMOCLAW_OPENCLAW_SHARED_STATE=1` only for its root,
  split-user topology; it explicitly removes that marker from non-root
  OpenShell startup. Direct-container `sandbox` and `gateway` users can then
  access the same database through their shared group, while OpenShell keeps
  OpenClaw's native private-mode contract. The image does not retain this
  marker; its descriptor-safe final repair normalizes any build-created global
  SQLite files for a later direct runtime. Gateway workers and direct-container
  connect shells inherit the entrypoint-derived marker.
  It skips `chmod` only when the existing mode already matches and rejects an
  unexpected or ambiguous compiled-dist shape;
- the patch leaves upstream private-store enforcement unchanged, including its
  `0700` directory and `0600` file modes for device identity, device
  authentication, and credential-profile paths. The shared-state marker is not
  consulted by those generic stores;
- generated `models.json` is the reviewed exception to the generic private-store
  rule. Under the split-user NemoClaw marker, the compiled models-config patch
  keeps this non-secret provider configuration at `0660` and skips a non-owner
  `chmod` when the inherited mode is already correct. Same-UID OpenShell and
  runtimes outside NemoClaw preserve the upstream `0600` behavior;
- the legacy update-check migration is skipped only under the split-user marker
  or a validated OpenShell marker. This state contains polling, notification,
  and auto-install cache for an OpenClaw version that NemoClaw pins in the
  image; all other startup migrations and the upstream behavior outside
  NemoClaw are unchanged.

`scripts/patch-openclaw-device-self-approval.mts` remains required. Its new
shape recognizers preserve the bounded stored-device credential flow and keep
the canonical `approveDevicePairing` transaction fail closed.
Until the initial `devices list` succeeds, the startup auto-pair watcher keeps
the loopback shared token and sets a child-only marker. The compiled
gateway-call patch uses that marker only to retain the CLI device identity that
OpenClaw `2026.7.1` otherwise omits for loopback shared-token calls. OpenClaw
then performs its canonical silent local-pairing transaction and issues the
stored device token. Once that credential exists, the patch automatically
retains CLI identity on ordinary loopback shared-token calls; the upstream
local-backend omission remains unchanged. This restores device-scope
enforcement without moving the gateway credential into OpenClaw state. After
bootstrap, list calls and every `devices approve` remove the gateway URL, port,
and shared token so the bounded approval flow uses that device credential.

## Gateway Startup Migration Compatibility

OpenClaw `2026.7.1` requires its migration checkpoint to complete without
warnings before the gateway reports readiness.
NemoClaw keeps supported sandbox upgrades compatible with that checkpoint as
follows:

- the final image copies Node `22.23.1` from the builder, including when the
  image layers onto a published base that still contains Node `22.22.2`;
- new images do not seed the legacy `update-check.json` placeholder.
  During an upgrade, the descriptor-pinned config helper removes this obsolete
  update polling and notification cache whether it is empty or populated when
  the entrypoint can mutate the parent. A non-root gateway under the exact
  root-owned shields-up topology retains the stable cache because it cannot
  unlink it; the patched OpenClaw migration ignores that non-authoritative
  pinned-version cache without producing a startup warning.
  Without the compatibility patch, OpenClaw would try to harden and archive the
  retained cache inside a shields-protected parent. Symbolic links, hard links,
  directories, oversized files, or a file that changes during validation are
  rejected;
- a root entrypoint starts the `gateway` user with `HOME=/sandbox`, so startup
  migrations do not probe the inaccessible `/root/.openclaw` path.

Installed-base coverage is the `v0.0.89-x86_64` row in the
`openshell-gateway-upgrade` E2E matrix. It installs the immutable v0.0.89
release with OpenClaw `2026.6.10`, seeds its legacy Memory Core SQLite and
update-check state plus a durable marker in the per-agent database materialized
by the legacy CLI, then upgrades through the current installer. The row proves
the per-agent database survives intact, the global database remains healthy,
the legacy sidecar migration and `2026.7.1` startup checkpoint complete, and
the restored `apiKey: "unused"` config still receives its gateway-held
credential only at the OpenShell boundary.
This custom route supplies `COMPATIBLE_API_KEY` only to the frozen v0.0.89
install, then deliberately withholds it from the current installer so the
post-upgrade turn proves the existing gateway-held credential was reused. The
frozen runtime intentionally creates no NVIDIA auth-profile key reference; the
E2E preserves any references that do exist without inventing one for this route.

During image assembly, the shared-state repair rejects symbolic links,
non-regular entries, and multiply linked files before it changes the ownership
or mode of `exec-approvals.json` or SQLite state. This prevents a stale image
entry from redirecting those mutations to another path or inode.

These repairs run during image build or sandbox startup.
They do not change the documented update and rebuild workflow.
Regression coverage lives in `test/openclaw-2026-7-startup-compat.test.ts` and
`test/openclaw-shared-state-permissions-patch.test.ts`.
Remove the legacy cache repair after every supported upgrade source stops
seeding the file or OpenClaw can migrate it across split users and a protected
parent without a warning.

## Existing security and runtime contracts

The OpenClaw Diagnostics OTEL Host Gateway Boundary remains unchanged. The
`openclaw-diagnostics-otel-local` policy is limited to the diagnostics plugin,
which imports `OTLPTraceExporter` and contains no `web_fetch`, `fetchWithSsrFGuard`
call path.

Messaging contracts remain pinned to the reviewed runtime shapes:

- `dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`;
- the preload imports the hashed pipeline runtime for `prepareSlackMessage` and
  only reports `openclaw-pipeline-runtime` after allowed prepare;
- `dist/extensions/telegram/runtime-api.js`, which exports `sendMessageTelegram`;
- runtime validation fails closed if the installed runtime file is missing;
- tests reject claiming `openclaw-pipeline-runtime` inbound proof when a fixture
  imports `dist/extensions/telegram/test-api.js`.

Legacy upgrade fixtures remain gated behind
`NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1`. The
`scripts/check-production-build-args.sh` guard rejects those fixture-only
production build args.

## Issue #4434 full live acceptance

`scripts/patch-openclaw-issue-4434-diagnostics.mts` and
`test/issue-4434-error-fields.test.ts` remain tied to the gateway/upstream
reporting layer. The #4434 compatibility-shim disposition is explicitly accepted
for this release. 3/3 fields are present in the NemoClaw-patched runtime output,
while 3/3 fields are missing in the upstream-shaped `openclaw@2026.7.1` output.

The live acceptance requires the recovery text:
`Recovery hint: check sandbox egress and provider reachability, then retry.`
The focused live guard retains its default 180-second timeout.
