<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes 0.20.6 dependency and compatibility review

> Internal engineering evidence. This file is not part of the public documentation set.

Review date: August 29, 2026.

## Decision

Update the NVIDIA/NemoClaw Hermes runtime from `v2026.7.20` / `0.19.0` to
the published `v2026.8.27` / `0.20.6` release. The target source is
`5fc308a70719a83cccdbba4c0e39c23f5a8239d5`.

The migration is acceptable for a draft only with the exact source bindings,
compatibility patches, and focused tests in this change. The `CI / Pull Request`
workflow and the trusted manual PR plan in `.github/workflows/e2e.yaml` remain
required before qualification. This review does not treat the Mac authoring run
or a missing Brev shadow as qualification.

## Reviewed identities

| Identity | Value |
| --- | --- |
| Current release | `v2026.7.20` / `0.19.0` |
| Current source | `3ef6bbd201263d354fd83ec55b3c306ded2eb72a` |
| Target release | `v2026.8.27` / `0.20.6` |
| Target source | `5fc308a70719a83cccdbba4c0e39c23f5a8239d5` |
| Target source archive SHA-256 | `e622723b5bf3cd6c1db974d92d32242f1cb63f61c1112b6f708b34d619ef0fc7` |
| Target npm integrity cross-check | `sha512-s5q1IEBifCBb77QMwkse4MRaAaoZSxIa4IkicIO3jL7MIdq15YvnSyiNvsTOWNBi6t3shFpIg+H7+9MJsOiSkg==` |
| NemoPin comparison base | `4e0e663a9a4cf6bac8df8972ea23dfc26ce3c309` |
| NVIDIA/NemoClaw authoring base | `b12bede8bfa5bc7a8c083f54fc79a4f5663b81df` |
| NemoPin handoff manifest | `sha256:ec3f152824a843b9970aa8342de0ad15289d99899af06e6eb94baec8e29e5744` |

The source archive and package cross-check remain separate inputs. The image
build consumes the checksum-pinned source archive. The npm value detects a
release-identity mismatch; it is not the source used to assemble the image.

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

The session-list implementation contains five exact preview queries in the
target source. The patch remains necessary and changes each preview from the
first message to the latest message. Its exact occurrence guard changed from
six to five.

The SQLite helper now calls `apply_database_pragmas` before enabling foreign
keys. The temp-store patch was retargeted to that exact target shape. The cron
restore drain gained additional upstream constants, so its marker insertion
anchor moved to the exact drain-request filename declaration. Its state
transition logic is otherwise unchanged.

The target still contains direct credential-driven platform activation paths.
The neutral-platform patch therefore remains necessary. It captures every
explicitly disabled platform before environment processing and restores those
complete objects afterward. The target import block includes `math`, and the
exact patch anchor and output digests were updated accordingly.

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

The broad 0.19.0 dependency patch is no longer carried forward. Hermes 0.20.6
already routes memory-provider installation through `tools.lazy_deps.install_specs`
and already contains the selected security versions. The remaining source
patch changes only the Hindsight plugin declaration from
`hindsight-client>=0.6.1` to `hindsight-client==0.6.1`. This keeps runtime
resolution aligned with the separately hash-verified offline 0.6.1 probe.

No new supported integration is introduced. Optional upstream features remain
subject to their existing NVIDIA/NemoClaw product and policy gates.

## Validation boundary

The Mac authoring checks prove exact source selection, patch applicability,
contract updates, and deterministic repository changes. They do not prove the
Linux image, OpenShell sandbox, upgrade recovery, or canonical end-to-end path.
The trusted manual PR plan is defined by `.github/workflows/e2e.yaml` and
`tools/e2e/target-catalogue.mts`. For this migration it includes `cloud-onboard`,
`managed-image-multiarch-startup`, `security-posture`, `hermes-e2e`,
`hermes-inference-switch`, `onboard-repair`, and `onboard-resume`. Brev may
produce background shadow evidence, but it is nonqualifying and cannot replace
any of these results or a supported scenario receipt.

Unresolved upgrade-created high-impact concerns: `0` in the authored source
diff. Qualification remains pending the required authenticated CI evidence.
