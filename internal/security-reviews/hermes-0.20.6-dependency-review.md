<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes 0.20.6 dependency and compatibility review

> Internal engineering evidence. This file is not part of the public documentation set.

Review date: August 29, 2026.

## Decision

Update the NVIDIA/NemoClaw Hermes runtime from `v2026.7.20` / `0.19.0` to
the published `v2026.8.27` / `0.20.6` release. The target source is
`5fc308a70719a83cccdbba4c0e39c23f5a8239d5`.

This change can remain a draft while the required evidence is incomplete.
Before qualification, obtain `CI / Pull Request` evidence and the authenticated
E2E job set selected by `.github/workflows/e2e.yaml`. The Mac authoring checks do
not qualify the Linux image or sandbox lifecycle. The `staging-brev-launchable`
job is supplemental evidence and does not replace the selected job set.

## Reviewed identities

| Identity | Value |
| --- | --- |
| Current release | `v2026.7.20` / `0.19.0` |
| Current source | `3ef6bbd201263d354fd83ec55b3c306ded2eb72a` |
| Target release | `v2026.8.27` / `0.20.6` |
| Target source | `5fc308a70719a83cccdbba4c0e39c23f5a8239d5` |
| Target source archive SHA-256 | `e622723b5bf3cd6c1db974d92d32242f1cb63f61c1112b6f708b34d619ef0fc7` |
| Target npm integrity cross-check | `sha512-s5q1IEBifCBb77QMwkse4MRaAaoZSxIa4IkicIO3jL7MIdq15YvnSyiNvsTOWNBi6t3shFpIg+H7+9MJsOiSkg==` |
| Target base image index | `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:c588bf76ba1c280f8a366bdfd672193e852de4f509a280662c7070a9b6e2fa48` |
| Base image publication | NVIDIA/NemoClaw run `33694485635`, source revision `d7855f99095861db4d14dd9f831a3827d5122a2f` |
| Base image amd64 digest | `sha256:b6a7359adaa4694d7321b785bcb86afa5d29315b1ed601be68d29f7da494ed50` |
| Base image arm64 digest | `sha256:1d7b4d64d1f4cb7d20923f31ab3fe7e3631bfbeaf5b8e7c3473d138894e01eb1` |
| Base image contract SHA-256 | `23de5d6fa2eaaa78a59ddfc91af5b2655f2f07d02047d49d6fb39e04308ee76f` |
| NemoPin comparison base | `4e0e663a9a4cf6bac8df8972ea23dfc26ce3c309` |
| NVIDIA/NemoClaw authoring base | `b12bede8bfa5bc7a8c083f54fc79a4f5663b81df` |
| NemoPin handoff manifest | `sha256:ec3f152824a843b9970aa8342de0ad15289d99899af06e6eb94baec8e29e5744` |

The source archive and package cross-check remain separate inputs. The image
build consumes the checksum-pinned source archive. The npm value detects a
release-identity mismatch; it is not the source used to assemble the image.
The trusted base-image workflow published and verified the listed Linux amd64
and arm64 manifest before the final Hermes image selected it.

## Semantic migration

Hermes 0.20.6 moves the default configuration dictionary into
`hermes_cli/config_defaults.py`, the TUI configuration response into
`tui_gateway/methods_config.py`, and update behavior into
`hermes_cli/update_cmd.py`. The profile-policy patch now binds those exact
files. It preserves NVIDIA/NemoClaw's manual approvals, restricted browser
evaluation, hidden reasoning and commentary, bounded session reset, disabled
in-place backup, and disabled CUA refresh for a config-less profile.

The cron execution ledger now resolves its default path at use time. The
compatibility patch preserves that behavior while redirecting the default
ledger to `runtime/cron-executions.db`. The online backup inventory remains
bound to the same runtime file.

The upstream scheduler also writes its per-profile tick lock below `cron/`.
NVIDIA/NemoClaw Shields seals that directory after configuration, so the
source patch moves only `.tick.lock` to writable `runtime/` state. Cron
definitions remain read-only while concurrent scheduler ticks retain the
upstream file-lock behavior.

The session-list implementation contains five exact preview queries in the
target source. The patch remains necessary and changes each preview from the
first message to the latest message. It also makes the workspace-aware table
show that latest preview in place of a derived or model-generated seed title,
while a user-authored title remains authoritative. Both source shapes are
exact-count guarded.

The SQLite helper now calls `apply_database_pragmas` before enabling foreign
keys. The temp-store patch was retargeted to that exact target shape. The cron
restore drain gained additional upstream constants, so its marker insertion
anchor moved to the exact drain-request filename declaration. During an
authenticated NVIDIA/NemoClaw release, the root-owned controller re-arms only
enabled, scheduled, unclaimed one-shots that became due at or after gate
acquisition while the drain was active. The root-owned release recovery record
retains that original acquisition time when it must recreate the gate. That
durable update completes before dispatch resumes; a failed update keeps the
gate closed.

The target still contains direct credential-driven platform activation paths.
The neutral-platform patch therefore remains necessary. It captures every
explicitly disabled platform before environment processing and restores those
complete objects afterward. The target import block includes `math`, and the
exact patch anchor and output digests were updated accordingly.

`/proc/1/environ` records the environment from PID 1 startup and does not
reflect later launcher exports. For the Hermes boundary, the trusted launcher
overwrites only `HERMES_HOME`, `HERMES_LAZY_INSTALL_TARGET`, and
`HERMES_BUNDLED_PLUGINS` before `hermes gateway run`. The root managed
controller applies those values to the captured environment and validates the
effective environment in process. It still fails closed for prohibited runtime
controls, OpenShell supervisor-only variables, and raw secret-shaped values.
`test/agents/hermes/hermes-env-secret-boundary-hardening.test.ts` and
`test/inference/managed/managed-gateway-control.test.ts` cover the stale
`/proc` snapshot, launcher overrides, in-process validation, and rejection
cases.

The gateway-runtime-metadata, gateway-process-identity, Discord recovery,
Langfuse credential, provider/model translation, resumed one-shot, and cron
restore controls still apply to the reviewed target shapes. Each retained
compatibility path remains guarded by source, patcher, output, parser, or image
probe evidence. Removal requires an upstream behavior change and a matching
NVIDIA/NemoClaw regression.

## Dependency closure

Hermes 0.20.6 already carries the security floors that NVIDIA/NemoClaw
previously overlaid into the 0.19.0 lock. The selected frozen graph contains:

- `agent-client-protocol==0.9.0`
- `aiohttp==3.14.3`
- `cryptography==50.0.0`
- `mcp==2.0.0`
- `Pillow==12.3.0`
- `python-multipart==0.0.32`
- `starlette==1.3.1`
- `tornado==6.5.7`

The base build verifies the selected installed versions with package metadata
and runs `uv pip check`. The existing hash-locked multipart and Hindsight
compatibility probes remain unchanged.

The managed Microsoft Teams capability union also carries the reviewed
`pydantic-settings==2.14.2` wheel because the selected base does not contain
that required dependency. Its SHA-256 is
`a20c97b37910b6550d5ea50fbcc2d4187defe58cd57070b73863d069419c9440`.
The offline union install must succeed before its package-version probe runs.

The broad 0.19.0 dependency patch is no longer carried forward. Hermes 0.20.6
already routes memory-provider installation through `tools.lazy_deps.install_specs`
and already contains the selected security versions. The source patch changes
the Hindsight plugin declaration from `hindsight-client>=0.6.1` to
`hindsight-client==0.6.1`. This keeps runtime resolution aligned with the
separately hash-verified offline 0.6.1 probe.

Hermes 0.20.6 resolves agent-browser through an npx fallback instead of the
root dependency graph. The source patch changes `agent-browser@^0.26.0` to
`agent-browser@0.26.0`. A reviewed npm lockfile binds the package archive and
integrity. The base image installs the locked package into root-owned
`/opt/nemoclaw-agent-browser-runtime`, removes sandbox-user write access, and
links `/usr/local/bin/agent-browser` to the installed executable. The same image
layer removes the root npm cache and temporary npm configuration files. A
network-disabled probe runs the link as the sandbox user, verifies the exact
version and link target, and confirms that the sandbox user cannot modify the
executable or delete the link. Hermes must then resolve
`/usr/local/bin/agent-browser`. The final image inherits this boundary and keeps
the npx fallback in npm offline mode.

Hermes 0.20.6 also added a one-shot completion linger that waits on every
tracked process in the CLI registry. A managed sandbox can contain unrelated
background processes, so a completed `hermes -z` turn can remain open until the
upstream 600-second bound expires. The source patch assigns one fresh task ID to
the one-shot turn and passes that same ID to the completion wait. Background
work created by the turn still receives its bounded linger, while unrelated
managed-runtime processes cannot delay the final response.

No new supported integration is introduced. Optional upstream features remain
subject to their existing NVIDIA/NemoClaw product and policy gates.

## Validation boundary

The Mac authoring checks prove exact source selection, patch applicability,
contract updates, and deterministic repository changes. They do not prove the
Linux image, OpenShell sandbox, upgrade recovery, or canonical end-to-end path.
The trusted manual PR plan is defined by `.github/workflows/e2e.yaml` and
`tools/e2e/target-catalogue.mts`. Its authenticated result is the authoritative
required-job set; this review does not maintain a second partial list. Brev may
produce background shadow evidence, but it is nonqualifying and cannot replace
the trusted plan or a supported scenario receipt.

Unresolved upgrade-created high-impact concerns: `0` in the authored source
diff. Qualification remains pending the required authenticated CI evidence.
