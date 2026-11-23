<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Configs v0.1.0 Documentation Handoff

This documentation candidate starts at `4044274395279f5d0d2852a5e31290df3708bc87`. That is the authoring base, not the final release tag commit. The earlier tutorial revisions `1636069b91f402242a35714fde1011042c3f1f70` and `637bdb6276309ea71d1f1fcb68fff518fe2db926` are historical pins, not substitutes for release evidence.

## Sources and Reader Paths

| Public Section | Changed Path and Evidence |
|---|---|
| About | Overview starts with the release workflow. Architecture separates reconciliation from serving an agent request, following `crates/nemoclaw-sdk/src/deployment/mod.rs` and `compile.rs`. The canonical changelog entry stays in place; its existing filename does not establish the publication date. |
| Getting Started | Archive layout and checksum names follow `.github/scripts/pack-cli-bundles.sh`; signing evidence and release verification follow `record-cli-signing.sh` and `.github/workflows/release.yml`. The OpenClaw exercise follows `examples/openclaw.yaml`, CLI `args.rs`, `dispatch.rs`, `formatting.rs`, and the SDK's `OperationResult`. The release example and image must be checked against the final tag. |
| Getting Started: Onboarding and Classic | `crates/nemoclaw-onboarding/src/lib.rs`, its TUI and tests, and the CLI dispatch distinguish a fresh authoring file from deployment state, and unverified checks from reported conflicts. Classic evaluation uses separate identity, state, endpoints, and tools. It does not migrate native data. |
| Building and Deploying | SDK `config/types.rs`, `compile.rs`, and `deployment/{plan,reporting}.rs` establish sandbox quantity strings, image checks, and deferred versus advisory checks. The maintenance path connects replacements, retained state, and teardown. Release packaging establishes provider mirror locations; Kubernetes uses the index digest and release metadata as a pair. |
| Agents and Inference | `versions.json` records the inspected OpenShell revision `ce58cf8e9b953281352d98a637e41616295b1318`; the reader takes the runtime version from the release pin. The OpenClaw Fabric adapter at `76bde16c40747062001bd6ea5f5d13cadab3d706`, `formatting.rs`, and the native access guides establish the request and result boundary. The inference guide distinguishes external endpoints from owned service resources and retained data. |
| Observability and Security | The troubleshooting guide separates planning, readiness, and a returned reply. Security directs readers to verify release provenance without treating it as isolation or platform qualification. Credential values stay out of the tutorial and onboarding YAML. |
| References and Resources | CLI syntax and result fields follow parser and SDK contracts. The generated schema and field reference remain unchanged. Resources route readers and coding agents to the release-matched sources. |
| Navigation | `fern/pages.json` adds `onboard`, moves Security after Observability, and leaves existing slugs intact. `fern/docs.yml` retains **Latest (main)** first and the `/nemoclaw/v1/` prefix under **v1 (Agent Configs)**. No redirects changed. Maintainer pages remain outside public navigation. |

## Local Validation

- `cargo run --locked -p nemoclaw-build -- fern check` exited 0 with Cargo and Protobuf 36.2 on `PATH`. It prepared main at `f5c05a0e6a59bd5133c50e31becbff25af274c33` and ran schema drift, generated docs and links, main route, v1 strict-link, and combined site checks. The final rerun reported zero Fern errors and two warnings per pass.
- Expanded warnings report an existing MDX parse issue in the generated configuration table (`<registration>` in the `sandboxEnv` description) and a skipped authenticated missing-redirects check. The offending field text is unchanged from the authoring base. This iteration did not change the generator or generated inputs.
- `target/debug/nemoclaw-build schema --check` and `git diff --check` exited 0. Inspected generated MDX and navigation for numbered commands, the onboarding link, section order, canonical changelog and configuration routes, and the version selector source. Did not verify browser rendering or hosted redirects.

- `cargo test --locked -p nemoclaw-cli args::tests --bin nemoclaw` exited 0: 11 passed, including the checked-in OpenClaw example's engine field and the onboarding and lifecycle parser tests. These tests do not use a release archive or invoke an agent.

## Release Evidence Still Needed

`git ls-remote --tags origin refs/tags/v0.1.0` returned no match. The final release page returned HTTP 404. The v1 hosted overview first returned 404 and later failed to connect. The API request was rate-limited. These observations do not establish the contents of a private release. No draft RC assets were substituted and nothing was published.

| Rehearsal Stage | Status and Evidence Needed |
|---|---|
| Install | Not run. Obtain the final bundle, `SHA256SUMS`, attestations, signing evidence, and exact tag commit. Verify the archive and check `nemoclaw --version`. |
| Plan | Not run. Obtain the tagged example, OpenClaw digest, and an approved disposable gateway and inference endpoint with a compatible model. Record resource changes, deferred checks, and advisories. |
| Apply | Not run. Record image acquisition, catalog checks, and the resulting gateway/workspace selectors. |
| Reply | Not run. Record the exact model and capture a redacted native invocation result showing success and the returned reply. |
| Cleanup | Not run. No resources were created. In the rehearsal, preview destroy and verify owned removal and external/retained resources separately. |

Independent review is pending. Publication, final-release qualification, and any shared deployment changes are outside this handoff.
