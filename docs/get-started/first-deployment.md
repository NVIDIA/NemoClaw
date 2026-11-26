<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploying Your First OpenClaw Agent

Deploy one OpenClaw agent with the v0.1.0 CLI, a local Docker engine, and a model served by NVIDIA Endpoints.
NemoClaw creates an OpenShell gateway, workspace, and sandbox from the release's example YAML.
You finish when OpenClaw returns a greeting, then remove the resources created by the tutorial.
The procedure starts containers and sends a request that can incur inference charges.

If you already run a gateway and model endpoint, [use those services](#using-an-existing-gateway-and-inference-endpoint).
To build the CLI and agent image yourself, [deploy Hermes from a checkout](from-source.md) on Apple silicon or WSL2.

## Preparing the Tools and Services

Use a shell on Linux or Apple silicon macOS with `curl`, `jq`, and `uuidgen`.
On Windows AMD64 or ARM64, [prepare Ubuntu under WSL2](prerequisites.md#preparing-windows-with-wsl2) and run every command in that Linux shell.

1. [Install the v0.1.0 CLI bundle](install.md).
   In WSL2, use the <a href="./install?language=linux#installing-on-linux-or-macos">Linux archive</a> in Ubuntu, not the native Windows installer.
   The Linux and macOS bundles include OpenShell. A local Docker deployment needs no standalone client.
2. Verify the version.

   ```sh
   nemoclaw --version
   ```

3. Create a new private working directory.

   ```sh
   deployment_dir=$(mktemp -d "$HOME/nemoclaw-first.XXXXXXXX")
   ```

   Continue only if the command succeeds. Each run creates a separate directory under your home directory.
4. Change to the new directory in the same shell.

   ```sh
   cd "${deployment_dir:?Create the working directory first}"
   ```

   Run the rest of the tutorial from this directory. Stop if `cd` fails.

5. Find the OpenClaw `NAME@sha256:DIGEST` in the **Images** table of the [v0.1.0 release notes](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0).
   Use the digest from the same release as the CLI bundle.

## Configuring One Deployment

The default walkthrough uses a local engine and NVIDIA Endpoints. For an external deployment, [configure your existing services](#using-an-existing-gateway-and-inference-endpoint) instead.

### Using Local Docker and NVIDIA Endpoints

The managed example creates a gateway on the same Docker engine that runs the sandbox.

1. Start Docker Engine on Linux or inside WSL2, or [Docker Desktop](https://docs.docker.com/desktop/) on Apple silicon.
2. Check access to the selected engine.
   On Linux or WSL2, use `unix:///var/run/docker.sock`.
   On macOS, use the local socket shown by `docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}'`.

   ```sh
   DOCKER_ENGINE=unix:///var/run/docker.sock
   docker --host "$DOCKER_ENGINE" version
   ```

   Expect both a Docker client and server.
3. Pull the OpenClaw image by its release digest on that engine.

   ```sh
   OPENCLAW_IMAGE='REPLACE_WITH_RELEASE_IMAGE_AND_DIGEST'
   docker --host "$DOCKER_ENGINE" pull "$OPENCLAW_IMAGE"
   ```

   If the registry requires authentication, [sign in with Docker](https://docs.docker.com/reference/cli/docker/login/) before retrying. Proceed only after the pull succeeds.
4. Get an [NVIDIA Endpoints API key](https://build.nvidia.com/settings/api-keys).
5. Choose a model available to your account through the OpenAI Completions API.
6. Download the [tagged managed Docker example](https://github.com/NVIDIA/NemoClaw/blob/v0.1.0/examples/onboarding/openclaw.yaml).

   ```sh
   curl -fL https://raw.githubusercontent.com/NVIDIA/NemoClaw/v0.1.0/examples/onboarding/openclaw.yaml -o deployment.yaml
   ```

7. Generate a fresh deployment UUID with `uuidgen`.
8. Edit `deployment.yaml` for your engine, image, and model.
   Keep the `managed` gateway mode, NVIDIA Endpoints provider, `assistant` sandbox key, and `NVIDIA_API_KEY` credential reference.

   | YAML Path | Value |
   |---|---|
   | `metadata.uid` | The new UUID. Keep it for the lifetime of the deployment. |
   | `spec.gateway.target.docker` | Replace `{}` with a mapping that has an `engine` key set to the same socket you used to pull the image. |
   | `spec.sandboxes.assistant.image.ref` | The OpenClaw digest reference from the release. |
   | `spec.sandboxes.assistant.agent.inference.routes[0].overrides.model` | The exact model ID available to your NVIDIA Endpoints account. |

The YAML names the credential variable, not its value.
Supply `NVIDIA_API_KEY` through a protected environment facility or enter the key at the hidden prompt during interactive apply.

## Planning and Applying

Plan previews resource changes without invoking inference or pulling images.
Apply computes its own checked plan, starts the runtime, and installs any inference credential in OpenShell for routing.
Keep credential values out of YAML and shell history.

### Previewing the Deployment

Use a new state directory for this deployment.

1. Point the YAML's `# yaml-language-server: $schema=...` comment at `schemas/nemoclaw-v1alpha1.schema.json` in your bundle.
   The bundle root is `/usr/local/nemoclaw` for the macOS package or `dist/PLATFORM` in the archive's installation directory.
2. Generate a preview.

   ```sh
   nemoclaw plan -o json --progress off --state-dir .nemoclaw-first deployment.yaml
   ```

3. Check the exit status. If the preview failed, stop before reviewing or applying it.
   If the first plan failed because the Docker gateway port is occupied or the subnet overlaps, follow these steps:

   1. Set the target's `port` to a free port or its `networkCIDR` to a non-overlapping private `/24`, depending on the error.
   2. Rerun the preview.

   If a port conflict occurs after a successful plan, [free the bound port instead of changing it](../build-deploy/usage.md#recovering-an-interrupted-operation).
   For other errors, see [deployment troubleshooting](../observability/troubleshooting.md#identifying-the-failure).

### Reviewing the Plan

A zero exit status does not mean the preview is complete.

1. Review the planned changes. Stop if any change is unexpected.
2. Check the `complete` field.
3. Review `deferred` checks separately from `unverified` advisories. Advisories alone do not make the plan incomplete.
   Proceed only if every remaining deferral is expected to resolve during apply.
   For example, an initial plan can be incomplete if apply must start a fresh gateway, prompt for a missing inference key, or pull an image absent from the engine.
   Stop for unexplained deferrals or prerequisites that apply cannot resolve.
   Generate a new preview after any YAML edit.

### Applying the Reviewed Configuration

Apply only the YAML you reviewed.

1. Apply the reviewed YAML with the same state directory. The command saves the result to `apply.json`.

   ```sh
   nemoclaw apply -o json --progress off --state-dir .nemoclaw-first deployment.yaml > apply.json
   ```

2. Check the exit status. On failure, stop and keep the YAML, bundle, and entire state directory for [recovery](../build-deploy/usage.md#recovering-an-interrupted-operation).
3. Verify that `apply.json` reports `"outcome": "succeeded"`. Stop if it does not. This result confirms deployment, not inference.

## Sending a Verification Request

This request can incur inference charges and add to the agent's conversation history.

For local Docker and plaintext or mutual TLS gateways, the bundled client uses the saved deployment selection.
If you configured an [existing gateway](#using-an-existing-gateway-and-inference-endpoint) with OIDC or bearer-token authentication, complete the corresponding agent-access handoff first.

1. Read the agent name and runtime ID for `assistant` from the successful apply result.
   If either lookup fails, stop and inspect [runtime diagnostics](../observability/troubleshooting.md#inference-and-agent-readiness).

   ```sh
   AGENT=$(jq -er '.agents.assistant.agent | strings | select(length > 0)' apply.json) &&
     RUNTIME_ID=$(jq -er '.agents.assistant.runtimeId | strings | select(length > 0)' apply.json)
   ```

2. Send one JSON prompt through Fabric inside the sandbox.
   If you prepared a standalone client, replace `nemoclaw osh --state-dir .nemoclaw-first --` with `openshell` or its absolute path.
   The command saves the Fabric result to a private file without overwriting any earlier result.

   ```sh
   (umask 077; set -C
   nemoclaw osh --state-dir .nemoclaw-first -- sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent "$AGENT" --runtime-id "$RUNTIME_ID" --input - > reply.json <<'JSON'
   "Reply with a short greeting."
   JSON
   )
   ```

3. Check the command's exit status. Stop on failure and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
4. Check both Fabric statuses. Expect `true`: the outer `status` and the agent's `result.status` must both be `succeeded`.

   ```sh
   jq -e '.status == "succeeded" and .result.status == "succeeded"' reply.json
   ```

   If the check fails, stop and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
   Do not replay an invocation with unknown effects.
5. Read the OpenClaw reply without printing the rest of the Fabric result.

   ```sh
   jq -er '.result.output.response | strings | select(length > 0)' reply.json
   ```

   Expect a short greeting. If it is missing or unexpected, stop and consult [inference and agent readiness](../observability/troubleshooting.md#inference-and-agent-readiness).
   This verifies the request for the selected endpoint and model, not general compatibility.

## Previewing and Removing the Deployment

Destroy does not prompt.
It removes the deployment's sandbox, workspace, and owned provider registrations and profiles.
It also removes a gateway created by the deployment.
The sandbox's writable files and conversation history are lost.
Externally managed services, images, and local deployment state remain.

### Previewing Cleanup

If the external gateway configuration references a credential or TLS files, set the corresponding environment variables before previewing cleanup. Use an unexpired credential. Neither preview nor destroy prompts for these values.

1. Preserve any agent files or conversations you need.
2. Preview removal with the original bundle and state directory.

   ```sh
   nemoclaw plan --destroy -o json --state-dir .nemoclaw-first
   ```

3. Check the preview's exit status. On failure, stop, keep the state directory, and consult [deployment troubleshooting](../observability/troubleshooting.md#identifying-the-failure).
4. Verify that the preview reports `"complete": true"`.
   If it is incomplete, stop and resolve the reported blockers before continuing.
5. Review the planned removals and any retained resources.

### Removing the Reviewed Deployment

Start a new destroy only after a successful, complete preview.

1. Destroy the deployment only if you accept the listed removals.

   ```sh
   nemoclaw destroy --state-dir .nemoclaw-first
   ```

2. Check the destroy result.
   If it fails, keep the entire state directory and follow the [teardown recovery guidance](../observability/troubleshooting.md#identifying-the-failure).

### Handling Retained Resources and Credentials

After destroy succeeds, decide whether to keep the remaining resources and local state.

1. Review [retention and explicit cleanup](../build-deploy/usage.md#removing-retained-resources) before deleting local state.
2. Clear any caller-owned credential variables that you no longer need.
   This does not revoke the upstream credentials.

## Using an Existing Gateway and Inference Endpoint

Use this configuration in place of local Docker and NVIDIA Endpoints. You need permission to create a workspace and sandbox on the existing gateway.

### Checking Service Compatibility

Check the gateway and inference endpoint before editing the deployment example.

1. Complete [Preparing the Tools and Services](#preparing-the-tools-and-services).
2. Obtain the gateway endpoint and credentials from its operator.
3. Verify that the gateway reports the OpenShell version pinned as `components.gateway.version` in the release's [`version-pins.json`](../references/compatibility.md#using-one-release-together).
4. Confirm the gateway's compute driver. This example supports Docker or Podman; your YAML target must match the reported driver.
5. Verify that the inference endpoint is reachable from OpenShell and supports the chosen [request API](../agents-inference/inference.md#choosing-the-request-api).

### Configuring the External Deployment

Use the service settings you verified to prepare the external example.

1. Download the [tagged external gateway example](https://github.com/NVIDIA/NemoClaw/blob/v0.1.0/examples/agents/openclaw.yaml).

   ```sh
   curl -fL https://raw.githubusercontent.com/NVIDIA/NemoClaw/v0.1.0/examples/agents/openclaw.yaml -o deployment.yaml
   ```

2. Generate a fresh deployment UUID with `uuidgen`.
3. Edit `deployment.yaml` for your services. Keep the `external` gateway mode, `local` provider key, and `assistant` sandbox key.

   | YAML Path | Value |
   |---|---|
   | `metadata.uid` | The new UUID. Keep it for the lifetime of the deployment. |
   | `metadata.name` | A label for this deployment. |
   | `spec.gateway.endpoint` | The existing gateway's client-reachable endpoint. |
   | `spec.gateway.target.docker.engine` | The engine that runs the gateway's sandboxes. For Podman, replace `target.docker` with `target.podman` and name that engine. |
   | `spec.inferenceProviders.local.endpoint` | The inference base URL reachable from OpenShell, not just from your client. |
   | `spec.inferenceProviders.local.provider` and `.api` | The endpoint's provider and request API. The example uses `openai` with `openai-responses`. |
   | `spec.sandboxes.assistant.image.ref` | The OpenClaw digest reference from the release. |
   | `spec.sandboxes.assistant.agent.inference.routes[0].overrides.model` | The exact model ID the endpoint serves. |
   | `spec.sandboxes.assistant.agent.inference.routes[0].overrides.maxTokens` | A limit the model supports. You can omit this override. |

4. Confirm that the sandbox engine can acquire the image digest. If it needs registry credentials, follow [private registry setup](../build-deploy/usage.md#pulling-from-private-registries).
5. If the gateway requires authentication, [configure gateway credential or TLS references](../build-deploy/usage.md#supplying-credential-references). For OIDC, include the [operator-provided login settings](../references/cli.md#logging-in-to-an-oidc-gateway).
6. For a credentialed HTTPS inference endpoint, add this reference under `spec.inferenceProviders.local`.

    ```yaml
    credential:
      env: INFERENCE_API_KEY
    ```

7. Supply the referenced values through a protected environment facility.
8. Follow [Planning and Applying](#planning-and-applying) with the external example.

### Preparing Agent Access on an Existing Gateway

For plaintext or mutual TLS (mTLS), the bundled client needs no separate setup. For other gateways, complete the matching procedure before sending a request.

For external OpenID Connect (OIDC), the JSON apply result contains the registration arguments. The text equivalent is the `Register once:` command.

1. Display the registration command.

   ```sh
   jq -er '.connection.openshellRegistration | select(type == "array" and length > 0) | ["nemoclaw", "osh", "--state-dir", ".nemoclaw-first", "--"] + . | @sh' apply.json
   ```

   If the command is absent, stop and check the [OIDC configuration](../references/cli.md#logging-in-to-an-oidc-gateway).
2. Run the displayed command to [register and sign in](../references/cli.md#logging-in-to-an-oidc-gateway). OpenShell stores and renews the sign-in tokens.

For bearer tokens without OIDC settings, the bundle does not handle interactive agent access:

1. [Prepare a standalone OpenShell CLI](prerequisites.md#preparing-the-standalone-openshell-cli).
2. [Select the gateway and workspace](../agents-inference/interfaces.md#selecting-a-standalone-cli-for-bearer-token-gateways) using `connection.gatewayEndpoint` and `connection.workspace` in `apply.json`.

After any required setup, return to the shared walkthrough:

1. Follow [Sending a Verification Request](#sending-a-verification-request).
2. Follow [Previewing and Removing the Deployment](#previewing-and-removing-the-deployment) when you are done. Teardown leaves the external gateway and inference endpoint intact.

## Next Steps

For your own deployment, [author deployment YAML](onboard.md) or choose another [inference setup](../agents-inference/inference.md). For an existing deployment, use the [operation and recovery guide](../build-deploy/usage.md#updates-and-recovery).
