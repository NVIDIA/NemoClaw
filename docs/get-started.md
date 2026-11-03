<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy Your First OpenClaw Agent

In this tutorial, you configure one OpenClaw sandbox with an existing OpenShell gateway and inference endpoint.
You then plan the deployment, apply it, and send one request to the agent.
The commands use the v1 source-built tools and the maintained `examples/openclaw.yaml` configuration.
A successful apply starts a runtime; only an invocation checks whether the agent replies.

## Prepare the Tools and Services

Complete the [first-deployment prerequisites](prerequisites.md#before-the-first-deployment).
You need a gateway you can operate, an endpoint that serves a known model, the matching OpenShell CLI, Docker Buildx, and `jq` for reading the runtime ID.
The image commands below use a native Linux ARM64 build host and a Docker engine that retains image digests.
The endpoint must be reachable from OpenShell, not only from your client host.
Run commands from the repository root on the client host unless noted otherwise.

[Build a native bundle](build.md#build-a-native-bundle) from this checkout and add its CLI to `PATH`:

```sh
export PATH="$PWD/dist/linux_arm64/bin:$PATH"
nemoclaw --help
```

Check that help lists `plan`, `apply`, and `destroy`.
Keep this bundle unchanged for this deployment; if you rebuild it, keep a separate copy of the original bundle for recovery.
There are no v1 release downloads or installer in this source-build workflow.

[Build the OpenClaw image](build.md#build-agent-images) on the native Linux ARM64 build host:

```sh
cargo images build --platform linux/arm64 openclaw
docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
```

Record the printed `NAME@sha256:DIGEST` reference.
Make that image available to the gateway's sandbox compute daemon and to the engine you will name in the YAML for image inspection.
An image build does not start an agent or prove that a model will reply.

## Configure One Deployment

Copy the maintained example into a new deployment directory and create a fresh UUID:

```sh
mkdir -p .local/first-deployment
cp examples/openclaw.yaml .local/first-deployment/deployment.yaml
uuidgen
```

Edit `.local/first-deployment/deployment.yaml` using the UUID from `uuidgen`.
Keep the example's named provider `local`, named sandbox `assistant`, and agent name `main` for this exercise.
Replace the following illustrative values before planning:

| YAML path | Your value |
|---|---|
| `metadata.uid` | The fresh UUID; keep it for this deployment's lifetime. |
| `metadata.name` | A label for this deployment. |
| `spec.gateway.endpoint` | The existing gateway's client-reachable endpoint. |
| `spec.gateway.engine` | The Docker or Podman engine containing the selected image; match `spec.gateway.runtime.provider`. |
| `spec.inferenceProviders.local.endpoint` | The inference base URL reachable by the gateway. |
| `spec.inferenceProviders.local.provider` and `.api` | The endpoint's protocol and API; the example uses `openai` with `openai-responses`. |
| `spec.sandboxes.assistant.image.ref` | The immutable image reference from the build. |
| `spec.sandboxes.assistant.agent.inference.routes[0].overrides.model` | The exact model ID the endpoint serves. |
| `spec.sandboxes.assistant.agent.inference.routes[0].overrides.maxTokens` | A limit supported by the selected model, or remove this optional override. |

Keep `spec.gateway.management: external`; this deployment does not manage the gateway or inference server.
The external gateway's engine is used for image inspection; it does not transfer ownership of that gateway.
Update the editor schema comment in the copied file to `../../schemas/nemoclaw-v1alpha1.schema.json`.
For other fields, refer to the [configuration reference](reference/configuration.md) and [inference configuration](inference.md).

If your endpoint requires a key, add a reference under `spec.inferenceProviders.local`:

```yaml
credential:
  env: INFERENCE_API_KEY
```

Supply `INFERENCE_API_KEY` through a protected environment facility to the client running plan and apply; do not place its value in YAML.
The caller supplies the key; OpenShell retains the installed value for routing, and the upstream operator controls revocation.
Remove the caller-owned environment value when no longer needed; this does not revoke the upstream key.
Use HTTPS for a credentialed inference endpoint and follow [credential ownership](usage.md#configuration-and-credentials) for gateway authentication.

## Plan and Apply

Plan with the copied YAML and a dedicated state directory:

```sh
nemoclaw plan -o json --progress off --state-dir .local/first-deployment/state .local/first-deployment/deployment.yaml
```

Review the resource changes and the `complete` field.
A zero exit code means the preview succeeded, but `complete: false` means some prerequisites remain deferred.
Resolve deferred work before using this as a complete plan; even `complete: true` does not verify service readiness or an agent reply.
Plan does not invoke inference.

Apply the same YAML and state directory only after reviewing the plan:

```sh
nemoclaw apply -o json --progress off --state-dir .local/first-deployment/state .local/first-deployment/deployment.yaml
```

Apply can create a workspace, provider registration, and sandbox, and start the agent runtime.
It checks configuration and readiness but does not send an inference request.
If apply fails, keep the YAML, original bundle, and full state directory; use [recovery guidance](usage.md#recover-an-interrupted-operation) before retrying or removing anything.

## Send a Verification Request

[Select the gateway and workspace](interfaces.md#select-the-gateway-and-workspace) in the client terminal using the selectors reported by plan or apply.
The OpenShell CLI needs its own gateway authentication; the YAML credential references do not configure its profile.
For a plaintext loopback gateway matching the example's endpoint, use:

```sh
unset OPENSHELL_GATEWAY
export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671
export OPENSHELL_WORKSPACE=REPLACE_WITH_REPORTED_WORKSPACE
```

Replace the endpoint and workspace with the values reported for your deployment.
For an authenticated gateway, follow the [profile selection procedure](interfaces.md#select-the-gateway-and-workspace) instead.

Read the runtime ID for the `assistant` sandbox from this deployment's state, then invoke its agent named `main`:

```sh
RUNTIME_ID=$(jq -er '.resources[] | select(.mode == "managed" and .type == "fabric_agent" and .name == "assistant") | .instances[].attributes.runtime_id | select(type == "string" and length > 0)' .local/first-deployment/state/terraform.tfstate) || exit 1
openshell sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent main --runtime-id "$RUNTIME_ID" --input - <<'JSON'
"Reply with a short greeting."
JSON
```

Stop if the ID check fails; inspect the apply result and state rather than invoking with an empty ID.
This request can incur inference charges and add to the agent's conversation history.
Check both the command outcome and `result.status` in its JSON response; a successful invocation has `result.status: succeeded`.
Inspect `result.output` for the adapter's reply rather than assuming every adapter returns the same output shape.
A reply verifies this particular endpoint, model, and agent request, not general model quality or tool reliability.
The v1 source and opt-in tests do not establish that this procedure has succeeded on your hosts.

## Preview and Remove the Deployment

When finished, preserve any needed sandbox files or conversations before deletion.
Preview removal using the same state directory:

```sh
nemoclaw plan --destroy --state-dir .local/first-deployment/state
```

Review the removal and retained-resource list.
Destroy does not prompt and deletes the sandbox's writable files and conversation history.
If you accept that loss, remove the deployment's owned workloads:

```sh
nemoclaw destroy --state-dir .local/first-deployment/state
```

The external gateway and inference service remain with their operators; local state and some resources can remain after destroy.
If teardown fails, retain the state directory and [resume with the same state](usage.md#destroy).
Refer to [retention and explicit cleanup](usage.md#remove-retained-resources) before removing the state directory or revoking upstream credentials.

## Next Steps

- [Change or recover a deployment](usage.md#updates-and-recovery).
- [Choose another inference configuration](inference.md).
- [Understand deployment data retention](state.md#deletion-and-retention).
