<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Three-Agent Managed Kubernetes Validation

This 2026-09-28 run tests the [three-agent managed sample](../../examples/kubernetes/managed-development.yaml) on a new isolated kind cluster.
It uses the managed backend from commit `b3e964796f1aac7c96609adbfeac6ede6e2a605e` with an expanded live test that invokes every declared agent.
The [accepted Kubernetes branch decision](../design/scope.md#kubernetes-development-branch) permits this disposable development qualification.
The earlier [managed validation](kubernetes-managed-kind-linux-amd64.md) remains a separate record.

## Inputs and Isolation

The client and cluster nodes ran Linux AMD64.
The fixture created Kubernetes `1.35.0` with Calico `3.32.2`, using the exact pins in [sources.json](../../tools/kubernetes/sources.json).
Before SDK apply, the gateway namespace and Agent Sandbox CRD were absent.
The SDK was responsible for installing Agent Sandbox `0.5.0`, development authentication, and the unmodified OpenShell chart.
OpenShell used version `0.0.117-dev.186+g1fe79f539` and the immutable images in [versions.json](../../versions.json).

The sample changed only its deployment UID, explicit context, namespace, local tunnel port, and three image references.
All three agents used `nc-kubernetes-dev@sha256:21289a8eb192fe3b2165220f324c20c4b6785955ac8a88e0478ae7e4c27eb3a7`, containing OpenClaw `2026.9.4`.
Inference used `https://integrate.api.nvidia.com/v1` and `nvidia/nemotron-3-ultra-550b-a55b` through the sample's `NVIDIA_INFERENCE_API_KEY` environment reference.
The credential value, kubeconfig, generated authentication, deployment manifest, observations, and detailed state remained outside Git.
No package or image was published.

## Results

The verified native bundle was `0.1.0-dev.8f66f1f61cd4ab9b`.
A separate observer saw all three agent Pods and all three supervisor Pods Ready.
The gateway, issuer, agents, and supervisors were all Running with zero container restarts at the observation before teardown.
Each agent returned the expected real hosted-model response: `assistant: FOUR`, `researcher: FOUR`, and `reviewer: FOUR`.

The explicitly selected full lifecycle test passed in 217.57 seconds: one passed test, zero failures, and zero ignored tests in that run.

| Check | Observed result |
|---|---|
| Fresh plan and apply | Provisioned development authentication, owned Agent Sandbox prerequisites, OpenShell, and all three sandboxes |
| Network policy enforcement | Allowed, denied, and restored ingress and egress checks passed |
| Native agent responses | Assistant, researcher, and reviewer each returned `FOUR` through the hosted NVIDIA model |
| Unchanged plan | Empty changes list after apply and agent invocation |
| CLI export | Parsed configuration digest matched the authored three-agent manifest |
| SDK reapply | Empty changes list; every root and managed-platform resource ID matched its original value |
| CLI destroy | Removed all sandbox and provider registrations and recorded the deployment as destroyed |
| Kubernetes teardown | No agent or supervisor Pods and no gateway StatefulSet remained; only the retained development issuer Pod remained |
| Retained storage and credentials | The original gateway PVC remained Bound with the same UID; all five credential Secret UIDs were unchanged |

The separate ownership-checked cleanup retired only this disposable kind cluster and removed its local cluster connection files.
This explicit cluster deletion removed the previously retained cluster-side volumes and Secrets.
Private SDK state and test observations remain outside Git.
All 15 preexisting kind node identities were still present and unchanged after cleanup.

## Regression Checks

The workspace passed 657 tests with zero failures; 101 opt-in tests remained ignored in the ordinary run.
Formatting and strict workspace Clippy passed.
Schema and documentation checks passed with no errors and the existing unauthenticated Fern warning.
The new deterministic test rejects missing, duplicated, substituted, and mismatched sandbox bindings before the live helper opens a connection or invokes an agent.
The existing single-agent verification helper retains its previous calling contract.
The expanded helper uses one authenticated managed-gateway tunnel for the sequential agent requests.

## Limits

This run covers the named Linux AMD64 kind environment and hosted model.
It does not establish macOS ARM64, general Kubernetes, production identity, GPU inference, or long-running reliability support.
The generated authentication profile remains development-only.
Fabric's agent-health API is a separate capability from Pod readiness and a verified model response.
