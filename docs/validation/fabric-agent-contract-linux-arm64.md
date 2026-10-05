<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Reference Agent Contract on Linux ARM64

On October 2, 2026, the dummy image and all ten interim agent images were rebuilt without BuildKit layer reuse and passed the shared command-contract suite.
The run used native Linux ARM64 with Docker 29.2.1 and Python 3.13.15 inside the images.
This qualifies the [image command interface](../design/fabric-management.md#image-contract-and-reference-implementation), including standalone validation, stdin and file input, retained files, generation checks, and declared health support.
It does not qualify live OpenShell deployment or native readiness in the real adapters.

## Images and Sources

The image sources match NemoClaw commit `952a00bbc2cd736f19c4f8df74d8cf68e713ba81`.
Production images use Fabric `24f068c895e5cbc30286bc743498be4e5014d658` with the repository's error-code patch.
The local tags use the prefix `nc-contract-952a0-20261002`; none were published.
The following immutable Docker image IDs identify the tested artifacts.

| Tag suffix | Image ID |
|---|---|
| `dummy` | `sha256:3d8f8c1e0ff11bb832b888b6b5e56706cfdc8cb6415766bb78cbef4a844774bb` |
| `claude` | `sha256:e3ff232a2efa74cf0d3d2024067256cb94e928915e1945b38cca4c789f3f8f9f` |
| `codex` | `sha256:2d421dc059aad6c7e27e8a35e45e8e00a389c66437b0b57b3d686b218ec84c2e` |
| `deepagents` | `sha256:023ac263966dde8a438d02fb2dd9cb5e01f760a8ff5d969194cec204312dfd90` |
| `hermes` | `sha256:83dac3ee3d433cb9bc8a6a20f22e7598630fa01f6a3b86906062f121ccf9226e` |
| `mini-swe-agent` | `sha256:272c9e601709f776269f1896467cdec4e1fbd1bc9e2e690e89e19e6c0f40d9f6` |
| `nooa` | `sha256:b130d2caf1cb1b946768468ffc342f05fbc11b0a3d76d25ba63a7a3598008c7f` |
| `nooa-bench` | `sha256:c78490e251e467001a8c048e4cccbc885f868a6adebe1d413c4391be9e513834` |
| `openclaw` | `sha256:e5d6342463b47e7c74ffdd460b38935f7e83b2c0c74be042244edd2bd7b423f8` |
| `pi` | `sha256:a28cf4b580d1a19ae4421f6e0110ea622b33f5a611f251d3c07423420258cb43` |
| `remote-agent` | `sha256:25b4482b78581b293cf210168b8e3d53414e44bdf0c5ebf79019d00ac7b60765` |

The builds followed the [reference image procedure](../build.md#reference-contract-image) with a temporary local Bake file that set `no-cache = true` on the shared agent target.
Build logs show no `RUN` step served from cache; checksum-pinned `ADD` downloads and base-image pulls may reuse local content with the same digests.
Every image also advertises `input_sources` `["file", "stdin"]` in its `io.nemoclaw.fabric.bridge` label.
This replaces the earlier interim rollout from `38fc6e7c3cad08239af7a47342f2e1b19097e509`, in which seven images reused previously built native layers.

## Results

| Check | Observed result |
|---|---|
| Shared command suite | All seven tests passed in dummy; five passed and two dummy-only tests were skipped in each real image. |
| Installed metadata and retained-source suite | Passed for all ten real images; adapter-specific inapplicable cases were skipped. |
| Generic image behavior | 72 tests passed against the installed Fabric fixture and reference backend. |
| Independent reference backend | Ten tests passed without Fabric installed. |
| Target selection, Dockerfile checks, Ruff, and proxy fixtures | Passed. |
| Native OpenClaw, Hermes, and Pi fixtures | Each completed two native invocations against local simulated inference. |
| OpenClaw reconfiguration | Two tests passed, including retained state across host replacement. |
| Hermes authentication and owned shutdown | Passed without model inference. |

The shared command suite checks stdin input in every image: `--config -` reaches the installed validator, `--input -` reaches streaming rejection, and non-JSON or terminal stdin returns `invalid_input` without effects.
Successful configuration, generation conflicts, invocation, and readiness-failure scenarios ran only in dummy; its configure and invoke steps read their JSON from stdin.
The separate native invocation fixtures call Fabric's runtime API directly; they do not independently qualify `fabric-agent invoke` for those adapters.
The check-group stages, including Ruff, generic, reference, and proxy tests, were rerun with the same no-cache override and passed.

The shared command qualifier ran in owned containers with networking disabled, a read-only root filesystem, and temporary sandbox storage.
Native fixtures used separate disposable containers with networking disabled and no deployment credentials.
No existing deployment was reconfigured or stopped.
The Hermes fixture emitted its native SQLite warning and selected DELETE journaling; this run did not change that dependency.

Real Fabric backends still advertise no native health checks and return unsupported health, which fails apply while preserving resources.
Dummy health validates the reference behavior only.
The dummy has no Fabric discovery catalog and is not an SDK deployment harness.
The SDK's migration to selected-image validation remains separate NemoClaw work.
Provider stdin delivery was tested against the OpenShell fixture and by `docker exec` into the dummy image, not against a live OpenShell gateway.
AMD64 execution and OpenShell sandbox-stop guarantees were not tested here.
See [upstream ownership](../design/fabric-management.md#upstream-ownership) for the remaining coordination.
