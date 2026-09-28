<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes Integration with Current v1

On 2026-09-28, the merge candidate integrating v1 `02c2b6ba21649076e6aef46258659642898f1aa7` into Kubernetes branch tip `8bc6c554c7d42c7db198e9b9f7568db44970f21f` passed the checks below on Linux AMD64.
The [accepted Kubernetes branch scope](../design/scope.md#kubernetes-development-branch) permits this integration with the upstream SDK lifecycle and Fabric ownership boundaries.
The verified native bundle was `0.1.0-dev.52e8531b98ed9c7b`, built with pinned Rust `1.98.1` and protoc `36.1`.

## Observed Results

| Check | Result |
|---|---|
| Workspace tests | 931 passed, zero failed; 123 opt-in tests ignored |
| Kubernetes lifecycle with real OpenTofu and isolated gateway fixtures | Two passed: plan, apply, export/reapply, stable bindings, driver-drift rejection, destroy, and rejection of a Docker gateway before mutation |
| Provider protocol with real OpenTofu and isolated fixtures | Four passed: incomplete Kubernetes creation resumes without replacement; identity survives later creation failure; failed observations and registration drift reconcile; hardware checks run during validation, planning, and saved-plan apply |
| Kubernetes fixture Python tests | 65 passed, including runner, hosted-authentication preflight, and canonical Fabric adapter selection |
| Managed-platform Python tests | 40 passed |
| Image build-plan tests | Eight passed |
| Formatting and linting | Rust formatting, strict workspace Clippy, Python lint, and Python formatting passed |
| Native bundle | Linux AMD64 bundle assembled and verified |

Regression tests first exposed Docker engine discovery in a managed Kubernetes graph and loss of established retained storage during teardown.
The fixes restrict local-engine discovery to Docker and Podman and retain only Kubernetes storage already present in state.
Another regression test verifies that the optional local fixture emits the installed `nvidia.fabric.*` adapter identifiers.
These tests passed after the fixes.

## Limits and Retesting

This run used isolated fixtures for OpenShell and platform operations.
It did not create a kind cluster, build or run the updated agent image, invoke hosted inference, or modify an existing deployment.
The earlier [Linux runner result](kubernetes-script-linux-amd64.md) predates this Fabric integration and does not qualify the updated invocation path.

Before a new live test, rebuild the native bundle and agent image from the same checkout and use fresh deployment state.
Keep the original bundle with any older retained state for inspection or teardown.
The [single-command kind procedure](../testing/kubernetes-kind.md#run-the-complete-test) performs those builds and creates isolated test state.
