<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Get Started with a Deployment

This outline connects the existing v1 procedures.
A self-contained first-deployment walkthrough, rehearsed against a release candidate: **TBD**.

Apply creates or changes runtime resources and can download models and send inference requests.
Use resources you control, a fresh deployment UUID, and a dedicated state directory.
Destroy deletes sandbox files and conversation history; review [data retention](usage.md#destroy) before cleanup.

## 1. Prepare the Hosts and Bundle

Check [prerequisites](prerequisites.md), then follow [the native bundle build](build.md#build-a-native-bundle) from the repository root.
Place the bundle's `bin` directory on `PATH`.
Run `nemoclaw --help` to verify CLI access.

Published installer and release artifact selection: **TBD**.

## 2. Choose an Agent and Inference Configuration

Use [agent runtimes](agents.md) to select a harness and [inference configuration](inference.md) to select its API and service mode.
Build a matching [agent image](agents.md#runtime-lifecycle) and make its immutable digest available to the sandbox engine.
For managed vLLM, also follow [runtime image building](build.md#build-a-runtime-image) and [model selection](models.md).

A single recommended configuration with verified provisioning of all prerequisites: **TBD**.

## 3. Prepare Desired-State YAML

Start from a maintained [example](../examples/).
Replace its deployment UUID, image references, endpoints, model, and credential references for your environment.
Read [resource ownership](usage.md#resource-ownership) and use the matching [configuration reference](reference/configuration.md).

Keep the entire state directory for subsequent operations.
Do not reuse an earlier product's state directory as a v1 deployment.

## 4. Plan, Apply, and Verify

From the repository root, follow the [plan/apply/export/reapply sequence](usage.md) using your prepared YAML and state directory.
Review the plan before apply; apply produces its own checked plan.
Use [inference verification](inference.md#verify-the-result) to distinguish observed configuration from a real agent reply.

If an operation fails, retain the configuration and state and follow [troubleshooting](troubleshooting.md).

## 5. Access the Agent

Follow [native agent access](agents.md) and [agent interfaces](interfaces.md) for the selected harness.
OpenClaw and Hermes interface settings must match the image and deployment configuration.

One verified first-message walkthrough for each harness, including expected output: **TBD**.

## 6. Preview Cleanup

Use [the destroy procedure](usage.md#destroy) to preview and remove owned workloads.
Read [deployment state](state.md) first if native files or conversation history must survive.
Configuration export alone does not back them up.
