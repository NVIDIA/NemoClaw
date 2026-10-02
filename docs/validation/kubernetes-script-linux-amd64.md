<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Single-Command Kubernetes Test Validation

On 2026-09-28, the [local runner](../../tools/kubernetes/e2e.py) completed the full managed Kubernetes test on Linux AMD64.
The candidate extends `5d7227c20f1b745eec8a8437d11820690b2e1641` with the runner and fixed inference-probe diagnostics.
The [accepted Kubernetes branch decision](../design/scope.md#kubernetes-development-branch) permits this isolated, explicitly invoked kind test.
Use the [single-command procedure](../testing/kubernetes-kind.md#run-the-complete-test) to repeat it.

## Inputs

The runner selected `linux_amd64` for the native bundle and `linux/amd64` for the agent image.
It used the existing pinned Rust `1.98.1` and protoc `36.1` installations and existing noninteractive sudo for Docker.
The verified bundle was `0.1.0-dev.ec42eaf24d106667`.
The locally built agent image index was `sha256:66e3662f624a0bf62cb6773d1ba4fcc9b9015b8f0b9d8c5977d0413a45b7ff84`.
No image was published.

The runner generated a new deployment UID, private kubeconfig, explicit context, and loopback tunnel port from the [three-agent managed sample](../../examples/kubernetes/managed-development.yaml).
The fixture used Kubernetes `1.35.0`, Calico `3.32.2`, and Agent Sandbox `0.5.0` from the existing source pins.
The SDK installed development authentication and the unmodified pinned OpenShell chart.
Inference used `nvidia/nemotron-3-ultra-550b-a55b` at `https://integrate.api.nvidia.com/v1` through `NVIDIA_INFERENCE_API_KEY`.
The key was loaded from private operator storage into the runner environment without printing it or adding it to command arguments.
The runner compiled the test without the key, then passed it to the compiled test executable.

## Observed Results

The runner exited with status zero.
The full lifecycle test passed in 234.08 seconds: one passed, zero failed, and one unrelated test filtered out.

| Check | Result |
|---|---|
| Build and platform setup | Native bundle and image built; fresh kind cluster created; digest reference loaded and verified |
| Network policy | Ingress and egress allow, deny, and restored-allow checks passed |
| Managed apply | Gateway, development authentication, prerequisites, and all three sandboxes provisioned |
| Native inference | Assistant, researcher, and reviewer each returned `FOUR` through the hosted model |
| Plan and export | Unchanged plan was empty; CLI export matched the authored configuration digest |
| SDK reapply | Empty changes; every original root and managed-platform resource ID preserved |
| CLI destroy | Sandbox and provider registrations removed; retained intent marked destroyed |
| Fixture cleanup | Owned cluster deleted, ownership receipt marked deleted, private kubeconfig removed |
| Isolation | All 20 preexisting kind node identities preserved; default kubeconfig unchanged |
| Credential handling | Supplied key absent from runner log, generated manifest, run metadata, retry command, and changed source files |

Private SDK state, ownership evidence, and the test log remain outside Git.
Deleting the disposable cluster removed its cluster-side volumes and Secrets.

## Regression Checks and Limits

The workspace passed 658 tests with zero failures; 101 opt-in tests remained ignored in the ordinary run.
Formatting, strict workspace Clippy, schema, and documentation checks passed; documentation retained its existing single warning.
The 53 fixture Python tests, including 16 runner tests, and 40 managed-platform Python tests passed.
The Node inference-probe suite passed, including fixed failure categories and empty-output checks with credential and private-endpoint sentinels.
Runner tests cover private fresh state, key isolation and redaction, pinned compiler preparation, architecture selection, an earlier standalone Cargo on a simulated Mac PATH, failure retention, guarded cleanup, subprocess interruption, and readable compiler failures.
Independent code and documentation review found no remaining consequential issues.

This live result covers Linux AMD64 kind and the named hosted model.
Apple silicon selection has deterministic tests but still requires a live run on that host.
The result does not establish general Kubernetes compatibility, production authentication, or long-running reliability.
The user's earlier Mac inference failure was not reproduced or diagnosed by this successful Linux run; rebuilt images now report a bounded failure category and sandbox name if it recurs.
