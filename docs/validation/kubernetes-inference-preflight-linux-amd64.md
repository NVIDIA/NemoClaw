<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes Inference Authentication Preflight Validation

On 2026-09-28, the candidate extending `70aba660960aa513d25e2e3be7e5c69b84c800d9` passed `python3 tools/kubernetes/e2e.py --check-inference` on Linux AMD64.
The [accepted Kubernetes branch decision](../design/scope.md#kubernetes-development-branch) permits this explicitly invoked hosted-model check for the local fixture.
The request used the managed sample's `nvidia/nemotron-3-ultra-550b-a55b` model at `https://integrate.api.nvidia.com/v1/chat/completions`.
The authorized key was supplied privately through `NVIDIA_INFERENCE_API_KEY`; no key value entered the command arguments or output.

The command exited zero and reported that the endpoint accepted the request and returned a valid result.
It created no deployment state or cluster and ran no build.
This checks the host's credential and route; it does not verify credential substitution or inference inside a sandbox.
The earlier [full lifecycle result](kubernetes-script-linux-amd64.md) remains a separate qualification of the preceding runner revision.

All 64 fixture Python tests passed, including 19 runner tests and eight inference-check tests.
They cover rejection before state creation and setup, response and error redaction, redirect refusal, TLS verification, bounded response size and total deadline, response closure, and credential-preserving retry guidance.
The unchanged Rust workspace passed 658 tests with 101 opt-in tests ignored; formatting and strict Clippy passed.
Schema and documentation checks passed with their existing single warning.
Independent code and documentation review found no remaining consequential issues.

The user's Mac sandbox `HTTP 401` remains undiagnosed until the key exported on that host is checked.
The [recovery procedure](../testing/kubernetes-kind.md#run-the-complete-test) distinguishes a rejected host request from a sandbox-only credential failure.
An inference-only retry does not replace an installed provider credential, and changing a value under the same environment reference does not trigger credential rotation.
