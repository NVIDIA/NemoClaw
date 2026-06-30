# OpenClaw 2026.6.9 Dependency Review

Review date: 2026-06-22

Advisory audit revalidated: 2026-06-26

Scope: NemoClaw runtime pin `openclaw@2026.6.9`, runtime helper pin `@zed-industries/codex-acp@0.11.1`, optional OpenClaw plugins, and built-in messaging OpenClaw plugins.

## Package Identity

- npm package: `openclaw@2026.6.9`
- npm tarball: `https://registry.npmjs.org/openclaw/-/openclaw-2026.6.9.tgz`
- npm integrity: `sha512-y0PGUdE87S8QtQXABPDL0CjNKhH3q/R1h9/WiRQkhVCGSBVhs63/M1iZn2DYVyJCAbDyMz3KNyAE0WzSQIWCRg==`
- npm publish time: `2026-06-21T01:37:53.047Z`
- Codex ACP runtime helper package: `@zed-industries/codex-acp@0.11.1`
- Codex ACP runtime helper npm tarball: `https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz`
- Codex ACP runtime helper npm integrity: `sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==`
- Diagnostics OTEL plugin package: `@openclaw/diagnostics-otel@2026.6.9`
- Diagnostics OTEL plugin npm integrity: `sha512-jU2q4L6L3qdZZDEIDXrWgwCWOGUaTSF+YzUlfgHED42TB4N3maF6seYchFpwKLB8neOzIDpnzMagEMjxZ/7Wqw==`
- Brave search plugin package: `@openclaw/brave-plugin@2026.6.9`
- Brave search plugin npm integrity: `sha512-8HawXB5ylo+vkvkmDJZAE9uhOtm0l9YtzrVqJdM4UqwXeF4uGAkVEOrR3Hxy0sI3Moi5ZBzq2Jx/K5ZQKdiWjQ==`
- Discord channel plugin package: `@openclaw/discord@2026.6.9`
- Discord channel plugin npm integrity: `sha512-esFhwYW0nrFQvBhkPeK/1qmvumlVAY8ddhYBt7geIYLlBriwPJRwtnVLLfp0n1LbS0/XVZ0ORqlvkWq8Vv61vg==`
- Slack channel plugin package: `@openclaw/slack@2026.6.9`
- Slack channel plugin npm integrity: `sha512-JZHc0L3s6s+yBsWowZtE/DWZJOuy4lTE6uTuUbF5QNjUvQQUlCHMFrwPycrXLesVq1il5yAvo82VbERRsIzgxQ==`
- WhatsApp channel plugin package: `@openclaw/whatsapp@2026.6.9`
- WhatsApp channel plugin npm integrity: `sha512-HWz9CryGcSk5ork03DlESVlRcDBnwuXPEKgqdSz/Qt0OnQ2Z1wqNGpwVlAqngvDQDH2AzkNXWuTu2M0C16R8vA==`
- Microsoft Teams channel plugin package: `@openclaw/msteams@2026.6.9`
- Microsoft Teams channel plugin npm integrity: `sha512-Ye1nf2fZYGM3lqQJ/zGlhToThyz1lLZE7HqR2F31iWcD5pV89+eEyRFNNH2FrwYeDVjw+EyWpQh2RkN1r867qg==`
- WeChat channel plugin package: `@tencent-weixin/openclaw-weixin@2.4.3`
- WeChat channel plugin npm integrity: `sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==`

NemoClaw enforces the main `openclaw@2026.6.9`, `@zed-industries/codex-acp@0.11.1`, and each reviewed npm plugin registry integrity, including optional OTEL/brave plugins and messaging plugins, before install. The Dockerfile and messaging build applier then run `npm pack --json`, require the downloaded tarball integrity to match the committed SRI, reject reported archive filenames that are absolute, contain path separators, equal `.` or `..`, include `..` path segments, or resolve outside the fresh pack directory, and install from the verified local `.tgz` archive. Codex ACP and OpenClaw core also verify that registry metadata still reports the reviewed npm tarball URL before packing that URL.

## Advisory Check

Command run from a temporary directory:

```bash
npm init -y
npm install --package-lock-only --ignore-scripts --no-fund --no-audit \
  openclaw@2026.6.9 \
  @zed-industries/codex-acp@0.11.1 \
  @openclaw/diagnostics-otel@2026.6.9 \
  @openclaw/brave-plugin@2026.6.9 \
  @openclaw/discord@2026.6.9 \
  @openclaw/slack@2026.6.9 \
  @openclaw/whatsapp@2026.6.9 \
  @openclaw/msteams@2026.6.9 \
  @tencent-weixin/openclaw-weixin@2.4.3
npm audit --omit=dev --json
```

Revalidated on 2026-06-26: npm audit exited `0` and reported `0` info, `0` low, `0` moderate, `0` high, and `0` critical vulnerabilities across `763` total dependencies.
The audit host used Node `22.16.0` and emitted npm `EBADENGINE` warnings for packages that require newer Node `22.x` builds. Production NemoClaw images use the digest-pinned `node:22-trixie-slim` image, which currently runs Node `v22.22.2` and satisfies the `openclaw@2026.6.9` engine requirement of `>=22.19.0`. The audit remains advisory vulnerability evidence for the locked dependency graph; the audit-host warning does not describe the production runtime.

This review is an advisory snapshot for the direct OpenClaw runtime package, Codex ACP runtime helper, optional plugins, messaging plugins, and their npm dependency graphs at review time. It complements, but does not replace, the committed npm integrity pins, Dockerfile install-time registry integrity checks, and plugin install-time registry integrity checks.

## Transitive Dependency Graph Rationale

The OpenClaw 2026.6.9 bump does not newly introduce an unfrozen OpenClaw transitive graph. The reviewed `openclaw@2026.6.9` artifact ships `npm-shrinkwrap.json`; the previous reviewed `openclaw@2026.5.27` artifact also shipped `npm-shrinkwrap.json`. A spot check of the reviewed 2026.6.9 package found lockfile version `3`, `306` package entries, and no resolved package entries missing integrity metadata. The reviewed `@openclaw/diagnostics-otel@2026.6.9`, `@openclaw/brave-plugin@2026.6.9`, `@openclaw/discord@2026.6.9`, `@openclaw/slack@2026.6.9`, `@openclaw/whatsapp@2026.6.9`, and `@openclaw/msteams@2026.6.9` artifacts also ship `npm-shrinkwrap.json`.

`@zed-industries/codex-acp@0.11.1` has no declared npm dependencies, so the committed package SRI plus reviewed tarball URL fully describes its npm install input for this release. The only reviewed messaging plugin without a package-internal shrinkwrap is the existing non-OpenClaw Tencent WeChat plugin, `@tencent-weixin/openclaw-weixin@2.4.3`; it was already installed by package spec before this OpenClaw bump, and this PR adds a committed top-level SRI check for that unchanged package. NemoClaw accepts that existing WeChat transitive range risk for this dependency bump because it is not introduced by the OpenClaw version change and because default production installs now fail closed on top-level registry integrity drift, tarball-integrity drift, and unsafe archive paths. A future installer-policy PR should move third-party messaging plugins without package-internal shrinkwraps to a NemoClaw-owned lock/audit gate.

## Slack Source Review

The main `openclaw@2026.6.9` package excludes `dist/extensions/slack/**`; its channel catalog points Slack installs to the external npm plugin `@openclaw/slack`. The reviewed `@openclaw/slack@2026.6.9` artifact exposes:

- `dist/runtime-api.js`, which exports `sendMessageSlack`;
- `dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`; and
- the denied channel-user gate containing `Blocked unauthorized slack sender ${senderId} (not in channel users)`, which NemoClaw's `slack-channel-guard` preload patches to emit one bounded sender-facing denial notice for explicit `app_mention` events.

The migrated Vitest lane in `test/e2e/live/messaging-providers.test.ts` calls `runInstalledSlackRuntimeProof` from `test/e2e/live/messaging-providers-slack-runtime-proof.ts`. That helper discovers the installed external `@openclaw/slack@2026.6.9` runtime and uses `prepareSlackMessage` from `dist/pipeline.runtime-*.js` plus `sendMessageSlack` from `dist/runtime-api.js`. The default 2026.6.9 live lane requires the resulting `openclaw-pipeline-runtime` proof and fails if only the older private helper is available. The private-helper branch is disabled unless an isolated legacy fixture explicitly sets `NEMOCLAW_E2E_ALLOW_LEGACY_SLACK_TEST_API=1`, and remains compatibility support pending retirement in #5896. The proof verifies an allowed channel `app_mention`, verifies a denied channel user receives exactly one bounded sender-facing feedback action, and sends against the hermetic fake Slack API with capture assertions that reject unresolved credential placeholders.

## Telegram Source Review

The main `openclaw@2026.6.9` package no longer includes `dist/extensions/telegram/test-api.js`. Its bundled Telegram channel still exposes `dist/extensions/telegram/runtime-api.js`, which exports `sendMessageTelegram` and accepts NemoClaw's hermetic fake Telegram API override for send proof.

The migrated Vitest lane calls `runInstalledTelegramRuntimeProof` from `test/e2e/live/messaging-providers-telegram-runtime-proof.ts`. That helper resolves the installed `openclaw/dist/extensions/telegram/runtime-api.js` file, fails closed unless `sendMessageTelegram` is exported, and sends through that runtime API against the host-side fake Telegram Bot API. `test/e2e/live/messaging-providers.test.ts` retains the OpenShell REST policy, token rewrite assertion, chat/text capture, and unresolved-placeholder checks around that installed-runtime call.

## Microsoft Teams Package-Load Review

The published `@openclaw/msteams@2026.6.9` artifact was re-reviewed after integrating the OpenShell 0.0.71 prerequisite. Its npm SRI is the committed `sha512-Ye1nf2fZYGM3lqQJ/zGlhToThyz1lLZE7HqR2F31iWcD5pV89+eEyRFNNH2FrwYeDVjw+EyWpQh2RkN1r867qg==`; `package.json` declares `./dist/index.js` as its runtime extension; that entry has SHA-256 `2a83ee979d5ee9f12c7ac507ebd87024be3315de3f2cc87c81effc9ca85246d1`; and `dist/channel-plugin-api.js` has SHA-256 `2d451b31ba4fbcc0e22ea4654fdc55dc05ae680765b7d636bfbf89177eb1be4b`. `test/package-contract/msteams-message-hints-preload.test.ts` binds the preload compatibility fixture to that reviewed version, SRI, runtime entry, plugin specifier, and entry hashes. This is package/load-boundary evidence only; it does not claim live Bot Framework delivery.

## Bundled Weather Skill Egress Review

The SRI-verified `openclaw@2026.6.9` artifact's `package/skills/weather/SKILL.md` has SHA-256 `62ab4821aa873949d1c1091836be1659a42b32caadce4bd145f5505a1ceaeec1`. The reviewed skill prefers `web_fetch` to HTTPS `wttr.in` paths and lists HTTPS `wttr.in` curl fallbacks using read-only requests; it mentions `wttr.is` only as an optional retry when the primary service is unreliable. NemoClaw's weather preset therefore continues to allow only GET/HEAD to `wttr.in` at that boundary and intentionally leaves `wttr.is` denied unless a future pinned runtime makes the fallback required. `test/weather-policy.test.ts` binds that host/method contract to the reviewed OpenClaw version.

## PR Review Follow-ups

### Installer Integrity Transaction Boundary

`Dockerfile`, `Dockerfile.base`, optional OpenClaw plugin installs, and `src/lib/messaging/applier/build/messaging-build-applier.mts` now bind reviewed npm installs to verified local archives. The install blocks first verify `npm view ... dist.integrity` against the committed SRI. Codex ACP and OpenClaw core also verify `npm view ... dist.tarball` against the reviewed tarball URL. The actual install input is then produced by `npm pack --json`; the reported downloaded tarball integrity must match the committed SRI and the reported filename must be contained inside the freshly created pack directory before `npm install -g <local .tgz>` or `openclaw plugins install <local .tgz> --pin` runs.

Invalid state: `npm view` returns the reviewed SRI but the downloaded artifact used for install has different bytes, or `npm pack --json` reports a filename such as `../package.tgz`, `/tmp/package.tgz`, or a name containing path separators so the later install consumes a path outside the fresh pack directory. Source boundary: Dockerfile npm install blocks, `Dockerfile.base`, optional plugin install blocks, and `src/lib/messaging/applier/build/messaging-build-applier.mts`. Source-fix constraint: npm package installation must stay artifact-bound for reviewed pins rather than reverting to a later floating package-spec transaction, and local archive path validation must be enforced at NemoClaw's install boundary because npm's JSON filename is untrusted input. Regression test: `test/openclaw-integrity-pin.test.ts` exercises registry drift, reviewed tarball URL drift, local archive install behavior, and unsafe reported archive filenames for Dockerfile core, codex-acp, base, and optional plugin pack helpers; `test/messaging-build-applier.test.ts` verifies messaging plugins run through `npm pack --json` and install the verified archive path; `test/messaging-build-applier-integrity.test.ts` verifies the messaging plugin install fails closed when packed archive integrity drifts or the reported archive filename escapes the pack directory. Removal condition: keep this archive verification until the repo moves the OpenClaw/plugin dependency set to a lockfile path where npm enforces the committed SRI directly and no installer code consumes raw `npm pack --json` filenames.

#### Deferred #5896 Archive Consolidation Contract

The four Docker shell transactions (Codex ACP, runtime OpenClaw, base-image OpenClaw, and optional plugins) and the two-stage Node verifier shared by every messaging-plugin install deliberately keep the same security matrix at their caller boundaries: exact reviewed package identity, registry SRI, packed-byte SRI, a nonempty basename contained in a fresh pack directory, install from the resolved local archive only, cleanup, and failure before install on any mismatch. The Docker transactions additionally bind a reviewed registry tarball URL; messaging manifests currently bind an exact package spec and SRI but do not carry a separate reviewed URL. That is an intentional policy difference, not a missing integrity or containment check.

Invalid state: one local verifier drops a common invariant while the others retain it. Source boundary: the four Docker transactions plus `packVerifiedOpenClawPluginArchive`/`packNpmArchive`, which form one shared Node primitive for all messaging consumers. Source-fix constraint: consolidating shell build layers and a host-side Node installer changes every trusted install boundary together; issue #5896 section 2 requires that migration to retain thin caller wrappers and caller-specific regressions in one focused change. Regression tests: `test/openclaw-dependency-review.test.ts` names all five implementation boundaries and asserts the common invariant markers, fresh directories, cleanup, and local-archive-only install; `test/openclaw-integrity-pin.test.ts` and `test/messaging-build-applier-integrity.test.ts` execute drift and unsafe-filename failures at both execution environments. Removal condition: close this deferral only when #5896 section 2 replaces the local implementations with a reviewed shared implementation while retaining every caller-boundary regression.

### OpenClaw Compiled-Dist Patch Runtime Boundary

The OpenClaw 2026.6.9 compiled-dist patches are localized compatibility patches for sandbox fetch routing, cron preflight proxying, `host.openshell.internal` web_fetch scoping, unconfigured strict-fetch managed-proxy activation, `chat.send`/`get-reply` correlation, and #4434 TUI unreachable-inference diagnostics. The long-term source of truth for these behaviors remains upstream OpenClaw; NemoClaw's Dockerfile and patch scripts carry fail-closed version-shape patches only so the reviewed package can run inside the current NemoClaw/OpenShell sandbox contract.

Invalid state: a real installed `openclaw@2026.6.9` dist changes semantics while fixture-compatible recognizers still pass. Source boundary: the installed OpenClaw generated `dist` files, the Dockerfile fetch-guard patch block, `scripts/patch-openclaw-chat-send.js`, and `scripts/patch-openclaw-issue-4434-diagnostics.ts`. Source-fix constraint: upstream OpenClaw should own permanent fixes; NemoClaw patches must stay version-scoped, fail closed on unknown shapes, and be removed when upstream ships reviewed behavior. Regression tests: `test/fetch-guard-patch-regression.test.ts`, `test/openclaw-chat-send-patch.test.ts`, and `test/openclaw-issue-4434-diagnostics-patch.test.ts` execute patched fixtures for the reviewed shapes. `test/openclaw-real-patched-dist-harness.test.ts` is the checked-in real-package harness: when run with `NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1`, it downloads the reviewed tarball URL, verifies the committed SRI, extracts the actual `openclaw@2026.6.9` dist, applies the Dockerfile patch block, runs `scripts/patch-openclaw-chat-send.js`, runs `scripts/patch-openclaw-issue-4434-diagnostics.ts`, and audits the mutated dist for Patch 2, Patch 2b, Patch 4, Patch 6, Patch 7, chat-send/get-reply/followup-runner markers, and the #4434 assistant-error formatter marker.

The harness remains explicit opt-in for PR and local proof. Trusted main CI sets `NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1` and materializes the reviewed archive automatically with a bounded download retry and a 12-minute job budget. PR CI intentionally does not treat PR-authored harness code as its own security gate.
This source-package proof is not a substitute for focused nightly E2E proof of affected runtime workflows, exact-head image builds, or final full E2E proof before merge.
Removal condition: delete the localized patches and harness when OpenClaw ships the reviewed behavior; if NemoClaw keeps carrying the patches beyond this bump, retain both the archive harness and built-image runtime gates.

#### OpenClaw Patch Source-of-Truth Table

| Patch | Invalid state | Source boundary | Why upstream/source cannot be fixed here | Regression test | Removal condition |
|---|---|---|---|---|---|
| Patch 2: `assertExplicitProxyAllowed` env-gated bypass | Proxy validation rejects the OpenShell-managed env proxy inside an `OPENSHELL_SANDBOX=1` sandbox, or the bypass applies outside that explicit sandbox boundary. | Reviewed `openclaw@2026.6.9` fetch-guard dist files containing `async function assertExplicitProxyAllowed`; NemoClaw Dockerfile only adds the sandbox env gate. | The validator is generated OpenClaw compiled dist from the npm package. This PR can only adapt the installed artifact for the NemoClaw/OpenShell sandbox contract; the durable behavior belongs upstream. | `test/fetch-guard-patch-regression.test.ts` executes the reviewed shape, verifies the env-gated bypass, and fails closed on unreviewed proxy-validator shapes. | Remove the patch when OpenClaw natively treats the OpenShell sandbox env proxy as allowed, or when NemoClaw no longer uses this env-proxy path. |
| Patch 2b: `host.openshell.internal` web_fetch trusted env-proxy policy | `host.openshell.internal` becomes reachable through strict fetch, through a broad `.internal` bypass, or without `useEnvProxy`; conversely, legitimate web_fetch traffic through the trusted env proxy is blocked. | Reviewed `fetchWithWebToolsNetworkGuard` and SSRF policy helpers in `openclaw@2026.6.9`; the Dockerfile patch adds exact `allowedHostnames` policy only for `useEnvProxy` and the exact host. | The host-gateway exception is a NemoClaw/OpenShell integration policy. Upstream OpenClaw owns generic web_fetch and SSRF semantics and should not receive a NemoClaw-specific hostname carveout without a broader design. | `test/fetch-guard-patch-regression.test.ts` covers trusted env-proxy host-gateway scoping, strict-mode blocking, and the reviewed `allowedHostnames` private-network boundary. | Remove the patch when OpenClaw exposes an upstream supported policy hook for this host-gateway use case or NemoClaw stops routing web_fetch through the OpenShell host gateway. |
| Patch 4: managed-proxy activation for `OPENSHELL_SANDBOX=1` | Unconfigured strict fetches in the sandbox bypass the OpenShell L7 proxy, or explicit dispatcher/direct policies are overwritten by the fallback. | Reviewed fetch-guard managed-proxy gate in `openclaw@2026.6.9`; the Dockerfile patch extends activation only when `OPENSHELL_SANDBOX=1` and no explicit `dispatcherPolicy` is present. | The compiled dist is package output. NemoClaw can keep sandbox egress compatible for this bump, but upstream OpenClaw should own a first-class managed-proxy behavior for sandboxed runtimes. | `test/fetch-guard-patch-regression.test.ts` asserts the unconfigured strict-fetch fallback while preserving explicit dispatcher policy behavior. | Remove the patch when OpenClaw routes sandbox strict fetches through the configured env proxy without NemoClaw mutation, or when sandbox egress no longer depends on that proxy. |
| Patch 6: cron model-provider preflight trusted env-proxy mode | Cron preflight resolves `inference.local` directly and fails with DNS/egress errors, or the rewrite widens multiple call sites without a reviewed shape. | Reviewed cron isolated-agent preflight call in `openclaw@2026.6.9` that uses `auditContext: "cron-model-provider-preflight"` with `fetchWithSsrFGuard` and `buildLocalProviderSsrFPolicy`. | The preflight call site lives in upstream OpenClaw source; NemoClaw only patches the reviewed compiled call site so scheduled runs can reach the OpenShell-managed inference route. | `test/fetch-guard-patch-regression.test.ts` guards the single-callsite shape, exact trusted-env-proxy insertion, and ambiguous multi-callsite failure mode. | Remove the patch when OpenClaw sets `mode: "trusted_env_proxy"` or equivalent env-proxy routing for managed inference preflight. |
| Patch 7: #4434 TUI unreachable-inference diagnostic enrichment | The TUI reports only `TypeError: fetch failed` or `LLM request timed out.` for blocked sandbox inference egress, or enrichment applies outside `OPENSHELL_SANDBOX=1`. | Reviewed assistant error formatter dist file containing `formatRawAssistantErrorForUi`; `scripts/patch-openclaw-issue-4434-diagnostics.ts` adds missing cause, gateway/upstream reporting, and recovery hint fields. | The formatter source lives in upstream OpenClaw. NemoClaw can patch the reviewed compiled artifact for the OpenShell sandbox contract, but the durable fix belongs upstream. | `test/openclaw-issue-4434-diagnostics-patch.test.ts` verifies both reviewed failure shapes, env gating, partial-field completion, full-message preservation, and fail-closed selectors; the #4434 live guards require all fields. | Remove the patch when OpenClaw emits HTTP/cause, gateway/upstream layer, and recovery hint directly for unreachable inference errors. |

### OpenClaw Diagnostics OTEL Host Gateway Boundary

The default `NEMOCLAW_OPENCLAW_OTEL_ENDPOINT=http://host.openshell.internal:4318` is scoped to the local OTLP traces collector and requires the dedicated `openclaw-diagnostics-otel-local` policy preset. That preset allows only `POST /v1/traces` and `POST /v1/traces/**` to `host.openshell.internal:4318` for the OpenClaw/node binaries, separate from the `web_fetch` host-gateway exception in Patch 2b.

The reviewed `@openclaw/diagnostics-otel@2026.6.9` package dist imports `OTLPTraceExporter` from `@opentelemetry/exporter-trace-otlp-proto`, resolves the configured OTLP endpoint, and contains no `web_fetch`, `fetchWithSsrFGuard`, or `withTrustedEnvProxy` references. That source boundary keeps diagnostics export traffic on the OpenTelemetry OTLP exporter path rather than NemoClaw's patched OpenClaw `web_fetch` helper. Removal condition: re-audit this boundary on the next diagnostics plugin bump or if the OTEL plugin starts routing exports through OpenClaw tool/web fetch APIs.

### Legacy Fixture Pins

The legacy `2026.3.11` and `2026.4.24` OpenClaw pins are retained only for stale-upgrade fixture builds. Production Dockerfile install blocks now reject those versions unless `NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1` is set explicitly. The E2E-scoped name is intentionally noisy so production build workflows do not treat it as a general override. Production image workflows run `scripts/check-production-build-args.sh` before production Docker builds so the fixture flag, both legacy version values, and their fixture-only integrity/tarball overrides cannot be passed through production build args or environment. The stale-upgrade E2E build contexts pass that flag only on their fixture-specific build paths, and `test/openclaw-integrity-pin.test.ts` verifies the default rejection, the explicit fixture opt-in, and the workflow guard.

Invalid state: a production image build overriding `OPENCLAW_VERSION` to an old fixture pin while still passing integrity checks. Source boundary: Dockerfile and Dockerfile.base install blocks plus the guard that precedes every production image build. Source-fix constraint: keep stale-upgrade E2Es able to build old images without normalizing those pins as production targets. Regression tests: `test/openclaw-integrity-pin.test.ts` rejects the flag, both legacy versions, and all four legacy integrity/tarball overrides at the production boundary; `test/openclaw-dependency-review.test.ts` proves all seven production image builds are guard-protected and carry no literal fixture selectors. Removal condition: issue #5896 section 9 retires the old-base fixture strategy, legacy pins, fixture flag, and production guard together.

### Recovered Gateway Credential Boundary

During rebuild, OpenShell remains the system of record for provider credential bytes.
NemoClaw does not read, export, or replace a credential that exists only in the gateway, and this recovery path never updates or repoints the registered provider.
NemoClaw accepts provider, model, preferred API, and custom endpoint metadata only as one complete route from either the current registry row or the matching onboard session; a partial registry row is never completed from older session data.
The recovery path may omit direct host validation only when the selection was recovered from the target sandbox, provider/model values are complete and bounded, the preferred API is compatible with that provider type, and `openshell provider get` reports the exact provider name, type, credential-binding key, and expected endpoint-config key.
Custom-endpoint reuse additionally requires the complete route to come from the current registry row, to canonicalize to the same recorded HTTP(S) identity, and every other registry entry using that global provider to record that same endpoint.
Before destructive rebuild deletes the sandbox and registry row, NemoClaw captures a complete bounded route directly from that row and, when no host key exists, requires the same provider/model/API/endpoint and non-secret gateway bindings to pass the credential-reuse assessment before backup or deletion. It then passes that route only in memory to the same sandbox's recreate provider-selection call. Session-only and explicit-environment endpoints never receive registry provenance, and the normal image/registry cleanup happens immediately. This preserves the registry-backed trust boundary without a phantom registry entry or persisted spoofable marker.

OpenShell deliberately reports provider config keys but not config values, so NemoClaw cannot confirm the exact live endpoint value through this interface.
Credential-only recovery does not run `provider update`.
It verifies the non-secret provider shape, preserves the gateway's existing credential/config binding unchanged, and re-applies only `inference set` for the recovered provider/model.
An existing provider may already have been redirected out of band; that endpoint-value drift is the residual this interface cannot detect, while the recovery path itself cannot introduce or change that redirection.

Invalid state: a rebuild with no host key probes a remote endpoint with an empty credential and fails after deleting the old sandbox, mixes partial current metadata with stale session fields, or silently reuses a gateway provider for an explicit, malformed, provider-incompatible, or conflicting-endpoint selection.
Source boundary: `src/lib/actions/sandbox/rebuild-provider-preflight.ts`, `src/lib/onboard/provider-recovery.ts`, `src/lib/onboard/recovered-provider-reuse.ts`, `src/lib/onboard/inference-providers/remote.ts`, `src/lib/onboard.ts`, and OpenShell's provider registry.
Source-fix constraint: OpenShell intentionally does not expose stored credential or config values, so NemoClaw can reconcile only non-secret routing metadata and must fail closed if the exact provider shape or one complete recovery identity is unavailable.
Regression tests: `src/lib/actions/sandbox/rebuild-provider-preflight.test.ts` rejects incomplete, unbounded, spoofed, and conflicting keyless recovery before destructive work; `src/lib/onboard/provider-recovery.test.ts` rejects partial or unbounded live CLI output and mixed-source routes; `src/lib/onboard/recovered-provider-reuse.test.ts` covers provider/API/endpoint compatibility and fail-closed cases; `test/onboard-remote-recreate-credential-reuse.test.ts` proves the route is re-applied without a provider update, credential flag, config replacement, or direct curl probe.
The `hermes-discord` and `channels-add-remove` live jobs remain the real rebuild gates.
Removal condition: replace this localized decision boundary when OpenShell provides a typed credential-preserving provider/route reconcile operation that validates through its stored credential without disclosing it.

### Image-Managed OpenClaw Extension Restore Boundary

Fresh OpenClaw images own the executable copies of reviewed archive-installed extensions.
Snapshot restore may restore user extensions, but it excludes every image-managed extension directory and preserves those directories during cleanup.
Snapshot symlink validation permits only these extension link shapes:

- The exact `extensions/<id>/node_modules/openclaw` peer link to `/usr/local/lib/node_modules/openclaw`.
- The reviewed WeChat `qrcode-terminal` executable link with its exact target.
- Extension-local npm `.bin` links whose relative targets remain inside the same `node_modules` tree.

Before cleanup, NemoClaw rejects any managed extension path that is not a real directory, including a dangling symlink.
The snapshot policy lives in `src/lib/state/openclaw-managed-extensions.ts`.
The descriptor-safe shields transition in `scripts/state-dir-guard.py` mirrors only the exact OpenClaw peer-link source shape and target above, reads the link itself without following the external target, and otherwise retains the generic fail-closed symlink policy.
`src/lib/state/sandbox.ts` only orchestrates these policies during validation and restore.

Invalid state: archived executable plugin copies overwrite freshly rebuilt reviewed extensions, cleanup deletes a managed extension, a shields transition rejects or removes the reviewed peer link and leaves rollback incomplete, or a broader symlink allowance permits a link outside the exact reviewed boundaries.
Source boundary: `src/lib/state/openclaw-managed-extensions.ts`, `scripts/state-dir-guard.py`, NemoClaw snapshot validation/restore, and the reviewed OpenClaw image extension layout.
Source-fix constraint: upstream OpenClaw does not own NemoClaw snapshot archives or shields transitions, so the local boundary must enforce image ownership without following an external symlink target.
Regression tests: `src/lib/state/openclaw-managed-extensions.test.ts` pins the complete managed set, restore exclusions, exact link predicate, target validation, and cleanup preservation; `test/state-dir-guard.test.ts` proves preflight, lock, and unlock preserve only the exact peer link while rejecting wrong targets, source shapes, extension IDs, and non-OpenClaw roots; `test/snapshot.test.ts` and `test/security-sandbox-tar-traversal.test.ts` retain integration and traversal coverage; and the `messaging-providers` live rebuild now requires explicit complete post-restore success without a critical rollback warning.
Removal condition: retire the helper only when snapshot metadata records extension ownership structurally and the generic restore engine can exclude image-owned paths without an OpenClaw-specific policy.

### Slack Inbound `app_mention`

The external `@openclaw/slack@2026.6.9` package no longer needs to be treated as package-shape-only evidence. `test/e2e/live/messaging-providers-slack-runtime-proof.ts` discovers the installed external runtime files, imports the hashed pipeline runtime for `prepareSlackMessage`, imports the runtime API for `sendMessageSlack`, and only reports `openclaw-pipeline-runtime` after allowed prepare, denied prepare, bounded denied-user feedback, and fake Slack send evidence all pass. `test/e2e/live/messaging-providers.test.ts` additionally requires the captured `chat.postMessage` metadata to prove the expected channel and text, a successful host-token rewrite, and no unresolved placeholder without recording the raw token.

Invalid state: claiming `openclaw-pipeline-runtime` inbound proof without both checked-in import logic and fake Slack capture evidence. Current source boundary: `test/e2e/live/messaging-providers.test.ts`, `test/e2e/live/messaging-providers-slack-runtime-proof.ts`, and `test/e2e/lib/fake-slack-api.cjs`. Source-fix constraint: send-only `runtime-api.js` coverage is not enough for inbound authorization coverage. Regression detection: `test/e2e/support/messaging-providers-runtime-proofs.test.ts` syntax-checks the sandbox module and pins its installed-export, denied-prepare, single-feedback, and fake-send markers; the `messaging-providers` live job is the behavioral gate against the installed package. The retired `test/e2e/test-messaging-providers.sh` entrypoint and `test/e2e/lib/slack-api-proof.sh` remain historical implementation context only. The last pre-migration exact-head matrix remains historical runtime evidence; the migrated proof becomes fresh runtime evidence only when the post-merge exact-head `messaging-providers` job passes.

### Telegram Runtime Send

The bundled OpenClaw Telegram channel proof must use the current `dist/extensions/telegram/runtime-api.js` surface. `test/e2e/live/messaging-providers-telegram-runtime-proof.ts` fails closed if the installed runtime file is missing or if it stops exporting `sendMessageTelegram`, because falling back to the removed private `test-api.js` facade would make the 2026.6.9 package-shape proof stale.

Invalid state: a passing fake Telegram proof that imports `dist/extensions/telegram/test-api.js` or bypasses OpenClaw's installed runtime send helper. Current source boundary: `test/e2e/live/messaging-providers.test.ts`, `test/e2e/live/messaging-providers-telegram-runtime-proof.ts`, and `test/e2e/lib/fake-telegram-api.cjs`. Source-fix constraint: keep the host-side fake Telegram API, request-body credential rewrite policy, token rewrite assertion, chat/text capture, and placeholder-leak checks intact. Regression detection: `test/e2e/support/messaging-providers-runtime-proofs.test.ts` syntax-checks the sandbox module and pins `runtime-api.js`, `sendMessageTelegram`, and the fake-send boundary; the `messaging-providers` live job is the installed-runtime behavioral gate. The retired `test/e2e/test-messaging-providers.sh` entrypoint and `test/e2e/lib/telegram-api-proof.sh` remain historical implementation context only. The last pre-migration exact-head matrix remains historical runtime evidence; the migrated proof becomes fresh runtime evidence only when the post-merge exact-head `messaging-providers` job passes.

### Issue #4434 TUI Unreachable Inference

The #4434 migrated live guard in this version-bump PR is a full live acceptance guard for the reviewed NemoClaw/OpenShell runtime boundary. NemoClaw now applies `scripts/patch-openclaw-issue-4434-diagnostics.ts` after installing `openclaw@2026.6.9`; the script patches the reviewed `formatRawAssistantErrorForUi` dist shape to enrich sandbox-only `fetch failed` and `LLM request timed out.` TUI errors with:

- `Cause: fetch failed while reaching the upstream API.` or `Cause: timed out while reaching the upstream API.`
- `Reporting layer: gateway proxy / upstream API.`
- `Recovery hint: check sandbox egress and provider reachability, then retry.`

The enrichment is gated by `process.env.OPENSHELL_SANDBOX === "1"` and only matches the reviewed `fetch failed` or `LLM request timed out.` shapes. Non-sandbox OpenClaw output keeps upstream behavior, and already structured upstream output is preserved or completed without duplicating fields. The unpatched upstream `openclaw@2026.6.9` #4434 output remains accepted only as the source-level removal trigger: `test/issue-4434-error-fields.test.ts` verifies that the upstream-shaped timeout output is missing all three required acceptance fields while the NemoClaw-patched runtime output has all three. The migrated `test/e2e/live/issue-4434-tui-unreachable-inference.test.ts` guard fails unless the captured TUI output includes an HTTP status or cause, a gateway/upstream reporting layer, a recovery hint, a visible error, a recognizable final status line, and final `| error` status inside the default 180-second timeout.

Invalid state: the TUI returns to the spinner-plus-connected signature, the structured fields are missing from the captured live output, or the formatter patch applies outside the OpenShell sandbox boundary. Source boundary: OpenClaw TUI/chat error output captured by the #4434 live guard plus the reviewed assistant error formatter dist file patched by `scripts/patch-openclaw-issue-4434-diagnostics.ts`. Source-fix constraint: the durable source fix belongs upstream OpenClaw; this PR carries a fail-closed compiled-dist shim so the reviewed package satisfies the NemoClaw/OpenShell runtime acceptance contract now. Regression detection: `test/issue-4434-error-fields.test.ts` classifies the reviewed patched output and rejects the old partial output; `test/openclaw-issue-4434-diagnostics-patch.test.ts` verifies the patch behavior and selectors. Removal condition: remove the patch script and keep the full live assertions when upstream OpenClaw emits equivalent HTTP/cause, gateway/upstream layer attribution, and recovery hint fields directly.

Merge disposition for this OpenClaw 2026.6.9 bump: #4434 TUI unreachable-inference acceptance is code-backed for the reviewed `openclaw@2026.6.9` artifact via a NemoClaw compatibility shim. Release notes or merge context should describe that boundary precisely: this PR closes the NemoClaw runtime acceptance gap, while upstream OpenClaw still owns the permanent source-level diagnostic behavior.

### Microsoft Teams Live E2E Disposition

The Teams manifest is intentionally documented as experimental channel support. Full Teams onboarding and message round-trip proof requires a real Microsoft tenant, Bot Framework app credentials, an app password, allowed user object IDs, and a public HTTPS webhook that forwards to the sandbox `/api/messages` endpoint. Those prerequisites cannot run in default PR CI without tenant-owned secrets and public ingress.

No real Microsoft Teams tenant proof is included in this PR. The work remains tracked as a follow-up outside this dependency bump: provision tenant-owned credentials and ingress, originate an authenticated Bot Framework activity from the tenant, observe the sandbox reply in Teams, and retain sanitized evidence. Until that proof exists, manifest rendering, package-integrity checks, local port-forward tests, or replaying a captured activity must not be described as a Teams round trip or counted as Teams runtime proof.

### Release Checklist for Accepted Residual Risk

- [x] OpenClaw real patched-dist harness: main CI runs it automatically from trusted merged code, while `NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1 npx vitest run --project integration test/openclaw-real-patched-dist-harness.test.ts` remains the explicit PR/local proof. It is intentionally not a PR check because PR-authored harness code cannot serve as its own trusted security gate.
  It materializes the reviewed tarball, verifies SRI, applies the Dockerfile patch block, and audits chat-send/get-reply/followup-runner markers.
  Before merge, keep exact-head CI image builds plus focused/full E2E workflow proof as the runtime evidence boundary.
- [x] Issue #4434 full live acceptance: `scripts/patch-openclaw-issue-4434-diagnostics.ts` enriches the reviewed OpenClaw formatter for sandbox-only `fetch failed` and `LLM request timed out.` errors, and the migrated `test/e2e/live/issue-4434-tui-unreachable-inference.test.ts` guard requires HTTP/cause, gateway/upstream layer attribution, and a recovery hint.
- [x] Future #4434 upstream-removal trigger: on the next relevant OpenClaw bump, rerun `test/openclaw-issue-4434-diagnostics-patch.test.ts` and the real patched-dist harness. If upstream emits equivalent fields directly, remove the shim while preserving full live assertions.

### Advisor Disposition

- The #4434 compatibility-shim disposition is explicitly accepted for this OpenClaw 2026.6.9 PR only: `test/issue-4434-error-fields.test.ts` verifies 3/3 fields are present in the NemoClaw-patched runtime output and 3/3 fields are missing in the upstream-shaped `openclaw@2026.6.9` output. On the next OpenClaw bump that emits equivalent fields upstream, remove `scripts/patch-openclaw-issue-4434-diagnostics.ts` in the same change and keep the full live assertions.
- The transitive npm graph warning is dispositioned by package evidence rather than a new NemoClaw-owned lockfile in this dependency bump: the reviewed OpenClaw runtime and `@openclaw/*` plugin artifacts ship package-internal `npm-shrinkwrap.json` files with integrity metadata, `@zed-industries/codex-acp@0.11.1` has no npm dependency tree, and the only reviewed non-shrinkwrapped plugin is the pre-existing Tencent WeChat package whose top-level SRI is now enforced. A future installer-policy PR should add a NemoClaw-owned lock/audit gate for third-party messaging plugins without package-internal shrinkwraps.
- `src/lib/messaging/channels/manifests.test.ts` remains below the shared `test-size:check` threshold and does not need extraction in this dependency bump.
- The npm audit result in this note is a manual snapshot for the reviewed lock-only graph. It is not a new CI gate; rerun the command in the Advisory Check section on the next OpenClaw/plugin bump or if npm advisory state changes before merge. Follow-up automation should add a CI job for `npm install --package-lock-only --ignore-scripts && npm audit --omit=dev --json` on the reviewed OpenClaw/plugin graph.
- The stale nonterminal rebuild-resume repair in `src/lib/actions/sandbox/rebuild-resume-session.ts` remains a migration compatibility shim tracked against #4533's onboard FSM/resume compatibility boundary. Its removal condition is to delete it after a session-version migration proves recreate sessions are always persisted at a resumable pre-sandbox boundary; `src/lib/actions/sandbox/rebuild-resume-session.test.ts` covers the helper directly, `test/onboard-resume-provider-recovery.test.ts` carries the onboard-suite producer-level regression for `machine.state='openclaw'`, and `src/lib/actions/sandbox/rebuild-resume-snapshot.test.ts` owns the rebuild handoff regression.
- Production OpenClaw image build paths call `scripts/check-production-build-args.sh` before production `docker build` or `docker/build-push-action` use. `test/openclaw-dependency-review.test.ts` keeps that workflow contract documented.
- The rebuild-reasoning cases added by this PR live in the focused `rebuild-resume-reasoning.test.ts` file; the smaller route-provenance additions remain with their `rebuild-resume-config.ts` boundary tests.
- `src/lib/state/sandbox.ts` is 100 lines smaller than current `main` in this PR. Managed-extension policy, restore exclusions, symlink predicates, and cleanup construction now live in `openclaw-managed-extensions.ts`; further decomposition of unrelated snapshot orchestration is outside this dependency bump.
- The shared archive-installer redesign remains explicitly deferred to issue #5896 section 2. Consolidating the reviewed archive helper would change the Codex ACP, OpenClaw core, base-image, optional-plugin, and messaging installation boundaries together; the named all-boundary parity contract keeps each copy on the same common security matrix until that focused cross-installer migration lands.
- Legacy Slack fixture retirement and broader setup/test refactors also remain deferred to #5896. The default 2026.6.9 lane cannot use the legacy helper; only an explicitly flagged isolated fixture can reach it.
- `isAllowedStateSymlink` has direct source- and target-traversal vectors in `openclaw-managed-extensions.test.ts`, in addition to the snapshot/tar traversal integration suites.
- Live gateway display output is treated as untrusted text: `gateway-provider-metadata.ts` bounds the complete output and each field, strips terminal decoration, requires one complete syntax-safe schema with unique environment-style binding keys, and returns only the exact requested provider. Recovery then requires exactly one expected credential key and endpoint-config key. Partial, oversized, duplicated, malformed, or ambiguous output fails closed in focused parser tests.
- Retained older OpenClaw pins are inactive compatibility/rollback branches, not the production default. Before every production image build, the production guard rejects the fixture flag, both legacy version values, and all four fixture-only integrity/tarball overrides; the Dockerfile then fails closed unless the selected version has a committed SRI and reviewed tarball URL. Issue #5896 section 9 retires this compatibility branch and guard together.
- The #4434 patch uses the SRI-verified `openclaw@2026.6.9` artifact, fails closed on unknown or ambiguous formatter shapes, and is applied/audited against the real distribution in CI. A second generated-file hash allowlist would duplicate the package SRI plus shape audit and is deferred unless a future patch can no longer identify one unambiguous formatter boundary.
- Each OpenClaw `messaging-build-applier.mts --agent openclaw` Dockerfile phase receives `OPENCLAW_VERSION="${OPENCLAW_VERSION}"` from the Dockerfile build arg before rendering or installing messaging plugins.
- The integrity pin, messaging render-safety, and provider-recovery follow-ups are covered by `test/openclaw-integrity-pin.test.ts`, `test/messaging-build-applier-render-safety.test.ts`, and `test/onboard-resume-provider-recovery.test.ts`.
