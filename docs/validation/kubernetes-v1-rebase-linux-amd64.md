<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes and OpenShift v1 Rebase Validation

On 2026-10-02, revision `2c50a4695c20b87504613f2857d90ee8b7ae4d12` was tested on Linux AMD64 after rebasing onto v1 `1149b73a3aedad40fb46ba3d8d30a96d2757ff59`.
The [accepted Kubernetes branch scope](../design/scope.md#kubernetes-development-branch) permits this integration and the explicitly requested disposable Kubernetes test.
The rebase preserves the Kubernetes and OpenShift implementation while adopting upstream's stdin configuration and invocation contract.
Both agent images and the native bundle were rebuilt from this revision; older images do not establish compatibility with that contract.

## Offline Checks

| Check | Result |
|---|---|
| Rust workspace | 1,044 passed, zero failed; 140 opt-in tests ignored |
| Rust lint and formatting | Strict workspace Clippy and formatting passed |
| Python lint and formatting | Passed |
| Managed platform tests | 52 passed, including two real renders of the pinned upstream Helm chart |
| Local fixture tests | 65 passed |
| OCI metadata exporter tests | 15 passed |
| Image build-plan tests | 11 passed |
| Documentation and generated schema/reference | Passed; Fern retained one warning |
| Native bundle | Linux AMD64 bundle `0.1.0-dev.419bef209a23ca22` assembled and verified |
| Real OpenTofu with isolated gateway fixtures | Three passed: Kubernetes/OpenShift lifecycle, export/reapply, stable bindings, driver mismatch rejection, and destroy without metadata |
| Interrupted Kubernetes creation | One real-OpenTofu fixture passed recovery without taint or replacement |

The three cluster lifecycle fixtures use the production provider and deterministic gateway/platform responses; the recovery test uses a fixture provider.
These fixtures create no cluster and make no model request.
The bundle used pinned Rust `1.98.1` and protoc `36.1`.
Independent integration review found no lost Kubernetes or OpenShift behavior in the rebase resolutions.

## Agent Images

| Profile | Locally built image index | Checks |
|---|---|---|
| Kubernetes | `sha256:c57307f6b3d353093a56db3355f5aa508e7d0ba9e25ba4fb03c8fbe241423845` | Six smoke checks, seven packaging checks, and five upstream bridge contract checks passed |
| OpenShift | `sha256:c4f4599579209908ef83e2b8859b8af60a3a42571831921683f24924c6dd37d2` | Two namespace UID/GID smoke checks, seven packaging checks, and five upstream bridge contract checks passed |

Each packaging suite skipped two checks for other harnesses; each bridge suite skipped two dummy-only checks.
Image checks disabled networking, made the root filesystem read-only, dropped all capabilities, and enabled no-new-privileges.
Kubernetes checks ran as UID/GID `10001:10001`.
OpenShift namespace and bridge checks ran as UID `1000700000` and GID `1000800000`; its packaging checks ran as the image's declared UID/GID `10001:10001`.
Bridge checks used a private writable sandbox tmpfs owned by the selected UID/GID.
Test source was supplied on stdin so host bind-mount permissions did not prevent access.
Both actual images exported verified OCI metadata without publishing an image.

## Live Kubernetes Readiness Failure

The [complete local runner](../../tools/kubernetes/e2e.py) created a fresh owned kind cluster with Kubernetes `1.35.0`, Calico `3.32.2`, and Agent Sandbox `0.5.0`.
It loaded the Kubernetes image above and used the rebuilt bundle with one generated three-agent managed manifest.
The hosted model was `nvidia/nemotron-3-ultra-550b-a55b` at `https://integrate.api.nvidia.com/v1`.
The private credential was supplied through `NVIDIA_INFERENCE_API_KEY`; image builds and cluster setup did not receive it.
The endpoint initially returned HTTP 503 before any cluster was created; a later preflight passed.

Ingress and egress allow, deny, and restored-allow checks passed.
The SDK provisioned OpenShell, development authentication, and all three sandboxes.
All three Fabric configuration resources reported running, but SDK apply failed its readiness postcondition after **90.31 seconds**.
Each retained health result was `{"supported":false,"report":null,"reason_code":"fabric_health_unsupported"}`.
The full lifecycle test therefore failed: zero passed, one failed, and two other tests filtered out.
It did not reach its agent-response, unchanged-plan, export/reapply, or destroy assertions.

The pinned [Fabric backend](../../image/fabric/backend.py) advertises no native health checks.
The SDK's readiness contract requires a successful native report and rejects unsupported health; this condition also existed before this rebase.
The [upstream image contract qualification](fabric-agent-contract-linux-arm64.md) records the same limit for the interim agent images.
Passing configuration, running pods, and successful model responses cannot substitute for that readiness contract.
The isolated protocol tests above use successful fixture health reports and do not establish live readiness.
No health check was bypassed or changed to make the test pass.
A complete live lifecycle requires Fabric native health support and rebuilt artifacts, followed by a fresh full test.

## Separate Checks After the Failure

The existing retained-state invocation test passed in **25.25 seconds**: one passed, zero failed, and two other tests filtered out.
Assistant, researcher, and reviewer each returned `FOUR` through the installed Fabric adapter and hosted model.
This explicit test uses the retained sandbox bindings; it does not retry apply or override readiness.

CLI export and CLI destroy then both exited successfully.
The retained intent was marked destroyed, and state contained no remaining managed sandbox, provider, provider-profile, or agent-configuration instances.
These checks do not establish unchanged-plan or export/reapply success after the failed apply.

After evidence was retained, the ownership-checked fixture cleanup deleted the disposable cluster and its private kubeconfig.
The cluster receipt reached `deleted`, and no node belonging to that test cluster remained.
All nine recorded preexisting kind node identities were preserved, and the default kubeconfig remained unchanged.
A scan found no supplied inference key or NVIDIA API key pattern in 3,832 retained text evidence and state files.
The feature diff and commit messages also contained no such credential pattern.
Raw evidence, generated authentication material, and deployment state remain private outside Git.
Only this non-secret summary is committed; the following documentation update does not change the tested executable source.

## Limits

OpenShift validation remains offline: no OpenShift cluster/version, SCC admission, persistent storage, runtime isolation, network-policy enforcement, or agent inference was tested.
The [OpenShift qualification requirements](openshift-offline.md#remaining-qualification) remain outstanding.
This run does not qualify ARM64, other Kubernetes distributions, production identity providers, GPU inference, or long-running reliability.
Earlier validation records retain their named source revisions and environment scope.
