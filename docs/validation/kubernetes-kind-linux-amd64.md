<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes kind Development Validation

Recorded on 2026-09-22 for the local `codex/kubernetes-backend` changes based on `v1` commit `aba926f0fcd7b5276bbb8d894113e6ac42a57303`.
The tested native bundle is `0.1.0-dev.e856f2ca9e76db7f` for Linux AMD64.
The complete Kubernetes lifecycle passed with a real OpenClaw response of `FOUR` from the user's selected NVIDIA hosted model.
The [branch scope decision](../design/scope.md#kubernetes-development-branch) permits this development profile.
Use the [Kubernetes guide](../kubernetes.md) for setup and cleanup.

## Environment and Artifacts

The host ran Linux AMD64, kernel `6.8.0-134-generic`, and Docker `29.7.2`.
The existing operator tools were kind `0.34.0-alpha+440e1abb2bdc24`, kubectl `1.37.0`, and Helm `3.16.1`.
The owned kind node ran Kubernetes `1.35.0`, with Calico `3.32.2` and Agent Sandbox `0.5.0`.
These observations do not establish support for the operator tool version skew.
The installer verified the source checksums and image pins in [sources.json](../../tools/kubernetes/sources.json).
No other cluster or host package, driver, or kernel setting was changed.

The unmodified upstream OpenShell chart, gateway, supervisor, generated SDK client, and sandbox runtime used revision `1fe79f53991debf32776853a60f0cbd4e127dcfb`, version `0.0.117-dev.186+g1fe79f539`.
Their image digests are retained in [versions.json](../../versions.json).
Gateway TLS and bearer authentication remained enabled.
The disposable OIDC fixture retained signing keys outside the cluster, issued one-hour tokens, and mounted only public signing metadata and a separate issuer TLS key into its Pod.
The chart's fixture CA setting affected the gateway process's outbound TLS trust; it did not modify host or SDK trust.

| Artifact | Tested identity |
|---|---|
| OpenClaw agent image | `nc-kubernetes-dev@sha256:21289a8eb192fe3b2165220f324c20c4b6785955ac8a88e0478ae7e4c27eb3a7` |
| OpenClaw | `2026.9.4` |
| Hosted inference endpoint | `https://integrate.api.nvidia.com/v1`, API `openai-completions` |
| Hosted model used in the successful run | `nvidia/nemotron-3-ultra-550b-a55b` |
| Ollama | `docker.io/ollama/ollama:0.34.0@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba` |
| CPU model | `qwen3:4b-instruct-2507-q4_K_M` |
| Model manifest SHA-256 | `0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0` |

The agent image ran as UID and GID `10001` with a private workspace and seeded temporary directories.
The successful run reused the Docker fixture's provider, API, endpoint, credential reference, policy, and native agent settings, with the user's Ultra model replacing the fixture's Super model.
Kubernetes required a separate external gateway, its compatible image, process UID and GID `10001`, and a fresh deployment identity.
The hosted credential was loaded privately as `NVIDIA_INFERENCE_API_KEY` without being included in command arguments or tracked files.
The hosted run did not use the optional CPU fixture described below.
The CPU fixture requested 2 CPUs and `8Gi` memory, with limits of 8 CPUs and `16Gi`, a `6Gi` model PVC, and a 32,768-token context.
Model serving ingress was enabled only after manifest verification; download egress was removed afterward.
Private inputs, credentials, deployment state, and detailed live logs remain outside tracked repository content.
No package or image was published.

## Observed Results

The [live Kubernetes test](../../crates/nemoclaw-e2e/tests/kubernetes_live.rs) passed all stages in 90.76 seconds: one passed test, zero failures, and zero ignored tests in this explicit run.

| Check | Observed result |
|---|---|
| SDK plan and apply | Created a Ready Kubernetes sandbox and supervisor through the authenticated gateway |
| Inference connectivity | Passed through the declared NVIDIA provider |
| Native OpenClaw response | Returned `FOUR` using the hosted Ultra model and native agent `primary` |
| CLI export | Succeeded; the parsed exported document matched the authored configuration digest |
| SDK reapply of the export | Succeeded with an empty changes list |
| CLI destroy | Removed the owned sandbox, provider, and profile while retaining the workspace and deployment state |

The [Kubernetes hosted example](../../examples/kubernetes/hosted-nvidia.yaml) keeps the Docker fixture's Super model for comparison.
The private configuration for the successful run selected the user-provided Ultra model instead.
After the test completed, explicit apply with that same configuration and retained state succeeded and left the demonstration sandbox and supervisor Running and Ready.
The fresh-cluster rerun below subsequently replaced that installation.

The installer separately passed positive, denied, and restored connectivity checks for both ingress and egress policy enforcement.
An mTLS-only SDK request failed before mutation; the authenticated client proceeded with a bearer token.

## Fresh-Cluster Rerun

The user requested deletion of the original kind cluster and a complete fresh deployment on 2026-09-22.
The guarded cleanup deleted the original node container and local cluster credentials; its ownership receipt records the deleted state.
The replacement used a new private state directory, node identity, Kubernetes namespace identity, cluster CA, OIDC signing material, and deployment UID.
Other kind cluster node identities were unchanged.

The installer deployed Calico, Agent Sandbox, the HTTPS OIDC fixture, and the unmodified pinned OpenShell chart from the fresh state.
Ingress and egress checks each passed allowed, denied, and restored connectivity.
The agent image digest was reverified after loading into the new node.
The native bundle's eight file hashes and current source fingerprint matched the previously tested bundle.
The run used the same NVIDIA Ultra hosted inference configuration; it did not deploy the optional CPU model fixture.

The complete lifecycle test passed again in 66.99 seconds with response `FOUR`, matching export digest, unchanged reapply, and successful destroy: one passed test, zero failures, and zero ignored tests.
Explicit apply with the same fresh configuration and retained state then succeeded; the gateway, issuer, sandbox, and supervisor all reported Running and Ready with zero restarts.
The fresh deployment state and private configuration remain outside the repository.

## Regression Checks

The final workspace run passed 629 tests and left 99 explicitly ignored tests unexecuted, using `RUST_TEST_THREADS=8`.
An earlier run with unrestricted concurrency hit an existing export-lock timing failure; its focused rerun and the complete bounded-concurrency run passed.
Strict workspace Clippy, Cargo formatting, generated schema freshness, and both explicit Kubernetes protocol fixtures passed against the final bundle.
All 36 deterministic Kubernetes tooling tests, explicit Ruff checks, image identity and workspace-seeding checks, retained image-source validation, and Docker Bake contract tests passed.
Documentation validation passed with no errors; Fern skipped its authenticated redirects check because no Fern token was supplied.

Live failures produced regression corrections before the final run:

- The Kubernetes image now matches the upstream driver's UID and GID while preserving workspace mode `0700` and readable runtime sources.
- The image seeds `TMPDIR` before OpenShell's Landlock check runs.
- The agent response probe selects the declared OpenClaw agent when its name differs from the sandbox name and rejects ambiguous agent rosters.
- The CPU fixture provides enough context for OpenClaw's system and tool prompt; the earlier 8,192-token setting rejected a request exceeding 10,000 tokens.

An earlier 0.6B model returned unrelated text and failed the strict response check.
It does not count as a successful agent invocation.
The 4B model accepted the larger context, but its 96 automatically selected inference threads were throttled under the fixture's 8-CPU quota.
That CPU attempt failed the actual-response stage after 324 seconds, before its export and reapply assertions.
The source now sets `LLAMA_ARG_THREADS=8`; deterministic checks passed, but this correction has not been deployed or tested live because the user selected an external LLM endpoint for the next run.
Failed deployments retained their SDK state and were explicitly destroyed before fresh desired state was generated.

## Limits

One earlier live attempt observed a transient upstream Kubernetes request failure followed by OpenShell marking the sandbox stopped, disconnecting its supervisor, and suspending the Sandbox while retaining its PVC.
Inspection of the pinned upstream code was consistent with that sequence: an unsuccessful dependency observation became not-ready, and reconciliation suspended the unavailable sandbox.
This branch does not modify that upstream behavior or qualify long-running reliability.

The SDK uses an external Kubernetes gateway and external inference endpoints; the separate development installer provisions those prerequisites.
Managed `spec.services` and the local managed gateway remain rejected for Kubernetes.
The result does not qualify GPU inference, other harnesses or architectures, arbitrary clusters, production operation, high availability, or broad Kubernetes compatibility.
