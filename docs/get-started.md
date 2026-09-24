<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy OpenClaw with Existing Services

Create one OpenClaw sandbox using an existing OpenShell gateway and inference endpoint, then access its native dashboard.
This development procedure uses a source-built bundle and agent image.
Published installer/release downloads and an end-to-end rehearsal of this procedure on the current revision: **TBD**.

## 1. Prepare the Hosts and Bundle

Complete [the first-deployment prerequisites](prerequisites.md#before-the-first-deployment), including operator-provided gateway and inference access.
The documented image build runs on Linux ARM64; this guide does not establish other runtime platforms.
Run the following commands from the repository root unless a step names another location.

Follow [the native bundle build](build.md#build-a-native-bundle), then add that bundle's `bin` directory to `PATH`.
For a native Linux ARM64 build:

```sh
export PATH="$PWD/dist/linux_arm64/bin:$PATH"
nemoclaw --help
```

Help must list `plan`, `apply`, `export`, and `destroy`.
Keep the bundle unchanged while using the deployment.
If you need to rebuild it, first copy the complete bundle to a dedicated location and put the copy's `bin` directory first on `PATH`.
Use the copied CLI with its matching provider/schema; `--bundle` alone does not select a different CLI executable.

Apply creates resources and checks configuration and readiness.
The later native-agent verification sends an inference request that may incur endpoint charges.
Destroy deletes sandbox files and conversation history.
Review [credential ownership](security.md#credentials-and-authentication) and [data retention](state.md) before continuing.

## 2. Build the Agent Image

Follow [the Fabric image build](inference.md#build-an-image-with-the-configuration-interface) for OpenClaw.
Record the printed immutable image reference and make that exact image available to the gateway's sandbox compute daemon.
The image must include this revision's configuration and dashboard interfaces.
An example's old digest or zero-digest placeholder is not a downloadable release artifact.

## 3. Prepare Desired-State YAML

Use a working directory that does not already contain another deployment.
Copy the maintained [dashboard example](../examples/openclaw-dashboard.yaml) into it:

```sh
mkdir -p .local/first-deployment
cp examples/openclaw-dashboard.yaml .local/first-deployment/deployment.yaml
python3 -c 'import uuid; print(uuid.uuid4())'
```

Edit the copied YAML before executing it:

| Field | Value to supply |
|---|---|
| `metadata.uid` | The fresh UUID printed above; retain it for every operation on this deployment |
| `metadata.name` | Your deployment label |
| `spec.gateway.endpoint` | Your existing gateway's endpoint |
| `spec.gateway.credential` and `spec.gateway.tls` | References required by that gateway; omit optional fields when unused |
| `spec.inferenceProviders[0].endpoint` | Your upstream inference base URL |
| `spec.inferenceProviders[0].provider` and `.api` | The [matching protocol and API](inference.md); the example selects OpenAI Responses |
| `spec.inferenceProviders[0].credential` | An environment reference when the endpoint needs a key |
| `spec.sandboxes[0].image.ref` | The immutable reference from your image build |
| `spec.sandboxes[0].runtime.provider` | `docker` or `podman`, matching the gateway's compute driver |
| The primary route's `overrides.model` | The exact model ID served by your endpoint |
| Other route `overrides` | Limits and reasoning settings supported by that model; remove optional tuning you have not verified |

Keep `gateway.management: external`, sandbox name `assistant`, and loopback dashboard port `18800` to match the access commands.
Update the copied schema comment to `../../schemas/nemoclaw-v1alpha1.schema.json` so editor diagnostics use this checkout's schema.
Use the [field reference](reference/configuration.md) for accepted fields.

For an authenticated inference endpoint, add this under its provider:

```yaml
credential:
  env: INFERENCE_API_KEY
```

Supply `INFERENCE_API_KEY` through your terminal's or secret manager's protected environment facility before operations that require it.
Put the reference in YAML, never the key.
Caller-supplied inference credentials require HTTPS.
Gateway bearer and mTLS references follow [configuration and credentials](usage.md#configuration-and-credentials); mTLS environment values are local file paths.
Deleting an environment variable later does not revoke a key installed in OpenShell or held by the upstream provider.

## 4. Plan, Apply, and Verify

Use the same configuration and state paths throughout:

```sh
nemoclaw plan --state-dir .local/first-deployment/state .local/first-deployment/deployment.yaml
```

Inspect the planned resource changes before applying.
Plan observes the existing services without creating runtime resources or invoking inference.
Authentication, connectivity, or ownership errors must be resolved before proceeding.

```sh
nemoclaw apply --state-dir .local/first-deployment/state .local/first-deployment/deployment.yaml
```

Apply computes its own checked plan, creates the deployment resources, and checks agent configuration and readiness.
Expect exit status zero and JSON with `outcome: "succeeded"`.
Apply does not request a model or agent response; verify a native conversation in the next step.
On failure, keep the YAML, bundle, and state directory and follow [troubleshooting](troubleshooting.md).

Export the observed configuration to a new file:

```sh
nemoclaw export --state-dir .local/first-deployment/state --output .local/first-deployment/exported.yaml
```

Use the export only if the command succeeds.
It contains configuration and credential references, not native files or conversation history.
See [unchanged apply and recovery](usage.md#updates-and-recovery) before using it for subsequent operations.

## 5. Access the Agent

[Select the gateway and workspace](interfaces.md#select-the-gateway-and-workspace) in each terminal used for native access.
Follow [Connect through OpenShell](interfaces.md#connect-through-openshell) to forward port `18800`.
Native authentication and browser pairing must follow the selected Fabric adapter's contract; a qualified procedure for the migrated adapter remains **TBD**.
Keep the forward bound to loopback.

In the native dashboard, send a short prompt such as `Reply with a short greeting.`
Verify an agent reply, which tests this endpoint/model/harness interaction beyond dashboard access or readiness.
It does not establish general model quality or tool reliability.
Browser and first-message rehearsal of this exact procedure: **TBD** — retained historical interface fixtures do not qualify the migrated adapter.

Stop forwarding with Ctrl-C when finished.
The deployment continues running after the client exits.

## 6. Preview Cleanup

When you no longer need the sandbox, preview removal:

```sh
nemoclaw plan --destroy --state-dir .local/first-deployment/state
```

Read [destroy behavior](usage.md#destroy) and preserve needed native data before executing the deletion command there with this state directory.
Destroy has no confirmation prompt and deletes sandbox files and conversation history.
It removes the deployment's provider registrations and agent configuration; the external gateway and inference service remain under their operators' control.
Keep the local state for tracked retained resources and any interrupted teardown.

## Next Steps

- [Change or recover the deployment](usage.md#updates-and-recovery).
- [Choose another inference configuration](inference.md).
- [Select an agent harness](agents.md).
- [Assess migration from an earlier version](migration.md).
