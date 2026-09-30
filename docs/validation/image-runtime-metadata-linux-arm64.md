<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Image Metadata on Linux ARM64

The image metadata changes at source revision `74a19fc2c0` passed packaging and SDK decoding checks on 2026-09-30 on the Linux ARM64 development host.
This qualifies metadata publication and validation only; it does not resolve [#12425](https://github.com/NVIDIA/NemoClaw/issues/12425) or [#12439](https://github.com/NVIDIA/NemoClaw/issues/12439).

## Checked Behavior

The packaging test used a temporary bridge path, interpreter, and executable symlink named `bun`.
The catalog preserved Fabric's descriptor records and retained the declared command, environment, user/group, and policy.
It recorded the symlink's resolved executable path and the Python host's actual interpreter path.
An installed snapshot without its runtime manifest failed, as did missing required executables, invalid command paths, missing required paths, reserved environment names, and an unsupported manifest version.

The SDK test first failed because image discovery discarded the `runtime` field.
After the change, discovery retained the advertised layout and rejected unsupported versions, relative commands, parent-traversing read paths, and missing per-adapter executable records.
The bundled descriptor snapshot still contains no installed-image layout.

Verification passed:

- 959 workspace tests, with 135 existing opt-in tests ignored.
- `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings`.
- 28 image contract tests against a private build of pinned Fabric revision `24f068c895e5cbc30286bc743498be4e5014d658`.
- Ruff checks and formatting for the changed Python sources.

The first workspace run encountered two deployment-lock test failures; the complete rerun passed.

## Read-Only Container Check

A single owned container used the existing image `nc-explore@sha256:689b0e29623919cfdcb99be6d0a9ee2bec8170ee8ba73fa7d483b528e91fbd1d`.
It ran with networking disabled and a read-only filesystem, with the changed catalog script, resolver, and manifest mounted read-only at their image paths.
Installed discovery recorded `/usr/local/bin/python3.13` for both `nvidia.fabric.nooa` and `nvidia.fabric.nooa.bench-agent`.
The returned catalog retained the pinned Fabric revision and the manifest's UID/GID `1000` process policy.
The temporary container was removed, and all 111 pre-existing containers remained present.

The local evidence directory was `/tmp/nemoclaw-image-runtime-47c4-z1fkabxt`, containing the command, catalog output, and result summary.
This check did not rebuild or relabel the complete image, create a sandbox, or request inference.

## Remaining Integration

The provider's launch, status, and policy paths still require conversion to the advertised metadata.
External gateways need an explicit source of image metadata because the pinned OpenShell API does not expose image inspection.
Image-specific provider grants must preserve adding sandboxes, shared authored provider definitions, export, and retained-state teardown.
OpenShell treats an empty binary list as unrestricted, so dropping profile binaries would not preserve the existing permission boundary.
No external-gateway configuration field or resource identity change is included in this revision.
