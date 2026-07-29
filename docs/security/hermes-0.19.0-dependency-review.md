<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes 0.19.0 dependency and compatibility review

Review date: 2026-07-28

## Decision

Pin the NemoClaw Hermes runtime to the published, non-draft, non-prerelease `v2026.7.20` release, whose package version is `0.19.0`.
This replaces `v2026.7.1` and covers all three adjacent stable release ranges, including the four-component `v2026.7.7.2` tag.

The upgrade is acceptable only with the downstream migrations recorded in this review.
NemoClaw preserves manual command approval instead of inheriting Hermes 0.19's new smart-approval default, emits configuration schema 33, recognizes the new one-shot flags and `console` subcommand, and backs up the new default-profile cron and Discord recovery SQLite ledgers online.
Named-profile copies remain inside the raw `profiles` directory capture under the existing generic snapshot limitation; this bounded residual is recorded rather than described as online backup.
The gateway-runtime-metadata, session-preview, Langfuse-placeholder, managed-light-skin, provider-routing, and resumed-one-shot workarounds remain necessary against the target source and retain exact-shape guards.

The selected Python graph introduces no package-level advisory or license regression relative to `v2026.7.1`.
The review nevertheless found that both versions resolve `python-multipart==0.0.27`, which is affected by a network-reachable CPU denial of service and parser differential.
The final image therefore replaces that lock resolution with the hash-verified and attested `python-multipart==0.0.32`.

The source-pin commit must publish a fresh multi-platform Hermes base image before the final Dockerfile can name its immutable digest.
The PR is not approval-ready until the pinned final image and required live E2E gates pass on the exact PR head.

## Reviewed identities

| Identity | Value |
| --- | --- |
| Current release | `v2026.7.1` / `0.18.0` |
| Current source commit | `7c1a029553d87c43ecff8a3821336bc95872213b` |
| Target release | `v2026.7.20` / `0.19.0` |
| Target annotated tag object | `c7d08de287556b3d339df336b180a39d4980ebd7` |
| Target source commit | `3ef6bbd201263d354fd83ec55b3c306ded2eb72a` |
| Target source archive SHA-256 | `285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990` |
| Target npm cross-check integrity | `sha512-+oVKG3lXbk2kEP+J6BXZjtmSBSaFfczIdOWQ9CUSTdTqq2uyHbk4p+kPyZ6MeGs56JU5qXzMNbqGKRVOQRGC1A==` |
| Target PyPI wheel SHA-256 | `bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f` |
| Target PyPI source distribution SHA-256 | `ac986bede64a2785436676c0ea084ec586574f8cb00a9d047e095b435d3e21c0` |
| Target publish date | `2026-07-20` |

The authoritative source release is `NousResearch/hermes-agent` tag `v2026.7.20`.
GitHub reports the annotated tag and peeled commit as verified.
The successful producer runs are CI `29768400292`, PyPI publication `29768427462`, and Docker publication `29768440304`.
The first site-deployment attempt failed and a manual retry succeeded, but NemoClaw does not consume the site artifact.

PyPI Trusted Publisher attestations bind both `hermes-agent==0.19.0` artifacts to the target repository and source commit.
NemoClaw builds from the SHA-256-pinned GitHub source archive rather than installing those PyPI artifacts.
The `hermes-agent` npm package is published from a different bridge repository and is only an independent registry-integrity cross-check.

## Complete source range ledger

| Adjacent range | Commits | Changed files | NemoClaw-relevant result |
| --- | ---: | ---: | --- |
| `v2026.7.1` (`7c1a029`) to `v2026.7.7` (`f9eca7e`) | 710 | 994 | Broad runtime, messaging, UI, tool, and configuration work requires downstream contract review rather than a selector-only bump. |
| `v2026.7.7` (`f9eca7e`) to `v2026.7.7.2` (`9de9c25`) | 2 | 6 | The WhatsApp bridge replaces Git-based Baileys and libsignal resolutions with integrity-bound registry packages. |
| `v2026.7.7.2` (`9de9c25`) to `v2026.7.20` (`3ef6bbd`) | 1,687 | 1,932 | Schema 33, approval defaults, CLI flags, SQLite ledgers, MCP names, messaging, and package graph changes cross active NemoClaw contracts. |

The complete adjacent range contains 2,399 source commits.
The upstream release-note estimate is not used as the audit boundary.
Python remains `>=3.11,<3.14`, and the JavaScript runtime remains Node `>=20`, so NemoClaw's Python 3.13 and Node 22 image floors remain compatible.

## Semantic migration and retained workarounds

Hermes 0.19 changes an omitted approval mode from manual authorization to smart authorization, which can consult an auxiliary model before authorizing a flagged command.
NemoClaw now writes `approvals.mode: manual` explicitly so an authorization-policy change requires its own product and security decision.

Hermes 0.19 also makes the `browser_console(expression=...)` sensitive-primitive denylist opt-in through `browser.restrict_evaluate`, defaulting it to `false`.
The outgoing release restricted cookies, storage, clipboard, form values, and network primitives unless a user explicitly enabled unsafe evaluation.
Because NemoClaw exposes the browser toolset, generated configuration now writes `browser.restrict_evaluate: true` to preserve that fail-closed posture; broadening page-context JavaScript evaluation requires a separate security decision.

Hermes 0.19 changes the omitted gateway session-reset policy from `both` (daily and idle expiry) to `none`.
Generated configuration now writes the complete outgoing policy—`mode: both`, 04:00 daily reset, 1,440-minute idle reset, notifications except on API server and webhook, and a 24-hour background-process age bound—so the upgrade does not silently make gateway sessions indefinitely durable or leave the remaining policy to mutable dependency defaults.

Hermes 0.19 also changes `display.show_reasoning` from `false` to `true`.
Generated configuration now writes `display.show_reasoning: false` so internal reasoning is not newly disclosed through user-visible channel output.
The release also introduces a visible commentary channel that defaults on; NemoClaw writes `display.show_commentary: false` so enabling that new output surface remains a separate product decision.

Hermes 0.19 changes `updates.pre_update_backup` from disabled to a quick state snapshot and adds automatic CUA-driver refresh after self-update.
NemoClaw updates Hermes through reviewed, immutable sandbox images rather than in-place dependency self-update, so generated configuration explicitly disables both state duplication and the new mutable secondary download.

Fresh `hermes profile create <name>` homes intentionally omit `config.yaml`, so generated default-home and dashboard configuration alone cannot preserve these policies for every Hermes execution context.
The final image therefore carries a hash-bound, exact-source patch for the pinned `v2026.7.20` config, classic-CLI config copy, raw browser-policy loader, TUI raw-YAML fallbacks, agent commentary fallbacks, update-command fallbacks, and gateway policy.
It pins the same approval, browser, display, update, and complete session-reset defaults for config-less named or ad-hoc homes, while the generated default and dashboard configs remain explicit defense in depth.
The image build creates a real fresh named profile, proves it remains config-less, and exercises the installed default, classic-CLI, browser, TUI, agent-commentary, update-command, and gateway policy paths against that home, including a forced config-load error for pre-update backup resolution.

Hermes configuration schema moves from 32 to 33.
The final image runs `hermes doctor --fix` before writing NemoClaw's generated configuration, so the generator and its hash contract now emit schema 33 directly.

The target CLI adds the `console` subcommand, the value flag `--usage-file`, and the boolean flag `--no-restore-cwd`; this migration also closes the wrapper's pre-existing `--safe-mode` allowlist gap. Hermes 0.19 writes `--usage-file` reports only on its native one-shot path, so the NemoClaw wrapper rejects the narrower resumed/continued one-shot combination that it must translate to `chat --query`; accepting that combination would silently omit the requested report.
The resumed-one-shot wrapper now recognizes those boundaries, global profile selectors, bare continue, and Hermes' exact preprocessing boundary set for unquoted multi-word session names across all four continue/resume spellings before translating session arguments, and still fails closed for an unknown future shape.

The target source still contains all six session-list queries whose preview must reflect the latest resumed or continued one-shot turn.
The session-preview patch remains exact-count guarded.
The target Langfuse plugin still validates credentials before the OpenShell resolver can supply them, so its narrowly bounded placeholder patch remains exact-source guarded.
The managed light-skin source boundary is also unchanged for NemoClaw's selected terminal environment.

Hermes 0.19 records default-profile cron execution history in `cron/executions.db` and Discord replay state in `gateway/discord_message_recovery.db`.
Both default-profile files use SQLite online backup and restore.
The cron directory remains a state-directory contract for job definitions, and the later online database copy deliberately replaces its potentially inconsistent raw directory copy.
WAL and SHM files are omitted and removed on restore.
This cleanup is required even after a read-only online backup because opening a WAL-mode source can materialize sidecars owned by the backup identity; leaving those `0640` sidecars in place makes the producer's restored database appear read-only.

Both ledgers follow the active `HERMES_HOME`.
When a gateway or cron process is launched with a named profile home, the corresponding files live below `profiles/<name>/`.
NemoClaw preserves `profiles` as a state directory, so those named-profile databases are captured by tar rather than by SQLite's online backup API and can be inconsistent if written during a rebuild snapshot.
This is an upgrade-created instance of the existing generic named-profile database limitation, not a new credential or authorization boundary.
The cron ledger is an audit history rather than a retry queue; an inconsistent Discord recovery ledger can lose or repeat reconnect bookkeeping.
Supporting dynamic profile-local SQLite discovery safely requires generic path enumeration, validation, backup, and restore work outside this dependency-upgrade scope.
Both default-profile ledgers cross two runtime identities: `gateway` creates and reopens them under the gateway's `0007` umask, while `sandbox` performs snapshot backup and atomic restore.
The image therefore maintains both parents as `gateway:sandbox` mode `2770`.
Hermes' ordinary SQLite creation produces the live cron database as `gateway:sandbox` mode `0640`, which gives `sandbox` the read access needed for online backup; the sandbox-owned restored replacement is explicitly mode `0660` so `gateway` can reopen it.
Discord instead forces its live database to `0600`, so NemoClaw exact-source patches that upstream chmod to `0660`.
Build probes use the real cron and Discord APIs to prove gateway creation, sandbox read/online-backup/replacement, and gateway reopen/write against each restored file.

Base SHA `fa96c91f` contributes the workaround that moves gateway PID, lock, and runtime-status files below the writable `HERMES_HOME/runtime` directory.
Hermes 0.19 retains the top-level paths but changes their home selector from `get_hermes_home()` to `_get_process_hermes_home()` so profile-context tasks cannot redirect process-owned gateway metadata.
The upgrade retargets the exact-source patch to that target shape and preserves the process-scoped selector while relocating the three central metadata helpers used by NemoClaw's managed default gateway.
The final image hash-binds the patcher and probes those installed PID, lock, and status helpers against the writable runtime directory.

The inherited workaround is not a complete upstream metadata migration.
Hermes still force-unlinks a top-level PID during direct `gateway run --replace`, keeps planned-stop and takeover markers at the top level, and has explicit top-level PID or status readers in named-profile, multiplexer, service-manager, web, container-boot, Windows, backup, and upstream Docker paths.
Those same direct-consumer gaps exist in base SHA `fa96c91f`'s Hermes 0.18 patch, so the 0.19 retarget does not regress NemoClaw's managed default-gateway lifecycle.
Under shields-up, direct Hermes replacement or stop and named-profile lifecycle commands can nevertheless fail or observe stale state.
NemoClaw uses plain `gateway run` plus its host-owned managed stop/start recovery; the protected managed-restart E2E proves only that supported path.
Completing the upstream relocation requires a separate exact-source audit and runtime matrix for every explicit consumer rather than extending this dependency upgrade's claim.

The target MCP tool names use the `mcp__server__tool` shape.
Progressive disclosure and the managed MCP bridge therefore require exact-head runtime proof rather than inference from the image build.
New optional upstream secret sources are not enabled by NemoClaw.
The wrapper recognizes the reviewed `--safe-mode` CLI flag without adding a new sandbox-generated environment variable or broadening NemoClaw's environment allowlist.

## Dependency closure, licenses, and advisories

The selected `anthropic messaging web pty mcp` Python graph contains 88 third-party packages.
Relative to `v2026.7.1`, the target lock changes only `slack-bolt` from `1.27.0` to `1.29.0` and `slack-sdk` from `3.40.1` to `3.43.0`.
Both changed packages remain MIT licensed.

The final image also replaces `python-multipart==0.0.27` with `0.0.32`.
The reviewed artifacts are the source distribution at `be54b7f3fa167bb83e4fcd936b887b708f4e57fe75911c02aebf53efaf8d938e` and wheel at `ff6d3f776f16878c894e52e107296ffc890e913c611b1a4ec6c44e2821fe2e23`.
Their PyPI Trusted Publisher attestations bind Apache-2.0 artifacts to `Kludex/python-multipart`, `.github/workflows/publish.yml`, tag `0.0.32`, verified commit `238ead62a0bb6f6cdfe122708faa13812f59f9a6`, and successful run `26963211769`.
The override clears `GHSA-5rvq-cxj2-64vf`, `GHSA-6jv3-5f52-599m`, and `GHSA-v9pg-7xvm-68hf`.
A Python 3.13 FastAPI `TestClient` probe covered ordinary forms, file upload, and dense CRLF input with the replacement parser.

The resulting point-in-time Python audit contains 37 database records representing 29 unique advisories in nine packages.
The unique set is 19 high, seven medium, three low, and zero critical.
Every remaining record is also present in the selected `v2026.7.1` graph.

Two pre-existing high-severity package groups remain plausibly reachable and must stay visible as baseline debt.
Pillow `12.2.0` parses user-provided images and has parser advisories fixed in `12.3.0`.
Starlette `1.0.1` parses form requests for Hermes FastAPI `Form` and `File` routes and has a URL-encoded form denial of service fixed in `1.3.1`.
These findings are not introduced by this release, but the final review must not describe the complete image as vulnerability-free.
Hermes pins both affected versions exactly in `pyproject.toml`, so post-sync replacements would violate the installed distribution metadata.
Dependency-coherent remediation requires an upstream constraint change, regenerated `uv.lock`, and wider image, web, MCP, and parser validation rather than an untracked `uv pip install --no-deps` overlay in this PR.
Exploratory compatibility evidence is promising: Pillow `12.3.0` passes all 97 upstream image-routing tests, and FastAPI `0.133.1` with Starlette `1.3.1` and multipart `0.0.32` passes a real form and upload `TestClient` smoke.
That exploratory evidence does not replace an upstream-aligned hardening change.

The remaining high records have evidence-backed exclusions from currently enabled Hermes paths.
Hermes-owned MCP servers use stdio and do not enable authenticated stateful HTTP, custom WebSocket servers, or MCP tasks.
Telegram uses HTTPX outbound requests and polling by default rather than Tornado's affected HTTP client and decompression paths.
No Hermes call to `click.edit()` or PKCS#7 and S/MIME verification was found.

The final root JavaScript runtime graph remains `agent-browser@0.26.0` plus the existing Streamdown tree and reports zero production audit findings.
The TUI and web workspaces retain unchanged high package-level findings in build-only dependencies whose `node_modules` directories are deleted after compilation.
The React Router record is limited to React Server Components, while Hermes uses `BrowserRouter`.

The WhatsApp bridge moves Baileys from a Git commit dependency to integrity-bound `@whiskeysockets/baileys@7.0.0-rc13` and moves libsignal to integrity-bound `libsignal@6.0.0`.
This removes both Git resolutions and improves reproducibility.
The current RC9 bridge graph reports one critical, three high, two medium, and one low affected package entry.
The RC13 transition removes the critical `GHSA-qvv5-jq5g-4cgg` protocol-message spoof and state-corruption exposure plus every high and medium entry, leaving only one low `body-parser` finding in the target bridge.
The `sharp` move from `0.34.5` to `0.35.3` and the native bridge still require amd64 and arm64 pairing, send, and receive proof.

No new copyleft or restrictive license enters the selected graph.
The GPL-3.0 libsignal package, Apache-2.0 sharp package, and LGPL libvips artifacts already exist in the current bridge, so their existing obligations persist.
The target source archive does not publish a complete SBOM, and a lock-derived SBOM alone would be inaccurate because the final image intentionally replaces the multipart resolution.
Artifact scanning must therefore inspect the assembled image and record the downstream override.

## Concern ledger

| ID | Severity | Disposition | Evidence and remaining gate |
| --- | --- | --- | --- |
| `HERMES-1` | High | Pin and test | The verified target tag, commit, source SHA-256, CalVer-to-semver mapping, registry cross-check, and producer runs are recorded, while final source-pin coherence remains an exact-head test. |
| `HERMES-2` | High | Migrate and test | `approvals.mode` is explicitly `manual`, and generated-config tests reject inheritance of smart authorization. |
| `HERMES-3` | High | Migrate and test | Generated configuration and the doctor hash contract use schema 33 before runtime startup. |
| `HERMES-4` | High | Migrate and test | Wrapper routing covers `console`, `--no-restore-cwd`, and `--safe-mode`; it preserves profile selectors, bare continue, and unquoted multi-word names against Hermes' exact coalescing boundaries across all four continue/resume spellings, and recognizes and explicitly rejects `--usage-file` only when the resumed one-shot append workaround would otherwise discard the report. The final image compares the wrapper's private session-name boundary AST to the pinned upstream coalescer instead of deriving it from public help. Unknown future versions remain guarded. |
| `HERMES-5` | Medium | Guard and test | Every retained compatibility patch was compared with target source, retargeted, hash-bound, and exercised by a focused regression or image smoke probe. |
| `HERMES-6` | High | Migrate, test, and runtime-proof | Default-profile cron and Discord ledgers use online SQLite backup with nested-parent and overlapping-directory tests. Both bind their cross-UID contract to `gateway:sandbox` `2770` parents, descriptor-safe startup repair, and gateway-to-sandbox-to-gateway image probes. Cron's live source is group-readable `0640` and its restored replacement is `0660`; Discord additionally needs its guarded `0660` upstream chmod patch. Rebuild persistence remains a live E2E gate. |
| `HERMES-7` | High | Test and runtime-proof | The target's `mcp__server__tool` names are compatible by source inspection, while managed-tool discovery and invocation remain a live E2E gate. |
| `HERMES-8` | High | Guard and runtime-proof | Optional upstream secret sources stay disabled, `--safe-mode` does not broaden the generated environment allowlist, and the live environment boundary must reject raw credentials. |
| `HERMES-9` | High | Pin and test | The selected Python delta adds no advisory regression, and the affected multipart parser is replaced with attested `0.0.32` plus hash and runtime probes. |
| `HERMES-10` | High | Document and review | Reachable Pillow and Starlette advisory debt predates the target and is not worsened by it, but it remains explicit baseline debt for security disposition rather than a zero-finding audit claim. |
| `HERMES-11` | High | Migrate, test, and runtime-proof | Root npm audit reports zero production findings and the WhatsApp bridge removes its current critical, high, and medium advisory entries, while both architectures still require native bridge and message-path evidence. |
| `HERMES-12` | High | Pin and runtime-proof | Trusted workflow run `30411365314` published the exact source commit as amd64 and arm64 manifests under OCI index `sha256:c4aee5c9b087840da6e1eb2127fef9f4a2eab0862992008d1741dc09f632422e`. The final Dockerfile pins that digest, and the pinned arm64 final image passes all 62 BuildKit steps, including installed-version, patch, config, and cross-identity SQLite probes. Protected runtime E2E remains. |
| `HERMES-13` | Medium | Document bounded residual | Static `state_files` entries online-back up the default profile only. Cron or Discord ledgers created by a process launched under `profiles/<name>` remain in the raw `profiles` tar capture and can be inconsistent during a concurrent snapshot. Dynamic profile-local SQLite discovery is generic snapshot work outside this upgrade PR. |
| `HERMES-14` | High | Migrate and test | The browser evaluation denylist changed from default-on to opt-in. Generated configuration explicitly writes `browser.restrict_evaluate: true`, including when managed browser-gateway settings are merged, so the upgrade does not broaden page-context access. |
| `HERMES-15` | Medium | Migrate and test | The omitted gateway session-reset policy changed from bounded daily and idle expiry to no automatic reset. Generated configuration explicitly writes the complete outgoing reset and notification policy to preserve the retention bound without inheriting mutable dependency defaults. |
| `HERMES-16` | High | Migrate and test | The reasoning-display default changed from hidden to visible, and commentary is a new default-visible output channel. Generated configuration explicitly disables both so the upgrade does not broaden disclosure in user-visible channels. |
| `HERMES-17` | High | Migrate and test | In-place update now defaults to duplicating state and refreshing a mutable CUA driver. NemoClaw's immutable image workflow owns dependency updates, so generated configuration explicitly disables both side effects. |
| `HERMES-18` | High | Migrate and test | Fresh named profiles omit `config.yaml`, so generated pins do not cover every `HERMES_HOME`. The final image hash-binds the exact `v2026.7.20` config, classic-CLI config copy, raw browser-policy, TUI raw-YAML, agent-commentary, update-command, and gateway-policy sources, patches their fail-safe defaults, and creates a real config-less profile to exercise all affected installed loaders. |
| `HERMES-19` | High | Migrate and test | The dashboard has an isolated `HERMES_HOME`, so its allowlisted routing and policy mirror is a startup security boundary. A missing gateway config remains a benign cold-start no-op, while malformed, non-mapping, unreadable, or routing-free source config and invalid existing dashboard config fail startup without changing stale dashboard bytes. Sanitized errors never include raw PyYAML parser context or credential-bearing source lines. |
| `HERMES-20` | High | Retarget, guard, test, and runtime-proof | Base SHA `fa96c91f` adds a Hermes 0.18 gateway-runtime-metadata patch whose central helper shape does not match Hermes 0.19. The retargeted exact-source guard preserves `_get_process_hermes_home()` while moving the managed default gateway's central PID, lock, and status helpers below `runtime`, hash-binds the patcher, and adds unit and final-image probes. The managed-gateway restart E2E remains the PR SHA runtime gate. |
| `HERMES-21` | Medium | Document inherited bounded residual | The base workaround does not retarget direct upstream `--replace` cleanup, planned-stop/takeover markers, named-profile and multiplexer readers, service/boot/web/Windows consumers, or upstream backup and Docker paths. Under shields-up those direct paths can fail or observe stale state, but the same limitation exists on base SHA `fa96c91f`; the 0.19 selector retarget adds no regression to NemoClaw's supported host-managed default-gateway lifecycle. A complete relocation needs separate exact-source patches and runtime proof for every explicit consumer. |

Unresolved upgrade-created high-impact concerns: `0`.
One Medium upgrade-created instance of the pre-existing named-profile raw-capture limitation and one inherited Medium direct-runtime-consumer limitation remain explicitly accepted for this upgrade scope.

The remaining exact-head gates are repository CI, automated review, documentation review, security review, and protected Hermes E2E.
The reachable pre-existing Pillow and Starlette debt also requires an explicit security-review disposition before merge.

## Verification and remaining gates

Completed local evidence:

- authoritative stable-release, tag, source-commit, producer-run, PyPI-attestation, and registry-integrity checks;
- three adjacent stable ranges and 2,399 source commits reviewed;
- current and target Python closures, JavaScript locks, licenses, and point-in-time advisories compared;
- target source comparison for configuration, wrapper, patches, state, MCP, messaging, and secret boundaries;
- focused generated-config, wrapper, patch, default-profile state-manifest, and skill contract tests;
- Python 3.13 multipart compatibility probes;
- a no-cache arm64 Hermes base-image build;
- trusted amd64 and arm64 branch-image publication plus immutable OCI-index inspection; and
- a 62-step arm64 final-image build from the pinned branch digest, including private wrapper-boundary and cross-identity SQLite probes.

Before merge, the exact PR head must still pass:

- managed MCP discovery and invocation;
- messaging, environment-secret, restart, snapshot, rebuild, and rollback E2E paths;
- normal repository checks with no unresolved actionable automated-review finding; and
- documentation-writer and security-review receipts tied to the final pushed head.
