<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenTofu HCL Examples

These projects author provider resources directly instead of compiling a NemoClaw YAML document.
Use the matching native bundle's providers and OpenTofu executable.
Follow [authoring an OpenTofu project](../../docs/build-deploy/opentofu-project.md) for provider installation, credentials, state, and lifecycle ownership.

| Project | Purpose and prerequisites | Expected result and verification |
|---|---|---|
| [travel](travel/main.tf) | One Pi agent with a Docker-hosted Ollama service and a policy allowing HTTPS GET to one site; supply the gateway, model, images, and engine settings declared by the project. | One sandbox using the local model. An integration scenario applies this project against fixtures; a live agent answer requires a separate request. |
| [travel-team](travel-team/README.md) | Six agents with separate grants, local and hosted models, search, and authenticated booking; follow its README for hardware, images, credentials, and supporting services. | Independent sandboxes with templated instructions and hand-off schemas. The README records the booking authentication result and limits; follow its walkthrough to exercise the task. |
| [Kubernetes hosted inference](../platforms/kubernetes/hosted-nvidia.tf) | OpenClaw and Hermes on a managed development gateway with operator-provisioned PVCs and NVIDIA hosted inference. | Two agent sandboxes with retained files. The [Kubernetes setup](../platforms/nemotron-super.md#amd64-kubernetes-with-nvidia-cloud-inference) gives variables, provider setup, teardown, and verification limits. |

For each project, initialize and validate the private working copy, inspect its plan, apply it, and send explicit requests to its agents.
Follow the project's teardown procedure: HCL storage protections and retained resources require the documented destroy targets.
