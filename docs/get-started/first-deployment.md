<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploying Your First OpenClaw Agent

For Windows ARM64, use [onboarding from source](from-source.md), which builds the current checkout in WSL2 and creates a managed gateway.
This tutorial instead uses the v0.1.0 release and an existing gateway, with a shell on Linux or macOS.

Use NemoClaw Agent Configs v0.1.0 to deploy one OpenClaw agent and verify a reply. This exercise uses an existing OpenShell gateway and inference service. NemoClaw manages the deployment's workspace and sandbox, not the gateway or model server.

## Preparing the Tools and Services

Use a shell on Linux or macOS with `curl`, `jq`, and `uuidgen`. Complete the [first-deployment prerequisites](prerequisites.md#before-the-first-deployment) before changing the gateway. Run the commands from a new directory on the client host. Keep the CLI, example, schema, and image on the same release.

1. [Install the v0.1.0 CLI bundle](install.md).
2. Download the [tagged OpenClaw example](https://github.com/NVIDIA/NemoClaw/blob/v0.1.0/examples/agents/openclaw.yaml) as `deployment.yaml`.

   ```sh
   curl -fL https://raw.githubusercontent.com/NVIDIA/NemoClaw/v0.1.0/examples/agents/openclaw.yaml -o deployment.yaml
   ```

3. Record the OpenClaw image's `NAME@sha256:DIGEST` reference from the image table in the [v0.1.0 release notes on GitHub](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0). Do not use the example's placeholder or a mutable image tag.
4. Confirm that the gateway's sandbox engine can acquire that digest. If the registry requires credentials, follow [private registry setup](../build-deploy/usage.md#pulling-from-private-registries) before applying.

## Configuring One Deployment

Keep the example's `external` gateway management mode, `local` provider key, `assistant` sandbox key, and `main` agent name. Use the schema from the verified bundle, not a schema from a different checkout.

1. Generate a fresh deployment UUID.

   ```sh
   uuidgen
   ```

2. Set the deployment-specific values in `deployment.yaml`.

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

3. Point the editor's `# yaml-language-server: $schema=...` comment at `schemas/nemoclaw-v1alpha1.schema.json` inside the extracted `dist/PLATFORM` directory.
4. If the gateway requires authentication, configure its credential or TLS references using [the external gateway credential procedure](../build-deploy/usage.md#supplying-credential-references).
5. If the inference endpoint requires a key, add this reference under `spec.inferenceProviders.local`. Use HTTPS for a credentialed inference endpoint.

   ```yaml
   credential:
     env: INFERENCE_API_KEY
   ```

6. Supply any referenced values to the NemoClaw process through a protected environment facility. Keep secret values out of YAML and shell history. OpenShell retains the installed inference credential for routing. Only its upstream issuer can revoke it.

## Planning and Applying

Plan previews resource changes without invoking inference or pulling images. Apply computes its own checked plan and starts the runtime. Neither operation verifies a reply.

1. Generate a preview with a new state directory.

   ```sh
   nemoclaw plan -o json --progress off --state-dir .nemoclaw-first deployment.yaml
   ```

2. Review the exit status, resource changes, and `complete` field. Stop on an error. A zero exit status means the preview succeeded, not that it is complete.
3. Review `deferred` prerequisites and `unverified` advisories separately. A missing image on the selected engine can defer adapter compatibility. If that is the only deferred check and you expect the release digest to be available, apply can resolve it: NemoClaw pulls and checks the image before configuring the deployment. Resolve unexpected changes or other unresolved prerequisites before proceeding. Advisories alone do not make a plan incomplete.
4. Apply the reviewed YAML with the same state directory.

   ```sh
   nemoclaw apply -o json --progress off --state-dir .nemoclaw-first deployment.yaml
   ```

5. Check the exit status and confirm the JSON reports `outcome: succeeded`. On failure, stop. Keep the YAML, bundle, and entire state directory for [recovery](../build-deploy/usage.md#recovering-an-interrupted-operation).
6. Record `connection.gatewayEndpoint` and `connection.workspace` from the apply result.

## Sending a Verification Request

This request can incur inference charges and add to the agent's conversation history.

1. For a plaintext or mTLS gateway, use `nemoclaw osh --state-dir .nemoclaw-first --` to select the saved deployment automatically. For a bearer-token gateway, [select the reported gateway and workspace](../agents-inference/interfaces.md#selecting-a-standalone-cli-for-bearer-token-gateways) in a separately configured CLI and replace that prefix with `openshell` below.
2. If using the standalone CLI, select the reported workspace in the same shell. The bundled CLI selects it automatically.

   ```sh
   export OPENSHELL_WORKSPACE=REPLACE_WITH_REPORTED_WORKSPACE
   ```

3. Save a fresh plan using the same credential environment as apply. If the command fails, stop before looking up a runtime ID.

   ```sh
   nemoclaw plan -o json --progress off --non-interactive --state-dir .nemoclaw-first deployment.yaml > applied-plan.json
   ```

4. Read the runtime ID for `assistant`. If this lookup fails, stop and inspect the apply result and [runtime diagnostics](../observability/troubleshooting.md#inference-and-agent-readiness). Do not invoke with an empty ID.

   ```sh
   RUNTIME_ID=$(jq -er '.agents.assistant.runtimeId | strings | select(length > 0)' applied-plan.json)
   ```

5. Invoke `main` through Fabric inside the sandbox.

   ```sh
   nemoclaw osh --state-dir .nemoclaw-first -- sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent main --runtime-id "$RUNTIME_ID" --input - <<'JSON'
   "Reply with a short greeting."
   JSON
   ```

6. Check the command's exit status. Stop on failure and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
7. Verify that the outer `status` is `succeeded`.
   This alone does not establish that the agent completed the request.
8. Verify that `result.status` is `succeeded`.
   If either status is missing or not `succeeded`, stop and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
   Do not replay an invocation with unknown effects.
9. Verify that `result.output.response` contains a short greeting.
   If the reply is missing or unexpected, stop and consult [inference and agent readiness](../observability/troubleshooting.md#inference-and-agent-readiness).
   A reply verifies this request against the selected endpoint and model, not a platform or harness matrix.

## Previewing and Removing the Deployment

Destroy does not prompt. It removes the deployment's sandbox, workspace, and owned provider registrations and profiles. The sandbox's writable files and conversation history are lost. The external gateway and inference service remain. Images and local deployment state remain too.

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
