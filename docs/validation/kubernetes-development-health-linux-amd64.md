<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes Development Lifecycle with Unsupported Fabric Health

On 2026-10-02, the explicit [development test mode](../testing/kubernetes-kind.md#test-with-unsupported-fabric-health) passed on Linux AMD64 at source revision `77b3c0e6f2e4f20bede0d2d7c10d28519ec8db4b`.
The [accepted Kubernetes branch scope](../design/scope.md#kubernetes-development-branch) permits this test-only exception requested by the user.
This result leaves native Fabric health unverified and does not qualify normal CLI/SDK apply.
The earlier [strict lifecycle failure](kubernetes-v1-rebase-linux-amd64.md#live-kubernetes-readiness-failure) remains valid for its recorded revision and health contract.

## Inputs and Scope

The runner used `--allow-unsupported-fabric-health` with a privately supplied `NVIDIA_INFERENCE_API_KEY`.
It rebuilt Linux AMD64 bundle `0.1.0-dev.19bd1594eceaabb2` and local Kubernetes image index `sha256:f89323ca8cdeab8196339f5a99a8d65ed8c88359f15511a2fa01844c1037dab8` from the same checkout.
No image was published.
It created a fresh kind cluster using Kubernetes `1.35.0`, Calico `3.32.2`, and Agent Sandbox `0.5.0` with the pinned upstream OpenShell chart and generated development authentication.
Assistant, researcher, and reviewer used the installed Fabric OpenClaw adapter and `nvidia/nemotron-3-ultra-550b-a55b` through the hosted NVIDIA endpoint.
The credential was excluded from build and cluster-setup subprocesses.

## Observed Results

The complete runner exited zero and printed `PASS (development)` with an explicit unverified-health message.
The selected lifecycle test passed in **245.48 seconds**: one passed, zero failed, and seven other tests filtered out.
This duration excludes image/bundle builds and cluster preparation and cleanup.

| Check | Result |
|---|---|
| Hosted endpoint preflight | Accepted the supplied credential and returned an inference result |
| Cluster networking | Ingress and egress allow, deny, and restored-allow checks passed |
| Initial SDK apply | Provisioning completed; apply returned the unsupported-health error |
| Test-only allowance | Verified fresh exact unsupported observations, matching sandbox/configuration bindings, and settled retained intent |
| Agent invocation | All three agents returned `FOUR` |
| Unchanged plan | No resource changes; identities remained stable |
| CLI export | Succeeded and preserved the document digest |
| SDK reapply | Returned only the same unsupported-health error; the allowance was independently revalidated with fresh observations |
| Reapply verification | Resource identities remained stable; a subsequent plan had no changes |
| CLI destroy | Removed managed agent/provider instances and marked intent destroyed |
| Fixture cleanup | Deleted only the owned cluster and its private kubeconfig; receipt reached `deleted` |
| Isolation | All 16 recorded preexisting node identities were preserved; default kubeconfig unchanged |

Both ordinary SDK applies retained their failure result; the test did not rewrite health or successful-apply state.
The completion marker appeared only after every lifecycle assertion, including destroy, passed.
The runner required that marker before reporting success or deleting the owned cluster.
A scan found no supplied inference key or NVIDIA API key pattern in 3,805 retained text evidence and state files.
Raw evidence, deployment state, and generated private authentication material remain outside Git.

## Deterministic Validation

The Rust workspace passed 1,048 tests with zero failures and 141 opt-in tests ignored.
Strict workspace Clippy, Rust formatting, Python lint/formatting, and documentation/schema checks passed; Fern retained one warning.
All 68 local Python fixture tests passed.
The focused Rust target passed five tests, with its three live tests ignored.
The new positive allowance and runner-selection tests failed before implementation and passed afterward.
Negative cases reject other apply failures, failed or unknown health, missing or malformed observations, stale tokens, pending provisioning, mismatched ownership/configuration, and incomplete or foreign postconditions.
Independent code and documentation reviews passed.

## Limits

This mode explicitly tolerates unsupported health during development testing; it does not skip or weaken normal SDK/provider checks.
Native Fabric readiness, ordinary apply success, OpenShift, ARM64, production authentication, and other Kubernetes environments are not qualified by this run.
The following result-documentation update changes no tested executable source or dependency.
