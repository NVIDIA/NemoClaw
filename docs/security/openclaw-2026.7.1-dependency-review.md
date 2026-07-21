<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw 2026.7.1 dependency review

Review date: 2026-07-20

## Decision

Pin the production OpenClaw runtime and matching official plugins to the
non-prerelease `v2026.7.1` release. This replaces `2026.6.10`, whose bundled
graph contains the newly disclosed critical `tar` advisory. The reviewed
`openclaw@2026.7.1` graph contains `tar@7.5.19`; the audit report contains no
`tar` finding.

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
  - remediated archive: `sha512-ctU4iNWpx3IDPDXqjRdU4TvzhM/dXUvuDXJHcl82/gUTMOFHO8bW+2UTTTKTNAmZbPz/YBeztJb6oaJfxxusvw==`
- `@openclaw/whatsapp@2026.7.1`
  - `sha512-wLY/Omc5fleRpl2lKGN8sxt/8hYfHGwLRezmWsk8oCbea5pRKUPE6ZX+wJO1O52NOJkAGCuiXvS7x0qIeKxXbQ==`
- `@openclaw/msteams@2026.7.1`
  - `sha512-gG/Yk6HZAguHwrmKjsqdONbFz5WNy126PEAXQWNW/TulO1kIifQ6tktM16BQPNLnkmWqLbj+TrrO55Cjas1aFg==`
  - remediated archive: `sha512-qtdnGvSnxaOJPG5nY/qEhXQzZoJIqnzp+3jaq2DWVB74T+zBdb9i/KVsiGFloMSjXx/pg8+i+nkhKFTaEOYHZg==`
- `@zed-industries/codex-acp@0.11.1`
  - `sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==`
  - `https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz`
- `@tencent-weixin/openclaw-weixin@2.4.3`
  - `sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==`

## Audit result and temporary Axios remediation

The exact reviewed archive graph contains `822` total dependencies and reports
`1` moderate, `0` high, and `0` critical vulnerabilities. The critical `tar`
finding that blocked the previous pin is gone. The remaining moderate
`protobufjs` finding is below the configured `high` threshold.

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

`scripts/lib/openclaw-npm-remediation.mts` verifies the original plugin and
replacement package identities before it writes the archive. It rejects an
upstream graph that no longer resolves Axios `1.16.0`. It then verifies the
deterministic remediated archive integrity before installation. The production
plugin installer and `reviewed-npm-audit` use this same function.

This remediation is limited to `@openclaw/slack@2026.7.1` and
`@openclaw/msteams@2026.7.1`. Remove it when a reviewed stable OpenClaw plugin
release bundles Axios `>=1.18.0` and passes the repository audit.

The reviewed installer verifies each registry identity and downloaded tarball
integrity. `scripts/lib/reviewed-npm-archive.mts` uses `npm pack --json`, rejects
reported archive filenames containing unsafe archive paths, binds reviewed npm
installs to verified local archives, checks each reviewed npm plugin registry
integrity, and returns only the verified local `.tgz` path.

## OpenClaw Compiled-Dist Patch Runtime Boundary

`test/openclaw-real-patched-dist-harness.test.ts` materializes the exact public
archive under `NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1`, applies every current
NemoClaw patch, verifies syntax, and exercises the live device self-approval
proof. This is not a substitute for focused nightly E2E proof.

The `2026.7.1` dist changed two reviewed shapes:

- strict managed-proxy activation now uses `isStrictManagedProxyActive`; the
  patch still activates only inside OpenShell and only without an explicit
  dispatcher policy;
- queued follow-up execution now resolves inbound context before allocating a
  run id; `scripts/patch-openclaw-chat-send.mts` preserves the submitted run id
  at that new boundary;
- device-token authentication now rejects a requested scope upgrade before the
  canonical pairing gate can create its pending request. The compatibility
  patch continues only an exact CLI/operator request limited to
  `operator.pairing`, `operator.read`, and `operator.write` into that gate; the
  requested operation remains blocked until canonical pairing approval.

`scripts/patch-openclaw-device-self-approval.mts` remains required. Its new
shape recognizers preserve the bounded stored-device credential flow and keep
the canonical `approveDevicePairing` transaction fail closed.

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
