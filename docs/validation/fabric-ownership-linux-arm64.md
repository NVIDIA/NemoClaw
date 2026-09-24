<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Ownership Qualification

Validated on September 24, 2026, on native Linux ARM64 with Docker 29.2.1, Rust 1.98.1 and OpenTofu 1.12.6.

| Input | Revision |
|---|---|
| NemoClaw source | `ee9c19908409e72bfa7ebea16e5e4a9b6225fc57` |
| Verified bundle | `0.1.0-dev.2769f63980ffd0f4` |
| Fabric source | `24f068c895e5cbc30286bc743498be4e5014d658` |
| Fabric archive SHA-256 | `77f78f66a24a8cd8e6f33f9cf49f3db8c5de39e12e095f5599cb63909a05865f` |
| OpenClaw image | `nc-fabric-owner-20260924@sha256:c4c0d3add3869e49d0ce8d03bd7e41bbe2682d0df285ef6fde5f181b123cf83e` |
| Hermes image | `nc-fabric-owner-20260924@sha256:a7d27d1d9952131026a2961803c8ff97a8d8250dce7c5c966b7bb7f405695464` |

Fabric changes are in [NVIDIA/NeMo-Fabric PR #318](https://github.com/NVIDIA/NeMo-Fabric/pull/318).
NemoClaw consumes that exact source revision rather than a NemoClaw descriptor extension.
The local images and bundle were not published.

## Responsibility Evidence

| Owner | Exercised responsibility |
|---|---|
| Fabric | Installed descriptor and target discovery, settings/model/config schemas, pure planning, native translation and runtime execution |
| Authoring | Generic schema questions, conditional requirements, explicit choices, model settings and lossless save/reopen |
| SDK | Public configuration projection, credential references, security grants, ownership and lifecycle recovery |
| OpenTofu/provider | Discovery reads, dependency ordering, retained bindings and explicit configuration reconciliation |
| Image packaging | Install Fabric and snapshot its actual installed discovery output |

The adapter fixture lives solely in Fabric at `tests/fixtures/discovery`.
The [onboarding acceptance test](../../examples/onboarding-tui/src/tui/tests.rs) invokes production terminal discovery through `DiscoverySession`, the verified bundle and its provider.
It discovers that installed adapter, asks its conditional settings questions and saves/reopens the resulting YAML.
The [planning acceptance test](../../crates/nemoclaw-e2e/tests/discovery.rs) consumes the saved document, requires an actual OpenTofu plan to report `supported`, then passes the compiled public configuration through the generic host to Fabric's real fixture runner.
Removing the required conditional setting makes that plan fail.
The engine and model endpoints are isolated fixtures; only their addresses and the fixture image reference change between the onboarding and planning tests.
No adapter manifest or native implementation was added to NemoClaw for this test.

Identifier tests additionally preserve Fabric-valid long and control-containing identifiers through catalog consumption, schema validation and YAML round-trip.
The terminal escapes controls for display without changing their identity.

## Results

| Check | Result |
|---|---|
| Workspace tests | 863 passed, 0 failed, 118 ignored |
| Formatting and strict workspace Clippy | Passed |
| Generated schemas, documentation and Fern checks | Passed; Fern reported one warning and zero errors |
| Explicit real-provider discovery cases | 4 passed |
| Production onboarding discovery acceptance | 1 passed |
| Deployment, export and standalone OpenTofu lifecycle | 25 + 3 + 23 passed |
| Remote service, sandbox/service readiness and capacity | 7 + 1 + 2 + 1 passed |
| Docker and search credential fixtures | 4 passed |
| Generic image runtime/catalog contracts and builder tests | 17 + 7 passed |
| Installed image catalog and source verification | 2 tests per native image passed |
| Docker Bake checks | All agent and proxy targets passed without warnings |

Final lifecycle tests used immutable copies of the verified bundle.
They covered unchanged apply, configuration updates without sandbox replacement, partial creation, lost responses, failed observations, recovery, export/reapply and owned teardown.
A failed configuration mutation retains the pending guard; successful retry clears it while preserving existing resource identities.

Fabric-owned native tests ran from each image's retained source archive with `--network none --runtime=runc`.
OpenClaw completed two turns in both its default scenario and its authenticated-dashboard/Brave/progressive-tool-search scenario.
Hermes completed two turns and passed separate authentication and listener-shutdown checks.
The model service was local to each test container; these runs do not qualify external search APIs.

## Limits

The pinned Fabric API does not provide fresh native health, native configuration drift or generic model/agent probe contracts.
NemoClaw preserves unsupported or unknown results; an active runtime handle is not proof of those observations.
Deployment ownership and observation-failure checks remain enforced separately.
These results do not qualify AMD64, remote hosts, GPUs, external model providers or every native adapter.
The 118 default-suite ignored tests are not counted as passes.

Relative to NemoClaw `9146224da438c7e9207c258fcc9033c54cea0064` and Fabric `6c08337bcb11d6c0f2d5118f8f0c98a5b2a1a421`, the implementation removed 2,773 net lines across both repositories, including tests and generated files, before this validation record.
