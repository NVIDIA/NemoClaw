<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes Lifecycle with the Integrated Fabric Runtime

On 2026-09-28, the complete [local test runner](../../tools/kubernetes/e2e.py) passed on Linux AMD64 at revision `4df1efc9285c9ee89c24fc9b27c1faecb7ad0c36`.
This run validates the managed Kubernetes path after integration with current v1 and its installed Fabric adapters.
The [accepted Kubernetes branch scope](../design/scope.md#kubernetes-development-branch) permits this explicitly requested disposable test.

## Inputs

The runner rebuilt the native bundle and Kubernetes agent image from the same checkout.
The bundle identity was `0.1.0-dev.fbf695cf7014f5d1`.
The locally built agent image index was `sha256:759aafde8aaa885cd17bcfea2617393125fe23b131802cff1094ab6799e028f7`.
No image was published.

The fixture created a fresh kind cluster with Kubernetes `1.35.0`, Calico `3.32.2`, and Agent Sandbox `0.5.0` using the [pinned artifacts](../../tools/kubernetes/sources.json).
The SDK provisioned the pinned upstream OpenShell chart and development authentication from one generated managed manifest.
Its three OpenClaw agents used `nvidia.fabric.openclaw` and `nvidia/nemotron-3-ultra-550b-a55b` through `https://integrate.api.nvidia.com/v1`.
The supplied key was entered through a hidden prompt and passed as `NVIDIA_INFERENCE_API_KEY`; build and cluster setup subprocesses did not receive it.

## Observed Results

The runner exited with status zero.
The full lifecycle test passed in **238.76 seconds**: one passed, zero failed, and one unrelated test filtered out.
This duration excludes the bundle and image builds and cluster preparation.

| Check | Result |
|---|---|
| Hosted authentication preflight | The endpoint accepted the supplied key and returned a valid result |
| Image contract | Four smoke tests passed for installed Python sources, the Fabric adapter, UID/GID `10001:10001`, and private writable workspace directories |
| Cluster network policy | Ingress and egress allow, deny, and restored-allow checks passed |
| Managed apply | OpenShell, development authentication, prerequisites, and all three sandboxes provisioned |
| Agent invocation | Assistant, researcher, and reviewer each passed the `FOUR` response check through the installed Fabric runtime and hosted model |
| Unchanged plan and export | Plan was empty; CLI export preserved the configuration digest |
| SDK reapply | No changes; resource IDs remained stable |
| CLI destroy | Agent resources removed and retained intent marked destroyed; the workspace binding remained as designed |
| Fixture cleanup | Owned cluster deleted, receipt marked deleted, and private kubeconfig removed |
| Isolation | All 20 preexisting kind node identities and the default kubeconfig were unchanged |
| Credential check | No NVIDIA API key pattern found in 899 retained text evidence and state files |

Private state, generated authentication material, and raw logs remain outside Git.
The repository and PR receive only this non-secret result summary.
The image smoke tests used stdin because the host test file was not readable through a bind mount by UID `10001`; container isolation and test assertions were unchanged.

## Limits

This result covers the named Linux AMD64 kind environment, managed development authentication, three OpenClaw agents, and hosted model.
It does not qualify macOS ARM64, other Kubernetes distributions, production authentication, GPU inference, or long-running reliability.
Earlier [integration fixture checks](kubernetes-v1-integration-linux-amd64.md) and [historical live results](README.md) retain their original revision scope.
Use the [single-command procedure](../testing/kubernetes-kind.md#run-the-complete-test) for a fresh run.
