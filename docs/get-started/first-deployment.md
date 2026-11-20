<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploying Your First OpenClaw Agent

In this tutorial, you configure one OpenClaw sandbox with an existing NVIDIA OpenShell gateway and inference endpoint.
You then plan the deployment, apply it, and send one request to the agent.
The commands use the v1 source-built tools and the [OpenClaw example at implementation revision `637bdb6276`](https://github.com/NVIDIA/NemoClaw/blob/637bdb6276309ea71d1f1fcb68fff518fe2db926/examples/openclaw.yaml).
Keep the bundle and generated schema from the source revision used to build the image.
A successful apply starts a runtime.
Only an invocation checks whether the agent replies.

## Preparing the Tools and Services

Complete the [first-deployment prerequisites](prerequisites.md#before-the-first-deployment).
You need a gateway you can operate, an endpoint that serves a known model, the matching OpenShell CLI, Docker Buildx, and `jq` for reading the runtime ID.
The image commands below use a native Linux ARM64 build host and a Docker engine that retains image digests.
The endpoint must be reachable from OpenShell, not only from your client host.

Use a separate worktree at the pinned implementation revision. Do not mix its example, bundle, image, or generated schema with another revision. The [build guide in this documentation checkout](../build-deploy/build.md) describes a newer toolchain; use `docs/build-deploy/build.md` in the pinned worktree for this exercise. Run the following steps on the client host unless a step names the image build host.

1. Fetch the v1 branch from the root of your NemoClaw checkout.

   ```sh
   git fetch origin v1
   ```

2. Create a separate worktree at the pinned revision.

   ```sh
   git worktree add --detach ../nemoclaw-v1 637bdb6276309ea71d1f1fcb68fff518fe2db926
   ```

   Choose another unused directory if `../nemoclaw-v1` exists.
   Don't replace an existing worktree.

3. Enter that worktree.

   ```sh
   cd ../nemoclaw-v1
   ```

4. Prepare the build tools using `docs/build-deploy/build.md` in this worktree ([pinned build prerequisites](https://github.com/NVIDIA/NemoClaw/blob/637bdb6276309ea71d1f1fcb68fff518fe2db926/docs/build-deploy/build.md)).

   Its `rust-toolchain.toml` pins Rust 1.99.1.
   A native bundle also requires Protocol Buffers compiler 36.2 and a C toolchain.

5. Build the native bundle using the [pinned bundle instructions](https://github.com/NVIDIA/NemoClaw/blob/637bdb6276309ea71d1f1fcb68fff518fe2db926/docs/build-deploy/build.md#build-a-native-bundle).

   Keep this bundle unchanged for the deployment.
   If you rebuild it, keep the original bundle for recovery.
   This exercise uses source-built tools rather than release downloads or an installer.

6. Add the bundle's CLI to `PATH`.

   ```sh
   export PATH="$PWD/dist/linux_arm64/bin:$PATH"
   ```

7. Check that the CLI lists `plan`, `apply`, and `destroy`.

   ```sh
   nemoclaw --help
   ```

8. Prepare the native Linux ARM64 build host using `docs/build-deploy/build.md` in the pinned worktree ([pinned image prerequisites](https://github.com/NVIDIA/NemoClaw/blob/637bdb6276309ea71d1f1fcb68fff518fe2db926/docs/build-deploy/build.md#build-agent-images)).

9. Build the OpenClaw image on that host from the same worktree revision.

   ```sh
   cargo images build --platform linux/arm64 openclaw
   ```

10. Inspect the image digest on the build host.

   ```sh
   docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
   ```

   The result is a `NAME@sha256:DIGEST` reference.
   An image build doesn't start an agent or prove that a model will reply.

11. Record that immutable reference for the deployment YAML.

12. Make the image available to the gateway's sandbox compute daemon and the engine named in the YAML for image inspection.

## Configuring One Deployment

Configure the copied example from the pinned worktree.
Keep the deployment identity and state directory for the lifetime of this exercise.

1. Create a deployment directory in the pinned worktree.

   ```sh
   mkdir -p .local/first-deployment
   ```

2. Copy the example into that directory.

   ```sh
   cp examples/openclaw.yaml .local/first-deployment/deployment.yaml
   ```

3. Generate a fresh deployment UUID.

   ```sh
   uuidgen
   ```

4. Edit `.local/first-deployment/deployment.yaml` using that UUID.

   Keep the example's provider key `local`, sandbox key `assistant`, and agent name `main` for this exercise.
   Replace these illustrative values before planning:

   | YAML path | Your value |
   |---|---|
   | `metadata.uid` | The fresh UUID. Keep it for this deployment's lifetime. |
   | `metadata.name` | A label for this deployment. |
   | `spec.gateway.endpoint` | The existing gateway's client-reachable endpoint. |
   | `spec.gateway.engine` | The Docker or Podman engine containing the selected image. Match `spec.gateway.runtime.provider`. |
   | `spec.inferenceProviders.local.endpoint` | The inference base URL reachable by the gateway. |
   | `spec.inferenceProviders.local.provider` and `.api` | The endpoint's protocol and API. The example uses `openai` with `openai-responses`. |
   | `spec.sandboxes.assistant.image.ref` | The immutable image reference from the build. |
   | `spec.sandboxes.assistant.agent.inference.routes[0].overrides.model` | The exact model ID the endpoint serves. |
   | `spec.sandboxes.assistant.agent.inference.routes[0].overrides.maxTokens` | A limit supported by the selected model, or remove this optional override. |

   Keep `spec.gateway.management: external`.
   This deployment doesn't manage the gateway or inference server.
   NemoClaw uses the external gateway's engine for image inspection.
   Using that engine doesn't transfer ownership of the gateway.
   For other fields, use `docs/reference/configuration.md` generated in the pinned worktree alongside its schema.
   The linked [field reference](../reference/configuration.md) belongs to the documentation checkout and can describe a newer revision.
   Refer to [inference configuration](../agents-inference/inference.md) for task-specific choices.

5. Update the editor schema comment in the copied file to `../../schemas/nemoclaw-v1alpha1.schema.json`.

6. If the endpoint requires a key, add a reference under `spec.inferenceProviders.local`.

   ```yaml
   credential:
     env: INFERENCE_API_KEY
   ```

7. If you added a key reference, supply `INFERENCE_API_KEY` through a protected environment facility to the client running plan and apply.

   Don't place its value in YAML.
   The caller supplies the key.
   OpenShell retains the installed value for routing, and the upstream operator controls revocation.
   Use HTTPS for a credentialed inference endpoint.
   Follow [credential ownership](../build-deploy/usage.md#configuration-and-credentials) for gateway authentication.

## Planning and Applying

A plan previews changes without invoking inference. Apply can create a workspace, provider registration, and sandbox, and start the agent runtime. Apply checks configuration and readiness, not whether the model replies.

1. Plan with the copied YAML and a dedicated state directory.

   ```sh
   nemoclaw plan -o json --progress off --state-dir .local/first-deployment/state .local/first-deployment/deployment.yaml
   ```

2. Review the resource changes and the `complete` field. A zero exit code means the preview succeeded. `complete: false` means some prerequisites remain deferred.

3. Resolve deferred work before treating the plan as complete. Even `complete: true` does not verify service readiness or an agent reply.

4. Apply the same YAML and state directory only after reviewing the plan.

   ```sh
   nemoclaw apply -o json --progress off --state-dir .local/first-deployment/state .local/first-deployment/deployment.yaml
   ```

   If apply fails, keep the YAML, original bundle, and full state directory.
   Follow [recovery guidance](../build-deploy/usage.md#recovering-an-interrupted-operation) before retrying or removing anything.

## Sending a Verification Request

A successful apply isn't a model reply.
The OpenShell CLI needs its own gateway authentication.
YAML credential references don't configure its profile.
This request can incur inference charges and add to the agent's conversation history.

1. [Select the gateway](../agents-inference/interfaces.md#selecting-the-gateway-and-workspace) in the client terminal using the plan or apply result.
   For an authenticated gateway, follow the linked profile procedure.
   For a plaintext loopback gateway only, clear the profile selector as follows.

   ```sh
   unset OPENSHELL_GATEWAY
   ```

   Don't use plaintext for an authenticated remote gateway.

2. For a plaintext loopback gateway, set its reported endpoint in that terminal.

   ```sh
   export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671
   ```

   Replace the example endpoint with the reported endpoint.

3. Select the reported workspace in that terminal.

   ```sh
   export OPENSHELL_WORKSPACE=REPLACE_WITH_REPORTED_WORKSPACE
   ```

4. Read the applied agent's runtime ID from a plan using the same credential environment as apply.

   ```sh
   RUNTIME_ID=$(nemoclaw plan -o json --progress off --non-interactive --state-dir .local/first-deployment/state .local/first-deployment/deployment.yaml | jq -er '.agents.assistant.runtimeId') || exit 1
   ```

   Plan changes no runtime resources.
   If this lookup fails, stop and inspect the apply result instead of invoking with an empty ID.

5. Invoke the agent named `main`.

   ```sh
   openshell sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent main --runtime-id "$RUNTIME_ID" --input - <<'JSON'
   "Reply with a short greeting."
   JSON
   ```

6. Check the command exit status.

7. Check `result.status` in the JSON response.
   A successful invocation has `result.status: succeeded`.

8. Inspect `result.output` for the adapter's reply.
   Don't assume every adapter returns the same output shape.
   A reply verifies this endpoint, model, and request, not general model quality or tool reliability.
   The v1 source and opt-in tests don't establish success on your hosts.

## Previewing and Removing the Deployment

Destroy does not prompt. It deletes the sandbox's writable files and conversation history. The external gateway and inference service remain with their operators. Local state and some resources can remain after destroy.

1. Preserve any sandbox files or conversations you need before deletion.

2. Preview removal with the same state directory.

   ```sh
   nemoclaw plan --destroy --state-dir .local/first-deployment/state
   ```

3. Review the removal and retained-resource list.

4. If you accept the loss, remove the deployment's owned workloads.

   ```sh
   nemoclaw destroy --state-dir .local/first-deployment/state
   ```

   If teardown fails, retain the state directory and [resume with the same state](../build-deploy/usage.md#destroying).

5. Review [retention and explicit cleanup](../build-deploy/usage.md#removing-retained-resources) before removing the state directory or revoking upstream credentials.

6. Remove the caller-owned `INFERENCE_API_KEY` environment value if you supplied one.
   This doesn't revoke the upstream key.

## Next Steps

After verifying the request and cleaning up or retaining your test deployment, use the relevant guide for routine operations:

- [Change or recover a deployment](../build-deploy/usage.md#updates-and-recovery).
- [Choose another inference configuration](../agents-inference/inference.md).
- [Understand deployment data retention](../build-deploy/state.md#deletion-and-retention).
