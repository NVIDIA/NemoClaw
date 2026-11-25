<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploying Your First OpenClaw Agent

Deploy one OpenClaw agent with the v0.1.0 CLI, a local Docker engine, and a model served by NVIDIA Endpoints.
NemoClaw creates an OpenShell gateway, workspace, and sandbox from the release's example YAML.
The procedure starts containers and sends a request that can incur inference charges.

If you already run a gateway and model endpoint, [use those services](#using-an-existing-gateway-and-inference-endpoint).
To build the CLI and agent image yourself, [deploy Hermes from a checkout](from-source.md) on Apple silicon or WSL2.

## Preparing the Tools and Services

Use a shell on Linux or Apple silicon macOS with `curl`, `jq`, and `uuidgen`.
On Windows AMD64 or ARM64, [prepare Ubuntu under WSL2](prerequisites.md#preparing-windows-with-wsl2) and run every command in that Linux shell.

1. [Install the v0.1.0 CLI bundle](install.md) and verify the version with `nemoclaw --version`.
2. [Prepare the standalone OpenShell CLI](prerequisites.md#preparing-the-standalone-openshell-cli) at the version pinned by the release.
3. Create a new private working directory, such as `mkdir -m 700 ~/nemoclaw-first`, and change to it.
   Keep `deployment.yaml` and `.nemoclaw-first` in this directory.
4. In the **Images** table of the [v0.1.0 release notes](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0), find the OpenClaw `NAME@sha256:DIGEST` reference to use in the following steps.
   Use the digest from the same release as the CLI bundle.

## Configuring One Deployment

### Using Local Docker and NVIDIA Endpoints

1. Start a local Docker Engine on Linux or WSL2, or [Docker Desktop](https://docs.docker.com/desktop/) on Apple silicon.
   On Linux or WSL2, use `unix:///var/run/docker.sock`.
   On macOS, use the local Docker Desktop socket shown by `docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}'`.
2. Check that your user can reach the selected engine, then pull the OpenClaw image by its release digest on that engine.
   Replace the example socket and image with your values.

   ```sh
   DOCKER_ENGINE=unix:///var/run/docker.sock
   OPENCLAW_IMAGE='REPLACE_WITH_RELEASE_IMAGE_AND_DIGEST'
   docker --host "$DOCKER_ENGINE" version &&
     docker --host "$DOCKER_ENGINE" pull "$OPENCLAW_IMAGE"
   ```

   If the registry requires authentication, [sign in with Docker](https://docs.docker.com/reference/cli/docker/login/) and retry the pull.
   Proceed after the pull succeeds.
3. Get an [NVIDIA Endpoints API key](https://build.nvidia.com/settings/api-keys) and select a model available to your account through the OpenAI Completions API.
4. Download the [tagged managed Docker example](https://github.com/NVIDIA/NemoClaw/blob/v0.1.0/examples/onboarding/openclaw.yaml).

   ```sh
   curl -fL https://raw.githubusercontent.com/NVIDIA/NemoClaw/v0.1.0/examples/onboarding/openclaw.yaml -o deployment.yaml
   ```

5. Run `uuidgen` and edit `deployment.yaml`.
   Keep the example's `managed` gateway mode, NVIDIA Endpoints provider, and `assistant` sandbox key.

   | YAML Path | Value |
   |---|---|
   | `metadata.uid` | The new UUID. Keep it for the lifetime of the deployment. |
   | `spec.gateway.target.docker` | Replace `{}` with a mapping that has an `engine` key set to the same socket you used to pull the image. |
   | `spec.sandboxes.assistant.image.ref` | The OpenClaw digest reference from the release. |
   | `spec.sandboxes.assistant.agent.inference.routes[0].overrides.model` | The exact model ID available to your NVIDIA Endpoints account. |

6. Keep the `NVIDIA_API_KEY` credential reference in the YAML.
   Supply the key through a protected environment facility or enter it at the hidden prompt during interactive apply.

Continue to [Planning and Applying](#planning-and-applying).

### Using an Existing Gateway and Inference Endpoint

Complete [Preparing the Tools and Services](#preparing-the-tools-and-services) before continuing.
Use an OpenShell gateway with Docker or Podman and permission to create a workspace and sandbox.
Get its reachable endpoint and any credentials from its operator.
The gateway's reported OpenShell version must match `components.gateway.version` in the release's [`version-pins.json`](../references/compatibility.md#using-one-release-together).
Its reported compute driver must match your YAML target.
Confirm that the inference endpoint is reachable from OpenShell and supports the chosen [request API](../agents-inference/inference.md#choosing-the-request-api).

1. Download the [tagged external gateway example](https://github.com/NVIDIA/NemoClaw/blob/v0.1.0/examples/agents/openclaw.yaml) and generate a fresh deployment UUID.

   ```sh
   curl -fL https://raw.githubusercontent.com/NVIDIA/NemoClaw/v0.1.0/examples/agents/openclaw.yaml -o deployment.yaml &&
     uuidgen
   ```

2. Set the deployment-specific values in `deployment.yaml`.
   Keep the `external` gateway mode, `local` provider key, and `assistant` sandbox key.

   | YAML Path | Value |
   |---|---|
   | `metadata.uid` | The new UUID. Keep it for the lifetime of the deployment. |
   | `metadata.name` | A label for this deployment. |
   | `spec.gateway.endpoint` | The existing gateway's client-reachable endpoint. |
   | `spec.gateway.target.docker.engine` | The Docker engine that runs the gateway's sandboxes. For Podman, replace `target.docker` with `target.podman` and name that engine. |
   | `spec.inferenceProviders.local.endpoint` | The inference base URL reachable from OpenShell, not just from your client. |
   | `spec.inferenceProviders.local.provider` and `.api` | The endpoint's provider and request API. The example uses `openai` with `openai-responses`. |
   | `spec.sandboxes.assistant.image.ref` | The OpenClaw digest reference from the release. |
   | `spec.sandboxes.assistant.agent.inference.routes[0].overrides.model` | The exact model ID the endpoint serves. |
   | `spec.sandboxes.assistant.agent.inference.routes[0].overrides.maxTokens` | A limit the model supports. You can omit this override. |

3. Confirm that the gateway's sandbox engine can acquire the image digest.
   If it requires registry credentials, follow [private registry setup](../build-deploy/usage.md#pulling-from-private-registries).
4. If the gateway requires authentication, configure its credential or TLS references using [the external gateway credential procedure](../build-deploy/usage.md#supplying-credential-references).
   [Set up the OpenShell profile](prerequisites.md#preparing-the-standalone-openshell-cli) for native access with the operator's credentials.
5. For a credentialed HTTPS inference endpoint, add this reference under `spec.inferenceProviders.local`.

   ```yaml
   credential:
     env: INFERENCE_API_KEY
   ```

6. Supply the referenced values through a protected environment facility.

## Planning and Applying

Point the `# yaml-language-server: $schema=...` comment in `deployment.yaml` at `schemas/nemoclaw-v1alpha1.schema.json` in your installed bundle.
The bundle root is `/usr/local/nemoclaw` for the macOS package or `dist/PLATFORM` inside the directory where you extracted the archive.
Plan previews resource changes without invoking inference or pulling images.
Apply computes its own checked plan, starts the runtime, and installs any inference credential in OpenShell for routing.
Keep credential values out of YAML and shell history.

1. Generate a preview with a new state directory.

   ```sh
   nemoclaw plan -o json --progress off --state-dir .nemoclaw-first deployment.yaml
   ```

2. Review the exit status, resource changes, and `complete` field. Stop on an error. A zero exit status means the preview succeeded, not that it is complete.
3. Review `deferred` prerequisites and `unverified` advisories separately.
   A new managed gateway defers checks until apply makes it reachable.
   An unset inference key can also be deferred until the apply prompt.
   Apply can also pull and check a release image that is absent from the selected engine.
   If the first plan fails because the gateway port or subnet is occupied, [choose unused values](../build-deploy/usage.md#recovering-an-interrupted-operation) and plan again.
   Resolve unexpected changes or missing prerequisites before proceeding.
   Advisories alone do not make a plan incomplete.
4. Apply the reviewed YAML with the same state directory and save the result.

   ```sh
   nemoclaw apply -o json --progress off --state-dir .nemoclaw-first deployment.yaml > apply.json
   ```

5. Check the exit status and confirm the JSON reports `outcome: succeeded`. On failure, stop. Keep the YAML, bundle, and entire state directory for [recovery](../build-deploy/usage.md#recovering-an-interrupted-operation).
6. Record `connection.gatewayEndpoint` and `connection.workspace` from the apply result.

## Sending a Verification Request

The OpenShell CLI authenticates separately from NemoClaw. This request can incur inference charges and add to the agent's conversation history.

1. [Select the reported gateway](../agents-inference/interfaces.md#selecting-the-gateway-and-workspace) using its OpenShell profile, or the plaintext loopback procedure only if the gateway uses plaintext on loopback.
2. Select the reported workspace in the same shell.

   ```sh
   export OPENSHELL_WORKSPACE=REPLACE_WITH_REPORTED_WORKSPACE
   ```

3. Read the agent name and runtime ID for `assistant` from the successful apply result.
   If either lookup fails, stop and inspect [runtime diagnostics](../observability/troubleshooting.md#inference-and-agent-readiness).

   ```sh
   AGENT=$(jq -er '.agents.assistant.agent | strings | select(length > 0)' apply.json) &&
     RUNTIME_ID=$(jq -er '.agents.assistant.runtimeId | strings | select(length > 0)' apply.json)
   ```

4. Invoke the agent through Fabric inside the sandbox.

   ```sh
   openshell sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent "$AGENT" --runtime-id "$RUNTIME_ID" --input - <<'JSON'
   "Reply with a short greeting."
   JSON
   ```

5. Check the command's exit status. Stop on failure and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
6. Verify that the outer `status` is `succeeded`.
   This alone does not establish that the agent completed the request.
7. Verify that `result.status` is `succeeded`.
   If either status is missing or not `succeeded`, stop and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
   Do not replay an invocation with unknown effects.
8. Verify that `result.output.response` contains a short greeting.
   If the reply is missing or unexpected, stop and consult [inference and agent readiness](../observability/troubleshooting.md#inference-and-agent-readiness).
   A reply verifies this request against the selected endpoint and model, not a platform or harness matrix.

## Previewing and Removing the Deployment

Destroy does not prompt.
It removes the deployment's sandbox, workspace, and owned provider registrations and profiles.
It also removes a gateway created by the deployment.
The sandbox's writable files and conversation history are lost.
Externally managed services, images, and local deployment state remain.

1. Preserve any agent files or conversations you need.
2. Preview removal with the original bundle and state directory.

   ```sh
   nemoclaw plan --destroy -o json --state-dir .nemoclaw-first
   ```

3. Verify that the preview exited successfully and reports `complete: true`.
   If it failed or is incomplete, stop without running destroy.
   Keep the state directory and consult [destroy troubleshooting](../build-deploy/usage.md#destroying).
4. Review the planned removals and any retained resources.
5. Destroy the deployment only if you accept the listed removals.

   ```sh
   nemoclaw destroy --state-dir .nemoclaw-first
   ```

6. Check the destroy result.
   If it fails, keep the entire state directory and [resume teardown](../build-deploy/usage.md#destroying) with the same state.
7. Review [retention and explicit cleanup](../build-deploy/usage.md#removing-retained-resources) before deleting local state.
8. Clear any caller-owned credential variables that you no longer need.
   This does not revoke the upstream credentials.

## Next Steps

For your own deployment, [author deployment YAML](onboard.md) or choose another [inference setup](../agents-inference/inference.md). For an existing deployment, use the [operation and recovery guide](../build-deploy/usage.md#updates-and-recovery).
