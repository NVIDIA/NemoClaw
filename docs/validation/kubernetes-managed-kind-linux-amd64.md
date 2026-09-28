<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed Kubernetes Development Validation

Recorded on 2026-09-28 for the managed Kubernetes changes on `codex/kubernetes-backend`, based on commit `5f73a0bc2db42cf1746b582aab6dbdadff9bd3e4`.
The [accepted branch decision](../design/scope.md#kubernetes-development-branch) permits SDK provisioning, generated development authentication, and owned prerequisite installation.
The SDK provisioned OpenShell and three OpenClaw agents from managed YAML on an existing disposable kind cluster.
One agent returned `FOUR` from the hosted NVIDIA Ultra model.
Use the [managed gateway procedure](../kubernetes.md#provision-a-managed-development-gateway) and [local kind guide](../testing/kubernetes-kind.md#test-the-managed-yaml-path) to reproduce the setup.

## Environment and Inputs

The client and cluster nodes used Linux AMD64.
The cluster-only fixture installed Kubernetes `1.35.0` and Calico `3.32.2`; it did not install OpenShell or Agent Sandbox.
The SDK installed Agent Sandbox `0.5.0`, the unmodified pinned OpenShell chart, and its generated development authentication during apply.
Source checksums and image digests came from [sources.json](../../tools/kubernetes/sources.json) and [versions.json](../../versions.json).
The OpenShell version was `0.0.117-dev.186+g1fe79f539`, revision `1fe79f53991debf32776853a60f0cbd4e127dcfb`.

| Input | Identity |
|---|---|
| OpenClaw image | `nc-kubernetes-dev@sha256:21289a8eb192fe3b2165220f324c20c4b6785955ac8a88e0478ae7e4c27eb3a7` |
| OpenClaw version | `2026.9.4` |
| Hosted endpoint | `https://integrate.api.nvidia.com/v1`, API `openai-completions` |
| Hosted model | `nvidia/nemotron-3-ultra-550b-a55b` |
| Inference credential reference | `NVIDIA_INFERENCE_API_KEY`, loaded privately by the client |
| OpenTofu | `1.12.6` |

Private manifests, kubeconfig, signing keys, certificates, inference credentials, deployment receipts, and detailed state remained outside Git.
No package or image was published.
The SDK selected the cluster through an explicit kubeconfig reference and context; it never invoked kind.
The cluster fixture preserved other clusters and did not change host packages, drivers, or kernel settings.

## Observed Lifecycle

The initial single-agent apply and inference used native bundle `0.1.0-dev.860d2b40edf2d137`.
The three-agent export and unchanged reapply used rebuilt bundle `0.1.0-dev.aeeffbb580151075`, which added the response-only test interface.

| Check | Result |
|---|---|
| Fresh plan | Planned two managed platform resources and deferred agent planning until the gateway existed |
| Managed apply | Installed prerequisites, development authentication, and OpenShell before creating the agent |
| Network policy enforcement | Passed allowed, denied, and restored ingress and egress probes |
| Hosted agent response | The explicit response-only test returned `FOUR` |
| Scale from one to three agents | Created only researcher and reviewer sandboxes; preserved the gateway and first agent |
| Pod readiness | All three agents, three supervisors, the gateway, and the development issuer were Running and Ready |
| Export and reapply | Both the single-agent and three-agent exports reapplied with empty changes lists |
| Destroy | Removed all three sandboxes, inference registrations, and the OpenShell release; retained the workspace and Kubernetes storage |
| Retention observation | The gateway PVC stayed Bound, generated credential Secrets and the issuer remained, and gateway StatefulSets were absent |

## Final-Bundle Rerun

Bundle `0.1.0-dev.374adc9b94fe8581` includes the final Helm release-content ownership checks.
The explicit full lifecycle test passed in 173.93 seconds: one passed test, zero failures, zero ignored tests in that selected run.
It used a fresh deployment UID, namespace, private authentication material, and SDK state on the same owned disposable cluster.
It passed SDK plan/apply, a real `FOUR` response, CLI export with a matching configuration digest, unchanged SDK reapply, and CLI destroy.

The SDK verified and preserved the existing compatible Agent Sandbox installation from the first deployment.
All ten prerequisite object UIDs matched between the two receipts.
After destroy, the second gateway PVC was still Bound, its five generated credential Secrets and issuer remained, and no gateway StatefulSet remained.
The SDK retained the workspace and platform storage bindings.

The separate ownership-checked fixture cleanup then deleted only the test cluster and its local cluster connection files.
That deliberate cluster deletion removed the retained cluster volumes and credentials; private SDK state remained outside Git.
Other clusters were preserved.

## Regression Checks and Limits

The workspace passed 656 tests with zero failures; 101 opt-in tests remained ignored in the ordinary run.
Cargo formatting and strict workspace Clippy passed.
All 40 managed-backend Python tests and 37 kind-fixture tests passed, along with pinned Ruff checks.
Schema and documentation validation passed with no errors; the Fern check reported its existing unauthenticated redirects warning.
Four explicit tests against pinned OpenTofu passed, including incomplete Kubernetes creation recovery without taint or replacement and the dependent-resource block.
Deterministic tests cover explicit targeting, ownership and identity substitution, missing credentials, partial provisioning, helper cancellation, and tunnel lifetime.
Additional negative tests reject changed Helm release payloads under an unchanged Secret UID and changed chart objects during resumed teardown; status-only Helm changes preserve the recovery binding.
They do not establish live failure recovery on every Kubernetes distribution.

Apply reported `fabric_health_unsupported` for each agent.
Pod readiness and the one real model response are separate observations; they do not establish Fabric health support or model responses from all three agents.
This result does not qualify macOS ARM64, GPU inference, other clusters, admission policies, storage implementations, production identity, or long-running reliability.
The generated authentication profile is for disposable development use and requires the operator to preserve private state until retirement.
