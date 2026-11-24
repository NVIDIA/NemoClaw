<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deployment Examples

Start with [OpenClaw on Docker using NVIDIA hosted inference](platforms/docker/README.md).
It creates a managed gateway and one agent sandbox without a local model server or GPU.
You need Docker, a source-built native bundle and agent image, and an NVIDIA API key.

## Choose a Use Case

| Goal | Examples |
|---|---|
| Deploy one agent using an existing gateway and model endpoint | [Agent configurations](agents/README.md) |
| Share models, select several providers, set policies, or add tools | [Configuration features](features/README.md) |
| Run inference locally or deploy to another environment | [Platform configurations](platforms/README.md) |
| Author resources directly in OpenTofu HCL | [HCL projects](features/README.md#hcl-projects) |
| Find examples by hardware, harness, runtime, model, or capability | [Discovery guides](guides/README.md) |
| Prepare a GTC DC target | [GTC DC readiness index](gtc-dc/README.md) |

`agents/` contains the smallest configurations that demonstrate each harness.
`features/` demonstrates individual capabilities and combinations, including web search, permissions, multiple sandboxes, multiple providers, and travel-agent configurations.
`platforms/` contains environment-specific deployments, organized by gateway/sandbox backend, then runtime or scenario, then hardware where it distinguishes variants.
The backends are Docker, Kubernetes, OpenShift, and Podman; a remote model server's engine does not determine the backend folder.
Each example has one canonical location. The guides link to those files without copying configurations.
Authored HCL projects and their supporting files stay with their scenario.
`onboarding/` retains the starter used by the authoring tools.
`gtc-dc/` preserves event paths as relative symlinks to canonical platform configurations.
Edit the canonical file; do not replace an event symlink with a copy.
On a Windows checkout without symlink support, open the canonical platform path instead.

## Prepare and Run a YAML Example

Run commands from the repository root using tools and images built from this checkout.
The [build guide](../docs/build-deploy/build.md) lists bundle and image prerequisites.
Family READMEs identify extra hardware, endpoints, credentials, and setup steps.
The [first-deployment tutorial](../docs/get-started/first-deployment.md) is a separate exercise pinned to an older implementation revision; keep its files and tools together.

1. Copy the selected YAML into a private deployment directory.

   ```sh
   mkdir -p .local/example
   cp examples/onboarding/openclaw.yaml .local/example/deployment.yaml
   ```

2. Assign a fresh `metadata.uid` from `uuidgen` and replace the image references with immutable references from your builds.
   Committed digests can name development artifacts or placeholders; their presence does not make the image available on your engine.
   Replace illustrative endpoints, model names, engine sockets, and cluster settings as the selected example requires.
   Use unused ports and nonoverlapping networks.
   Set the copied file's editor schema path to `../../schemas/nemoclaw-v1alpha1.schema.json`.

3. Supply the referenced credentials through the caller's environment.
   Keep values out of YAML and shell history.
   Follow [credential storage and ownership](../docs/build-deploy/usage.md#configuration-and-credentials).
   Hosted model requests can incur charges.

4. Use the native bundle's CLI to plan and apply the copy.

   ```sh
   nemoclaw plan --state-dir .local/example/state .local/example/deployment.yaml
   nemoclaw apply --state-dir .local/example/state .local/example/deployment.yaml
   ```

   Plan previews resource changes. Apply creates the declared resources and checks readiness.
   Apply does not ask the model a question.
   If it fails, retain the state and follow [recovery guidance](../docs/build-deploy/state.md).

5. Send an explicit [agent request](../docs/agents-inference/agents.md#running-one-agent-request), or a [headless OpenClaw request](../docs/agents-inference/agents.md#running-one-headless-openclaw-request).
   Expect a completed request with an answer from each selected agent.
   A feature that involves search or tools also needs a request that exercises that capability.

6. Check convergence and export the deployment.

   ```sh
   nemoclaw apply --state-dir .local/example/state .local/example/deployment.yaml
   nemoclaw export --state-dir .local/example/state --output .local/example/exported.yaml
   nemoclaw apply --state-dir .local/example/state .local/example/exported.yaml
   ```

   Unchanged applies should report no resource changes.

7. Destroy the workloads when finished.

   ```sh
   nemoclaw destroy --state-dir .local/example/state
   ```

   Destroy retains data under the [storage retention contract](../docs/build-deploy/state.md#deletion-and-retention).
   External gateways and model services remain under their operator's control.

## Verification Status

The SDK tests parse YAML examples, check their schema, round-trip their intent, and compile their declared resources.
Selected examples also have integration scenarios against fixtures; those results do not establish a live deployment or model response.
Platform READMEs record existing live evidence and its environment limits.
Unless a README identifies such evidence, treat live deployment and agent responses as unverified for that example.
Moving a file or passing configuration checks does not qualify another model, harness, or platform.

## Existing Deployments

The organization preserves filenames and configuration values, including variants with similar settings.
Existing deployments must keep their own identity, configuration, and state when using these examples for reference.
