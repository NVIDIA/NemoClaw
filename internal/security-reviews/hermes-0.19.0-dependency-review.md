<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes 0.19.0 dependency and compatibility review

> Internal engineering evidence. This file is not part of the public documentation set.

Review date: 2026-07-30

Issue `#8087` review date: August 2, 2026.

Python security refresh date: August 3, 2026.

ACP packaging review date: August 20, 2026.

## Decision

Pin the NemoClaw Hermes runtime to the published, non-draft, non-prerelease `v2026.7.20` release, whose package version is `0.19.0`.
This replaces `v2026.7.1` and covers all three adjacent stable release ranges, including the four-component `v2026.7.7.2` tag.

The upgrade is acceptable only with the downstream migrations recorded in this review.
NemoClaw preserves manual command approval instead of inheriting Hermes 0.19's new smart-approval default and emits configuration schema 33.
It uses a versioned CLI adapter for the two required translations, passes unrelated commands through, and backs up the new default-profile cron and Discord recovery SQLite ledgers online.
Named-profile copies remain inside the raw `profiles` directory capture under the existing generic snapshot limitation; this bounded residual is recorded rather than described as online backup.
The gateway-runtime-metadata, session-preview, Langfuse-placeholder, managed-light-skin, provider-routing, and resumed-one-shot workarounds remain necessary against the target source and retain exact-shape guards.

The selected Python graph is hardened before installation with a reviewed, exact-source patch that updates the published dependency metadata and frozen lock together.
The patched base image selects `aiohttp==3.14.3`, `cryptography==50.0.0`, `mcp==1.28.1`, `Pillow==12.3.0`, `starlette==1.3.1`, and `tornado==6.5.7`.
The base image build runs `uv pip check` and separately checks those installed versions.
The Hermes sandbox image build checks `aiohttp==3.14.3` and `cryptography==50.0.0` after messaging package installation, and separately requires `agent-client-protocol==0.9.0` plus the ACP SDK and adapter imports inherited from the base.
The checks run when `NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION` is `0` or `1`.
The Hermes sandbox image build fails if any selected dependency or import is unavailable.
The base image also replaces the published `python-multipart==0.0.27` lock resolution with the hash-verified and attested `python-multipart==0.0.32`.
The base image overlays checksum-pinned Node.js `24.18.1` archives for both supported architectures and installs exact uv `0.11.33`; build-time assertions reject version drift before Hermes is installed.

The ACP decision in this change is limited to installing Hermes' existing `acp` extra and proving the pinned SDK and adapter imports are available.
`hermes acp --check` is an import-readiness check; it does not validate protocol sessions, editor compatibility, workspace or current-working-directory mapping, file and terminal permissions, or transport and authorization behavior.
Those integration behaviors require separate product acceptance and end-to-end evidence before NemoClaw can describe them as supported.

The `BASE_IMAGE` argument in `agents/hermes/Dockerfile` pins the patched multi-platform Open Container Initiative (OCI) index `sha256:212de47e723e9fec1e697d4eec1db82af2d0fb7802aade4fa5dfc3f05274d3c5`.
GitHub Actions workflow `.github/workflows/base-image.yaml` run `32413658315`, attempt 1, built and published that ACP-enabled base image from source commit `a42a7717c8e2d13c0c16465f8d06b6aab1e86cb3`.
It supersedes index `sha256:ffafa4dd1d8d5a802ae4fc4005b51e1accfa5e782e47de736a0d8d8bf2c83837`, which workflow run `31717470863`, attempt 1, published from source commit `d243ea62509bae7832a23fe8636e947303c19c60`.
That superseded index had replaced index `sha256:4295138eb70f938189430f8dc7b3cd5db0aa762234e64e398a6a5ef60803126c`, which workflow run `31636995117`, attempt 1, published from source commit `7c721ae4d60fd54e11f4d0c7d0482ccd6ac8cded`.
That superseded index had replaced index `sha256:3d54b928baef9df403227e846f73079d13ca8424a27cd5268ca97bac3f030b27`, which workflow run `31031662054`, attempt 1, published from source commit `a7a7f3e470a75c404d316d2054445e16bb63b48c`.
Both platform base-image jobs completed successfully.
The native package step ran the exact `dpkg` assertions for `vim-common=2:9.2.0858-1`, `vim-tiny=2:9.2.0858-1`, and `libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2`.
The feature-branch base publication intentionally skipped the final multi-platform managed-image publisher.
Pull request workflow run `32415993531`, attempt 1, separately built, direct-started, and published an exact digest-only `linux/amd64` capability-union candidate; its package inventory is recorded below.
An ACP-enabled final multi-platform managed-image cohort remains a post-merge publication gate.
The required live end-to-end (E2E) checks remain an approval gate.

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
| Target Node.js release | `24.18.1` |
| Target uv release | `0.11.33` |
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
Python remains `>=3.11,<3.14`, and the JavaScript runtime remains Node.js `>=20`, so NemoClaw's Python 3.13 and checksum-pinned Node.js 24.18.1 runtime remain compatible.

## Semantic migration and retained workarounds

Hermes 0.19 changes an omitted approval mode from manual authorization to smart authorization, which can consult an auxiliary model before authorizing a flagged command.
NemoClaw now writes `approvals.mode: manual` explicitly so an authorization-policy change requires its own product and security decision.

Hermes 0.19 also makes the `browser_console(expression=...)` sensitive-primitive denylist opt-in through `browser.restrict_evaluate`, defaulting it to `false`.
The outgoing release restricted cookies, storage, clipboard, form values, and network primitives unless a user explicitly enabled unsafe evaluation.
Because NemoClaw exposes the browser toolset, generated configuration now writes `browser.restrict_evaluate: true` to preserve that fail-closed posture; broadening page-context JavaScript evaluation requires a separate security decision.

Hermes 0.19 changes the omitted gateway session-reset policy from `both` (daily and idle expiry) to `none`.
Generated configuration now writes the complete outgoing policy: `mode: both`, 04:00 daily reset, 1,440-minute idle reset, notifications except on API server and webhook, and a 24-hour background-process age bound.
This prevents the upgrade from silently making gateway sessions indefinitely durable or leaving the remaining policy to mutable dependency defaults.

Hermes 0.19 also changes `display.show_reasoning` from `false` to `true`.
Generated configuration now writes `display.show_reasoning: false` so internal reasoning is not newly disclosed through user-visible channel output.
The release also introduces a visible commentary channel that defaults on; NemoClaw writes `display.show_commentary: false` so enabling that new output surface remains a separate product decision.

Hermes 0.19 changes `updates.pre_update_backup` from disabled to a quick state snapshot and adds automatic CUA-driver refresh after self-update.
NemoClaw updates Hermes through reviewed, immutable sandbox images rather than in-place dependency self-update, so generated configuration explicitly disables both state duplication and the new mutable secondary download.

Fresh `hermes profile create <name>` homes intentionally omit `config.yaml`, so generated default-home and dashboard configuration alone cannot preserve these policies for every Hermes execution context.
The Hermes sandbox image therefore carries a hash-bound, exact-source patch for the pinned `v2026.7.20` config, classic-CLI config copy, raw browser-policy loader, TUI raw-YAML fallbacks, agent commentary fallbacks, update-command fallbacks, and gateway policy.
It pins the same approval, browser, display, update, and complete session-reset defaults for config-less named or ad-hoc homes, while the generated default and dashboard configs remain explicit defense in depth.
The image build creates a real fresh named profile, proves it remains config-less, and exercises the installed default, classic-CLI, browser, TUI, agent-commentary, update-command, and gateway policy paths against that home, including a forced config-load error for pre-update backup resolution.

Hermes configuration schema moves from 32 to 33.
The Hermes sandbox image runs `hermes doctor --fix` before writing NemoClaw's generated configuration, so the generator and its hash contract now emit schema 33 directly.

The versioned CLI adapter records two managed command forms:

- top-level resumed or continued one-shot invocations that NemoClaw translates to `chat --query`; and
- invocations that combine separate provider and model flags.

All other commands pass through without a duplicate upstream subcommand inventory.
The image build validates each managed option against Hermes' machine-readable preparse, top-level, and `chat` parser metadata.
Public help probes remain runtime evidence for the owned forms, not the compatibility authority.
The wrapper parses each managed invocation once and verifies that the installed CLI is Hermes 0.19.0 before translation.
Hermes 0.19 writes `--usage-file` reports only on its native one-shot path.
The wrapper rejects a resumed or continued one-shot invocation with `--usage-file` because translation would omit the report.
The wrapper also rejects separate provider and model flags after an unquoted multi-word session name because a later positional can be an upstream command.
An invalid adapter, an unknown adapter version, or a Hermes CLI version mismatch fails closed before a translated command runs.

The target source still contains all six session-list queries whose preview must reflect the latest resumed or continued one-shot turn.
The session-preview patch remains exact-count guarded.
The target Langfuse plugin still validates credentials before the OpenShell resolver can supply them, so its narrowly bounded placeholder patch remains exact-source guarded.
The managed light-skin source boundary is also unchanged for NemoClaw's selected terminal environment.

Hermes 0.19 records default-profile cron execution history in an SQLite ledger and Discord replay state in `gateway/discord_message_recovery.db`.
Upstream hard-codes the cron ledger at `cron/executions.db`.
That location conflicts with Shields up.
NemoClaw's Shields up transition sets the high-risk `cron` directory to `root:sandbox` mode `0755` and removes group and world write access from its cron job definitions.
The initial NemoClaw Hermes 0.19 integration attempted to set that directory to `gateway:sandbox` mode `2770` during every gateway start.
During a managed restart, the nonroot supervisor could not make the sealed directory group-writable, so it stopped before launching the gateway child.
NemoClaw now hash-binds and exact-source patches both the ledger path and Hermes quick snapshot inventory to `runtime/cron-executions.db`.
Only the mutable audit database moves into the existing cross-identity runtime boundary; `cron` remains protected.
The `v0.0.97` tag predates this ledger, so tagged upgrades need no path migration.
Snapshots made during the brief untagged-main window after the Hermes 0.19 merge retain the superseded path and are outside this release migration contract.
Both default-profile files use SQLite online backup and restore.
The `cron` directory remains the state-directory contract for cron job definitions.
The relocated execution ledger is a distinct online-backed state file.
WAL and SHM files are omitted and removed on restore.
This cleanup is required even after a read-only online backup because opening a WAL-mode source can materialize sidecars owned by the backup identity; leaving those `0640` sidecars in place makes the producer's restored database appear read-only.

Both ledgers follow the active `HERMES_HOME`.
When a gateway or cron process is launched with a named profile home, the corresponding files live below `profiles/<name>/`.
NemoClaw preserves `profiles` as a state directory, so those named-profile databases are captured by tar rather than by SQLite's online backup API and can be inconsistent if written during a rebuild snapshot.
This is an upgrade-created instance of the existing generic named-profile database limitation, not a new credential or authorization boundary.
The cron ledger is an audit history rather than a retry queue; an inconsistent Discord recovery ledger can lose or repeat reconnect bookkeeping.
Supporting dynamic profile-local SQLite discovery safely requires generic path enumeration, validation, backup, and restore work outside this dependency-upgrade scope.
Both default-profile ledgers cross two runtime identities: `gateway` creates and reopens them under the gateway's `0007` umask, while `sandbox` performs snapshot backup and atomic restore.
NemoClaw maintains the writable `runtime` and `gateway` parents as `gateway:sandbox` mode `2770`.
Shields up leaves the `cron` directory at `root:sandbox` mode `0755` and removes group write access from its cron job definitions.
Hermes' ordinary SQLite creation produces the live cron database as `gateway:sandbox` mode `0640`, which gives `sandbox` the read access needed for online backup; the sandbox-owned restored replacement is explicitly mode `0660` so `gateway` can reopen it.
Discord instead forces its live database to `0600`, so NemoClaw exact-source patches that upstream chmod to `0660`.
Build probes use the real cron and Discord APIs to prove gateway creation, sandbox read/online-backup/replacement, and gateway reopen/write against each restored file.

Base SHA `fa96c91f` contributes the workaround that moves gateway PID, lock, and runtime-status files below the writable `HERMES_HOME/runtime` directory.
Hermes 0.19 retains the top-level paths but changes their home selector from `get_hermes_home()` to `_get_process_hermes_home()` so profile-context tasks cannot redirect process-owned gateway metadata.
The upgrade retargets the exact-source patch to that target shape and preserves the process-scoped selector while relocating the three central metadata helpers used by NemoClaw's managed default gateway.
The Hermes sandbox image hash-binds the patcher and probes those installed PID, lock, and status helpers against the writable runtime directory.

The inherited workaround is not a complete upstream metadata migration.
Hermes still force-unlinks a top-level PID during direct `gateway run --replace`, keeps planned-stop and takeover markers at the top level, and has explicit top-level PID or status readers in named-profile, multiplexer, service-manager, web, container-boot, Windows, backup, and upstream Docker paths.
Those same direct-consumer gaps exist in base SHA `fa96c91f`'s Hermes 0.18 patch, so the 0.19 retarget does not regress NemoClaw's managed default-gateway lifecycle.
With Shields up, direct Hermes replacement or stop and named-profile lifecycle commands can nevertheless fail or observe stale state.
NemoClaw uses plain `gateway run` plus its host-owned managed stop/start recovery; the protected managed-restart E2E proves only that supported path.
Completing the upstream relocation requires a separate exact-source audit and runtime matrix for every explicit consumer rather than extending this dependency upgrade's claim.

The target MCP tool names use the `mcp__server__tool` shape.
Progressive disclosure and the managed MCP bridge therefore require runtime proof rather than inference from the image build.
New optional upstream secret sources are not enabled by NemoClaw.
The wrapper recognizes the reviewed `--safe-mode` CLI flag without adding a new sandbox-generated environment variable or broadening NemoClaw's environment allowlist.

## Dependency closure, licenses, and advisories

The frozen uv `0.11.33` export for `anthropic messaging web pty mcp acp` contains 95 unique third-party package names across all retained environment markers after the reviewed security constraints are applied; this is not the installed count for one Linux image.
Six exported packages—`colorama`, `concurrent-log-handler`, `portalocker`, `pywin32`, `pywinpty`, and `tzdata`—are guarded by `sys_platform == 'win32'`.
On `linux/amd64` and `linux/arm64`, uv selects 89 third-party distributions plus the editable `hermes-agent` project, so both published base jobs prepared, installed, and compatibility-checked 90 distributions.
Comparing the marker-complete export with the previous five-extra graph shows that ACP adds only `agent-client-protocol==0.9.0` and changes no existing selected package version.
Hermes 0.19.0 already pins that exact package in its source metadata and frozen lock.
The lock binds the source distribution at `f744c48ab9af0f0b4452e5ab5498d61bcab97c26dbe7d6feec5fd36de49be30b` and the architecture-neutral wheel at `06911500b51d8cb69112544e2be01fc5e7db39ef88fecbc3848c5c6f194798ee`.
Its only required dependency is `pydantic>=2.7`, which is already present in the selected graph, and its Python `>=3.10,<3.15` requirement includes NemoClaw's Python 3.13 runtime.
The upstream `0.9.0` tag resolves to GitHub-verified commit `093a562a59bdec3c8bb62ff826cf86e67c427a7c`, and the tagged source carries the Apache-2.0 license.
The package metadata does not declare a license expression or license file, and PyPI serves no PEP 740 provenance for the selected wheel; these remain artifact-provenance limitations despite the lock-bound hash and verified source tag.
An August 20, 2026 point-in-time OSV query and the PyPI release record report no advisory for `agent-client-protocol==0.9.0`; this is not a claim that the complete image is vulnerability-free.
The optional DingTalk compatibility changes remain outside that selected graph.
In the unpatched upstream release transition from `v2026.7.1`, the selected graph changes only `slack-bolt` from `1.27.0` to `1.29.0` and `slack-sdk` from `3.40.1` to `3.43.0`; the downstream security selections are recorded below.
Both changed packages remain MIT licensed.

Managed capability-union images add a separate six-package Teams overlay to that reviewed base graph: `microsoft-teams-apps==2.0.13.4`; `microsoft-teams-api==2.0.15`; `microsoft-teams-cards==2.0.15`; `microsoft-teams-common==2.0.15`; `dependency-injector==4.49.1`; and `msal==1.37.0`.
The existing base already supplies the requested `aiohttp==3.14.3`, so the union does not add a second aiohttp artifact.
The Dockerfile binds seven exact PyPI wheels by SHA-256: five architecture-neutral wheels and one architecture-specific Dependency Injector wheel for each of amd64 and arm64.
The four Microsoft Teams wheels and MSAL declare MIT; Dependency Injector ships the BSD 3-Clause license.
For the union-enabled build, the selected wheel stage is copied into `/opt/nemoclaw-hermes-teams-wheels`, and the overlay is resolved with `UV_OFFLINE=true` and `UV_FIND_LINKS` restricted to that copied directory before the directory is removed in the same `RUN` instruction.
The union-disabled selector instead resolves an empty scratch stage, so an ordinary custom-plan build does not fetch or depend on the managed-image wheel graph.
The recorded 95-package amd64 and arm64 capability-union evidence predates ACP and does not validate this candidate.
Trusted base-image jobs from source commit `a42a7717c8e2d13c0c16465f8d06b6aab1e86cb3` installed and checked 90 distributions on both amd64 and arm64, identified `agent-client-protocol==0.9.0`, and completed `hermes acp --check`.
Pull request workflow run `32415993531`, attempt 1, built and direct-started a local `linux/amd64` capability-union image from source commit `6d195636e43edee177a5b67d93eae04d36e98928`, then published `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:0d07845fa3b02a0657d28e134eb2e1f4a96cc6260e2538f3d4eafe831c7e5c17` and passed an anonymous exact-digest pull.
Its build starts from the 90-distribution Linux base, installs exactly the six Teams overlay distributions named above, and later seeds `pip==25.1.1` for the lazy-installer boundary.
After publication, an independent container probe ran that exact digest as `sandbox` on `linux/amd64` with networking disabled, all capabilities dropped, no-new-privileges, and a read-only filesystem.
It found 97 installed distributions, found no broken requirements with isolated Python, identified `agent-client-protocol==0.9.0`, and completed `hermes acp --check`.
After excluding the first-party `hermes-agent` project and the `pip` installer, the final candidate contains 95 third-party runtime distributions.
This digest-only, single-platform pull request candidate does not replace the post-merge multi-platform publication gate.
An August 7, 2026 point-in-time OSV query reports no advisory for any of the six overlay package versions; this statement is scoped to that overlay and is not a claim that the complete image is vulnerability-free.

The base image also replaces `python-multipart==0.0.27` with `0.0.32`.
The reviewed artifacts are the source distribution at `be54b7f3fa167bb83e4fcd936b887b708f4e57fe75911c02aebf53efaf8d938e` and wheel at `ff6d3f776f16878c894e52e107296ffc890e913c611b1a4ec6c44e2821fe2e23`.
Their PyPI Trusted Publisher attestations bind Apache-2.0 artifacts to `Kludex/python-multipart`, `.github/workflows/publish.yml`, tag `0.0.32`, verified commit `238ead62a0bb6f6cdfe122708faa13812f59f9a6`, and successful run `26963211769`.
The override clears `GHSA-5rvq-cxj2-64vf`, `GHSA-6jv3-5f52-599m`, and `GHSA-v9pg-7xvm-68hf`.
A Python 3.13 FastAPI `TestClient` probe covered ordinary forms, file upload, and dense CRLF input with the replacement parser.

The source patch changes the published constraints and `uv.lock` as one transaction rather than overlaying packages after `uv sync`.
The August 3 refresh moves `aiohttp` from `3.14.1` to `3.14.3` and `cryptography` from `48.0.1` to `50.0.0`, clearing `GHSA-cq5v-8q36-5273` and `GHSA-g6cj-pr64-35w5`.
Tornado `6.5.7` is the lowest version that clears all three recorded Tornado advisories: `6.5.6` clears `GHSA-3x9g-8vmp-wqvf` and `GHSA-mgf9-4vpg-hj56`, while `6.5.7` clears `GHSA-pw6j-qg29-8w7f`.
The complete exact-source patch retains the previously reviewed MCP, Pillow, Starlette, and Tornado selections because it must apply the full downstream security delta to the unmodified Hermes release metadata.
Hermes does not install the `azure` or `dingtalk` extras in its managed `anthropic messaging web pty mcp acp` runtime, but its published lock resolves every optional extra.
`msal==1.36.0` and the `alibabacloud-dingtalk==2.2.42` dependency chain capped cryptography below 49, so a lock-consistent security refresh also selects `msal==1.37.0` and `alibabacloud-dingtalk==2.2.54`.
The latter permits `alibabacloud-tea-openapi==0.3.16`, removes the obsolete `cryptography<49` constraint, adds `alibabacloud-tea-xml==0.0.3`, and no longer resolves `darabonba-core` or `websocket-client` through that optional chain.
The two selected Alibaba Cloud Tea packages are source-distribution-only and their PyPI JSON metadata omits dependency declarations; uv `0.11.33` derives the dependency metadata from the source distributions and freezes their source hashes in `uv.lock`.
The base image does not build or install those packages because `HERMES_UV_EXTRAS` does not select the DingTalk extra.
These compatibility-only lock changes remain MIT or Apache-2.0 licensed and do not change the packages installed in the base image for the selected extras.

The August 3, 2026 point-in-time targeted audit reports no advisory for `aiohttp==3.14.3`, `cryptography==50.0.0`, `mcp==1.28.1`, `Pillow==12.3.0`, `starlette==1.3.1`, or `tornado==6.5.7`.
The base image dependency audit also reports unrelated records for `click==8.3.1`, `pydantic-settings==2.13.1`, `Pygments==2.19.2`, and `PyNaCl==1.5.0`.
It also reports records for the published `python-multipart==0.0.27` resolution that the base image replaces with `0.0.32`.
Those records are not introduced or resolved by this targeted advisory update and remain visible for a separate dependency-lifecycle review; this review does not describe the complete image as vulnerability-free.

Compatibility evidence covers all 97 upstream image-routing tests with Pillow `12.3.0`, plus a real FastAPI `0.133.1`, Starlette `1.3.1`, and multipart `0.0.32` form and upload `TestClient` smoke.
The base image build requires the frozen environment to remain consistent and asserts the exact installed versions before continuing.
The Hermes sandbox image repeats the `aiohttp==3.14.3` and `cryptography==50.0.0` checks after messaging package installation.
These checks run when `NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION` is `0` or `1`.

The remaining audit records stay recorded rather than being described as fixed or excluded.

The final root JavaScript runtime graph remains `agent-browser@0.26.0` plus the existing Streamdown tree and reports zero production audit findings.
The TUI and web workspaces retain unchanged high package-level findings in build-only dependencies whose `node_modules` directories are deleted after compilation.
The React Router record is limited to React Server Components, while Hermes uses `BrowserRouter`.

The WhatsApp bridge moves Baileys from a Git commit dependency to integrity-bound `@whiskeysockets/baileys@7.0.0-rc13` and moves libsignal to integrity-bound `libsignal@6.0.0`.
This removes both Git resolutions and improves reproducibility.
The Baileys RC9 bridge graph reports one critical, three high, two medium, and one low affected package entry.
The RC13 transition removes the critical `GHSA-qvv5-jq5g-4cgg` protocol-message spoof and state-corruption exposure plus every high and medium entry, leaving only one low `body-parser` finding in the target bridge.
NemoClaw's issue `#8087` patch adds the following integrity-bound production graph so the Baileys socket and fetch paths use the injected `HTTPS_PROXY`.

| Package | Integrity | Declared license |
| --- | --- | --- |
| `https-proxy-agent@7.0.6` | `sha512-vK9P5/iUfdl95AI+JVyUuIcVtd4ofvtrOr3HNtM2yxC9bnMbEdp3x01OhQNnjb8IJYi38VlTE3mBXwcfvywuSw==` | MIT |
| `agent-base@7.1.4` | `sha512-MnA+YT8fwfJPgBx3m60MNqakm30XOkyIoH1y6huTQvC0PwZG7ki8NacLBcrPbNoo8vEZy7Jpuk7+jMO+CUovTQ==` | MIT |
| `debug@4.4.3` | `sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==` | MIT |
| `ms@2.1.3` | `sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==` | MIT |

The patched bridge production audit reports zero high or critical findings and retains the unrelated low `body-parser` finding.
The added packages declare MIT in the patched lock, so the downstream patch adds no restrictive license.
The `sharp` move from `0.34.5` to `0.35.3` and the native bridge still require amd64 and arm64 pairing, send, and receive proof.

No new copyleft or restrictive license enters the selected graph.
The GPL-3.0 libsignal package, Apache-2.0 sharp package, and LGPL libvips artifacts already exist in the Baileys RC9 bridge, so their existing obligations persist.
The target source archive does not publish a complete SBOM, and a lock-derived SBOM alone would be inaccurate because the base image replaces the multipart resolution before NemoClaw builds the Hermes sandbox image.
Artifact scanning must therefore inspect the Hermes sandbox image and record the downstream override.

## Patched Base Image Provenance

The `BASE_IMAGE` argument in `agents/hermes/Dockerfile` pins the following published multi-platform base image:

| Evidence | Value |
| --- | --- |
| Repository | `NVIDIA/NemoClaw` |
| Workflow | `Images / Publish Base and Managed Images` |
| Workflow path | `.github/workflows/base-image.yaml` |
| Trigger | `workflow_dispatch` on `codex/hermes-acp` |
| Producer run | `32413658315`, attempt 1, completed successfully |
| Source commit | `a42a7717c8e2d13c0c16465f8d06b6aab1e86cb3` |
| OCI index | `sha256:212de47e723e9fec1e697d4eec1db82af2d0fb7802aade4fa5dfc3f05274d3c5` |

The selected index resolves to these platform manifests:

| Platform | Child manifest |
| --- | --- |
| `linux/amd64` | `sha256:6b12109ac756c97ca723dae50e855372204898bd066d7f303c15f9ba0709930b` |
| `linux/arm64` | `sha256:964df75c03a6b43a2b722a47e264ba795baaf6e71661784e4632467f5d6a9182` |

Each child manifest has the following per-platform Supply-chain Levels for Software Artifacts (SLSA) provenance:

| Platform | Attestation manifest | SLSA provenance layer | Builder ID |
| --- | --- | --- | --- |
| `linux/amd64` | `sha256:c2c98bb019f2fae9631ef53cf989cececfbe62202f2a74455a1504b8234f832b` | `sha256:0114e4a9c58e0b3f0d7bef1e2eea9fec96613f2d27c6f0173679edd99a44bacc` | `https://github.com/NVIDIA/NemoClaw/actions/runs/32413658315/attempts/1` |
| `linux/arm64` | `sha256:2d8a5a8544c1d8bdd8ff0a3b1670dfe2d78047707fc04f1df44fba678a0b5d61` | `sha256:816ecdc658db8c6296ee47816db7f4692c1789cd655d4319eafe27d958c78e2a` | `https://github.com/NVIDIA/NemoClaw/actions/runs/32413658315/attempts/1` |

Both in-toto layers use predicate type `https://slsa.dev/provenance/v1` and bind source `https://github.com/NVIDIA/NemoClaw` to revision `a42a7717c8e2d13c0c16465f8d06b6aab1e86cb3`.

Both platform base-image jobs completed successfully.
Each installed and checked 90 packages, identified `agent-client-protocol==0.9.0`, and printed `Hermes ACP check OK`.
The feature-branch base workflow intentionally skipped the final multi-platform managed-image publisher, so this base evidence alone does not represent an ACP-enabled final managed image.
The separate digest-only `linux/amd64` pull request candidate is recorded in the dependency-closure and publication evidence sections.

The selected index supersedes the following historical base-image evidence:

| Evidence | Value |
| --- | --- |
| Producer run | `31717470863`, attempt 1, completed successfully |
| Source commit | `d243ea62509bae7832a23fe8636e947303c19c60` |
| OCI index | `sha256:ffafa4dd1d8d5a802ae4fc4005b51e1accfa5e782e47de736a0d8d8bf2c83837` |

The superseded index resolved to the following platform evidence:

| Platform | Child manifest | Attestation manifest | SLSA provenance layer |
| --- | --- | --- | --- |
| `linux/amd64` | `sha256:da722766abb3c55d20242c3c62b434fd09583e4d92b5682aa98b374a74e05fa1` | `sha256:e64caf40f33b253c8952b09a4be9bb39c1adc8fd40bfff3f193accf8c722c49e` | `sha256:d1f23fb5dc32da33eae59caa719e331633867d6ed4c8e0662f6a372316314485` |
| `linux/arm64` | `sha256:c7fe8f5664beaf5f10ba990f1317d17a976ece1093a72f9efb0effdf93f3f48d` | `sha256:77a5dafd8d55132c2fb4ef7af213957b2eebd9b9bfaeb5e24121d6947c5a38d1` | `sha256:11dff2b05f47bc57315490c3483d896ea1b46dc31dd195c283af690ce718fba3` |

The superseded run built and validated pre-ACP Hermes managed images from both exact child manifests.
Those final-image checks remain historical evidence and do not validate ACP availability.

That prior index had superseded this earlier base-image evidence:

| Evidence | Value |
| --- | --- |
| Producer run | `31636995117`, attempt 1, completed successfully |
| Source commit | `7c721ae4d60fd54e11f4d0c7d0482ccd6ac8cded` |
| OCI index | `sha256:4295138eb70f938189430f8dc7b3cd5db0aa762234e64e398a6a5ef60803126c` |

| Platform | Child manifest | Attestation manifest | SLSA provenance layer |
| --- | --- | --- | --- |
| `linux/amd64` | `sha256:f82972cf3d1497e60741ae0c48a870030d792e56652ee35868d30099cd93d831` | `sha256:097d246b402e3483ddb408b9744c0e8db63a7cb33efcc781357d49c69fbee7b5` | `sha256:8e51f1fd6c647e30f1c2191862d013e7dbe07af28f4d29bcf09bb4770f04ba22` |
| `linux/arm64` | `sha256:cbb5f8a11a17e5e5c7ce7499f3c6aff507bac15cc348310923436eb2e0f1536c` | `sha256:47ae417ac5e5c925674b727020ef1c5eaa5b1090bb862a7a2ed1c40ca7e79cf3` | `sha256:461eaf36474d1e02aed2acb60be69b37a4d464bc0805681d975522948ea258af` |

That earlier build included the exact-source dashboard WhatsApp session-path patch and `libexpat1==2.8.3-1` for both supported architectures.
Its base-image builds passed the exact-source patch guard, locked bridge install, bridge-to-Baileys option assertions, and controlled-proxy WebSocket `CONNECT` regression.

Earlier reviewed provenance includes the security-refreshed multi-platform index published by run `31006872948`, attempt 1, from source commit `bd668121e918e7b1dda13062bed728f18150360e`:

| Evidence | Value |
| --- | --- |
| OCI index | `sha256:57c091ab9b31c924eac0050e66c834c37df875154a254964302a31b119b50b96` |
| amd64 child manifest | `sha256:cf6e95640faac8e5099cc9d267a6eb9b1f9192abbfcc9552a81a8ae22b4a47bb` |
| arm64 child manifest | `sha256:92e7c982bc5106f4c3f551032418fb72375b4d37bff50e21baa3d0e861d7519e` |

That security-refreshed image's platform manifests identify repository `NVIDIA/NemoClaw` and source commit `bd668121e918e7b1dda13062bed728f18150360e`; its platform histories contain installed-version assertions for `aiohttp==3.14.3` and `cryptography==50.0.0`.
The `57c091ab` OCI index has no SBOM attestation. This absence is separate from the incomplete SBOM in the Hermes source archive.

The Dockerfile change replaces the base image built from source commit `340c47857596e7cc347541a0b32fe9e24f201bcd` and identified by OCI index `sha256:956c3d0c812ee6caa56f3b6e307819925d920604adcf73c4a9e6229788967634`:

| Evidence | Value |
| --- | --- |
| Producer run | `30779271312`, attempt 1 |
| Source commit | `340c47857596e7cc347541a0b32fe9e24f201bcd` |
| OCI index | `sha256:956c3d0c812ee6caa56f3b6e307819925d920604adcf73c4a9e6229788967634` |
| amd64 platform index | `sha256:faf96b115049c2ae3e7c10be66ae4916cd05ff72900ef5b0642f9f90b6dd834d` |
| amd64 image manifest | `sha256:f4c707f180210cfc1457d923f05058203314d3303caf818b1cf4b67d6c0f32c3` |
| arm64 platform index | `sha256:61a7356020832392692347d2510fe8817c8a9f3ff3d5c050fbcec6182787eb4d` |
| arm64 image manifest | `sha256:36b4e5c9fdd506ca5823091465d9303043a12cad7a552fce7e426c79cb7d722c` |

Source commits `340c47857596e7cc347541a0b32fe9e24f201bcd` and `bd668121e918e7b1dda13062bed728f18150360e` diverge after merge base `eaa6ec4`.
Source commit `bd668121e918e7b1dda13062bed728f18150360e` preserves the reviewed WhatsApp inputs introduced by squash commit `3f3eb6139e089c24397d6a499a10fcde4bdc84da`.
GitHub reports squash commit `3f3eb6139e089c24397d6a499a10fcde4bdc84da` as `Verified`.
That squash commit is an ancestor of source commit `bd668121e918e7b1dda13062bed728f18150360e`.
The following blobs match between source commit `340c47857596e7cc347541a0b32fe9e24f201bcd` and squash commit `3f3eb6139e089c24397d6a499a10fcde4bdc84da`:

| Path | Blob |
| --- | --- |
| `agents/hermes/Dockerfile.base` | `b9962e7` |
| `agents/hermes/whatsapp-proxy.patch` | `c154223` |
| `test/agents/hermes/hermes-share-mount-deps.test.ts` | `09e4c48` |

Each reviewed commit in the following table is an ancestor of `bd668121e918e7b1dda13062bed728f18150360e` and appears as `Verified` in GitHub:

| Commit | Input |
| --- | --- |
| `265c18f856263c20cd4a3e89ca189fc102dbc95b` | Trusted root npm audit |
| `15069f9262d52b74d8916b7a0d7969a9ae4d3ee1` | Managed-runtime audit coverage |
| `efc34999dd185c2e14ff5dc6997d75db26537f3a` | Private npm `ip-address` remediation |
| `b6df720eebf5a01928dbed2f588691ba8de794f8` | Migration from `gosu` to `setpriv` |

## Concern ledger

| ID | Severity | Disposition | Evidence and remaining gate |
| --- | --- | --- | --- |
| `HERMES-1` | High | Pin and test | The verified target tag, commit, source SHA-256, CalVer-to-semver mapping, registry cross-check, and producer runs are recorded, while final source-pin coherence still needs a test. |
| `HERMES-2` | High | Migrate and test | `approvals.mode` is explicitly `manual`, and generated-config tests reject inheritance of smart authorization. |
| `HERMES-3` | High | Migrate and test | Generated configuration and the doctor hash contract use schema 33 before runtime startup. |
| `HERMES-4` | High | Migrate and test | The versioned adapter owns only top-level resumed or continued one-shot translation and separate provider and model composition. The image build validates its managed options against Hermes' machine-readable preparse, top-level, and `chat` parser metadata; public help remains runtime evidence. The wrapper reads session-name command boundaries from Hermes' installed coalescer source instead of copying its private set, parses a managed invocation once, rejects the unsupported `--usage-file` combination and ambiguous unquoted multi-word session names, and verifies Hermes 0.19.0 before translation. Unrelated commands pass through without a subcommand inventory. Each translation records its upstream source-fix constraint and removal condition. Invalid adapters, unknown adapter versions, incompatible upstream coalescer source shapes, and upstream version mismatches fail closed. |
| `HERMES-5` | Medium | Guard and test | Every retained compatibility patch was compared with target source, retargeted, hash-bound, and exercised by a focused regression or image smoke probe. |
| `HERMES-6` | High | Migrate, guard, test, and runtime-proof | Default-profile cron and Discord ledgers use online SQLite backup with nested-parent tests. The cron execution ledger is exact-source relocated to `runtime/cron-executions.db`, and Hermes quick snapshots follow the same path. The `cron` directory remains `root:sandbox` mode `0755` during Shields up, and its cron job definitions remain non-writable to the `sandbox` group. Descriptor-safe startup repair maintains only the writable runtime and gateway parents as `gateway:sandbox` `2770`. Gateway-to-sandbox-to-gateway image probes cover both ledgers; cron's live source is group-readable `0640` and its restored replacement is `0660`, while Discord additionally needs its guarded `0660` upstream chmod patch. Managed restart and rebuild persistence remain live E2E gates. |
| `HERMES-7` | High | Test and runtime-proof | The target's `mcp__server__tool` names are compatible by source inspection, while managed-tool discovery and invocation remain a live E2E gate. |
| `HERMES-8` | High | Guard and runtime-proof | Optional upstream secret sources stay disabled, `--safe-mode` does not broaden the generated environment allowlist, and the live environment boundary must reject raw credentials. |
| `HERMES-9` | High | Pin and test | The selected Python delta adds no advisory regression, and the affected multipart parser is replaced with attested `0.0.32` plus hash and runtime probes. |
| `HERMES-10` | High | Pin and test | The exact-source patch updates Hermes metadata and its frozen lock together, selects `aiohttp==3.14.3`, `cryptography==50.0.0`, `mcp==1.28.1`, `Pillow==12.3.0`, `starlette==1.3.1`, and `tornado==6.5.7`, and fails the base image build on dependency inconsistency or installed-version drift. The `agents/hermes/Dockerfile` build checks `aiohttp==3.14.3` and `cryptography==50.0.0` in the Hermes sandbox image after messaging package installation. The check runs when `NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION` is `0` or `1`. The base image separately checksum-pins Node.js `24.18.1` and checks uv `0.11.33`. |
| `HERMES-11` | High | Migrate, test, and runtime-proof | Root npm audit reports zero production findings, and the WhatsApp bridge removes the Baileys RC9 critical, high, and medium advisory entries. Both architectures still require native bridge and message-path evidence. |
| `HERMES-12` | High | Pin and runtime-proof | Trusted workflow run `30779271312`, attempt 1, built source commit `340c47857596e7cc347541a0b32fe9e24f201bcd` and published OCI index `sha256:956c3d0c812ee6caa56f3b6e307819925d920604adcf73c4a9e6229788967634`. Run `31006872948`, attempt 1, published security-refreshed index `sha256:57c091ab9b31c924eac0050e66c834c37df875154a254964302a31b119b50b96` from source commit `bd668121e918e7b1dda13062bed728f18150360e`, whose platform histories check `aiohttp==3.14.3` and `cryptography==50.0.0`. Trusted workflow run `31031662054`, attempt 1, rebuilt source commit `a7a7f3e470a75c404d316d2054445e16bb63b48c` with the exact-source dashboard WhatsApp session-path patch and published replacement OCI index `sha256:3d54b928baef9df403227e846f73079d13ca8424a27cd5268ca97bac3f030b27`. Run `31636995117`, attempt 1, rebuilt source commit `7c721ae4d60fd54e11f4d0c7d0482ccd6ac8cded` with `libexpat1==2.8.3-1` for amd64 and arm64 and published the superseded OCI index `sha256:4295138eb70f938189430f8dc7b3cd5db0aa762234e64e398a6a5ef60803126c`. Run `31717470863`, attempt 1, built source commit `d243ea62509bae7832a23fe8636e947303c19c60` and published OCI index `sha256:ffafa4dd1d8d5a802ae4fc4005b51e1accfa5e782e47de736a0d8d8bf2c83837`; its managed-image validation predates ACP. Run `32413658315`, attempt 1, built GitHub-verified source commit `a42a7717c8e2d13c0c16465f8d06b6aab1e86cb3` and published replacement index `sha256:212de47e723e9fec1e697d4eec1db82af2d0fb7802aade4fa5dfc3f05274d3c5`. Both platform jobs installed and checked 90 packages, identified `agent-client-protocol==0.9.0`, and completed `hermes acp --check`; the index and both platform attestations bind the exact source revision. The `agents/hermes/Dockerfile` pins that index. Pull request run `32415993531`, attempt 1, then built and direct-started a local `linux/amd64` capability-union image before publishing digest-only candidate `sha256:0d07845fa3b02a0657d28e134eb2e1f4a96cc6260e2538f3d4eafe831c7e5c17` and verifying its anonymous pull. A separate restricted exact-digest probe confirmed its 97-distribution inventory, dependency compatibility, ACP version, and terminating check. Full multi-platform managed-image publication remains a post-merge gate. The live final-image WhatsApp evidence is recorded under `HERMES-22`. |
| `HERMES-13` | Medium | Document bounded residual | Static `state_files` entries online-back up the default profile only. Cron or Discord ledgers created by a process launched under `profiles/<name>` remain in the raw `profiles` tar capture and can be inconsistent during a concurrent snapshot. Dynamic profile-local SQLite discovery is generic snapshot work outside this upgrade PR. |
| `HERMES-14` | High | Migrate and test | The browser evaluation denylist changed from default-on to opt-in. Generated configuration explicitly writes `browser.restrict_evaluate: true`, including when managed browser-gateway settings are merged, so the upgrade does not broaden page-context access. |
| `HERMES-15` | Medium | Migrate and test | The omitted gateway session-reset policy changed from bounded daily and idle expiry to no automatic reset. Generated configuration explicitly writes the complete outgoing reset and notification policy to preserve the retention bound without inheriting mutable dependency defaults. |
| `HERMES-16` | High | Migrate and test | The reasoning-display default changed from hidden to visible, and commentary is a new default-visible output channel. Generated configuration explicitly disables both so the upgrade does not broaden disclosure in user-visible channels. |
| `HERMES-17` | High | Migrate and test | In-place update now defaults to duplicating state and refreshing a mutable CUA driver. NemoClaw's immutable image workflow owns dependency updates, so generated configuration explicitly disables both side effects. |
| `HERMES-18` | High | Migrate and test | Fresh named profiles omit `config.yaml`, so generated pins do not cover every `HERMES_HOME`. The Hermes sandbox image hash-binds the exact `v2026.7.20` config, classic-CLI config copy, raw browser-policy, TUI raw-YAML, agent-commentary, update-command, and gateway-policy sources, patches their fail-safe defaults, and creates a real config-less profile to exercise all affected installed loaders. |
| `HERMES-19` | High | Migrate and test | The dashboard has an isolated `HERMES_HOME`, so its allowlisted routing and policy mirror is a startup security boundary. A missing gateway config remains a benign cold-start no-op, while malformed, non-mapping, unreadable, or routing-free source config and invalid existing dashboard config fail startup without changing stale dashboard bytes. Sanitized errors never include raw PyYAML parser context or credential-bearing source lines. |
| `HERMES-20` | High | Retarget, guard, test, and runtime-proof | Base SHA `fa96c91f` adds a Hermes 0.18 gateway-runtime-metadata patch whose central helper shape does not match Hermes 0.19. The retargeted exact-source guard preserves `_get_process_hermes_home()` while moving the managed default gateway's central PID, lock, and status helpers below `runtime`, hash-binds the patcher, and adds unit and Hermes sandbox image probes. The managed-gateway restart E2E remains the PR SHA runtime gate. |
| `HERMES-21` | Medium | Document inherited bounded residual | The base workaround does not retarget direct upstream `--replace` cleanup, planned-stop/takeover markers, named-profile and multiplexer readers, service/boot/web/Windows consumers, or upstream backup and Docker paths. With Shields up, those direct paths can fail or observe stale state, but the same limitation exists on base SHA `fa96c91f`; the 0.19 selector retarget adds no regression to NemoClaw's supported host-managed default-gateway lifecycle. A complete relocation needs separate exact-source patches and runtime proof for every explicit consumer. |
| `HERMES-22` | High | Patch, pin, test, and runtime-proof | Issue `#8087` showed that the Hermes WhatsApp WebSocket ignored the injected `HTTPS_PROXY`, attempted direct DNS resolution, and failed before OpenShell produced an Open Cybersecurity Schema Framework (OCSF) record. NemoClaw exact-source patches both Baileys proxy fields, locks the added proxy dependency graph, and fails the base image build when the patch drifts, a bridge-level `makeWASocket` mock does not receive the same proxy agent as `agent` and `fetchAgent`, or the pinned Baileys WebSocket transport does not send a `CONNECT web.whatsapp.com:443` request to a controlled HTTPS proxy. The mock also proves that both options remain unset without `HTTPS_PROXY`. Live Hermes WhatsApp evidence was captured manually on a final image built from this branch: dashboard QR pairing wrote credentials to `/sandbox/.hermes/platforms/whatsapp/session`, the bridge reported `{"status":"connected"}`, an inbound message from an allowlisted sender received an agent reply, and the OpenShell proxy audit admitted every WhatsApp flow under `policy:whatsapp`. Pull request `#8229` records that run and its reproduction steps. No target in this repository pairs a live WhatsApp account, so the trusted manual pull request E2E run remains the merge gate for that evidence. |
| `HERMES-23` | High | Package, guard, and bound scope | The managed base selects upstream's frozen `agent-client-protocol==0.9.0` extra, checks its exact installed version, and runs the adapter's terminating import check. The final Dockerfile repeats the exact version and SDK/adapter import gate so a stale or custom base cannot silently omit ACP. Base resolution imports the pinned SDK and adapter only as the sandbox user with networking disabled, all capabilities dropped, no-new-privileges, and a read-only filesystem; isolated Python and explicit exits prevent image environment settings from disabling the checks. This proves package and adapter availability only. ACP protocol sessions, editor compatibility, workspace mapping, file and terminal permissions, and transport and authorization behavior remain outside this change and require a separate accepted design and end-to-end test. |

Unresolved upgrade-created high-impact concerns: `0` within this review's package-availability scope.
ACP integration behavior remains outside this scope and is not represented as validated behavior.
One Medium upgrade-created instance of the pre-existing named-profile raw-capture limitation and one inherited Medium direct-runtime-consumer limitation remain explicitly accepted for this upgrade scope.

The remaining gates are repository CI, automated review, documentation review, security review, and protected Hermes E2E.
The exact-source dependency patch and its residual audit record require security review before merge.

## Verification and remaining gates

### Source and Test Evidence

The review records the following source and test evidence.

- GitHub release checks identify stable tag `v2026.7.20`, annotated tag object `c7d08de287556b3d339df336b180a39d4980ebd7`, and source commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`.
- The adjacent-range ledger covers three stable ranges and 2,399 source commits.
- The dependency comparison covers the `v2026.7.1` and `v2026.7.20` Python closures, JavaScript locks, licenses, and point-in-time advisories.
- The source comparison covers Hermes configuration, wrapper, patches, state, MCP, messaging, and secret boundaries.
- Focused tests cover generated configuration, the wrapper, compatibility patches, the default-profile state manifest, and skill contracts.
- Python 3.13 probes cover multipart forms, file upload, and dense CRLF input.
- The controlled-proxy regression sends the pinned Baileys WebSocket `CONNECT web.whatsapp.com:443` request through the bridge-provided proxy agent.
- The no-cache `linux/arm64` Hermes base image build completed.

### Publication and Registry Evidence

The review records the following publication and registry evidence.

- Hermes CI run `29768400292`, PyPI publication run `29768427462`, and Docker publication run `29768440304` completed successfully.
- GitHub Actions workflow `.github/workflows/base-image.yaml` run `32413658315`, attempt 1, published the selected ACP-enabled `linux/amd64` and `linux/arm64` base images and OCI index `sha256:212de47e723e9fec1e697d4eec1db82af2d0fb7802aade4fa5dfc3f05274d3c5`; run `31717470863`, attempt 1, published the superseded pre-ACP index; run `31636995117`, attempt 1, published the preceding index; run `31031662054`, attempt 1, published the preceding patched index; and run `31006872948`, attempt 1, published the security-refreshed index.
- Both platform base-image jobs in run `32413658315` installed and checked 90 packages, identified `agent-client-protocol==0.9.0`, and completed `hermes acp --check`.
- The selected index contains exact amd64 and arm64 image manifests plus SLSA provenance that binds source commit `a42a7717c8e2d13c0c16465f8d06b6aab1e86cb3` to the workflow run.
- Pull request workflow run `32415993531`, attempt 1, built and direct-started a local `linux/amd64` Hermes candidate from source commit `6d195636e43edee177a5b67d93eae04d36e98928`, published digest-only candidate `sha256:0d07845fa3b02a0657d28e134eb2e1f4a96cc6260e2538f3d4eafe831c7e5c17`, and passed its anonymous exact-digest pull.
- A separate post-publication probe ran that exact digest as `sandbox` with networking disabled, all capabilities dropped, no-new-privileges, and a read-only filesystem; the 97-distribution inventory, dependency compatibility, ACP version `0.9.0`, and `hermes acp --check` passed.
- The feature-branch base workflow skipped the final multi-platform managed-image publisher. ACP-enabled multi-platform validation and publication remain post-merge gates.
- PyPI Trusted Publisher attestations bind both `hermes-agent==0.19.0` artifacts to source commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`.
- The npm registry-integrity check matches the `hermes-agent==0.19.0` cross-check value recorded in this review.
- OCI inspection records the immutable index, both child manifests, both attestation manifests, and their per-platform SLSA provenance layers.

Before merge, these checks must pass:

- The managed MCP E2E test must pass discovery and invocation.
- The protected Hermes E2E tests must pass messaging, environment-credential rejection, restart, snapshot, rebuild, and rollback paths.
- Required repository checks and automated reviews must pass with no unresolved actionable finding.
- The documentation writer review and security review receipts must identify the PR commit.
