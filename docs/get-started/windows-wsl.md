<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding on Windows Through WSL2

Use this path on Windows ARM64, which has no native NemoClaw bundle.
It builds the current checkout's Linux ARM64 bundle and Hermes image, authors a deployment, creates a managed Docker gateway, and verifies one agent reply.
Keep the bundle, image, YAML, and state directory together throughout the exercise.
This procedure uses hosted NVIDIA Endpoints inference; it does not require a local GPU model server.

## Preparing Windows and WSL

Install WSL2 with an ARM64 Ubuntu distribution and Docker Desktop with its WSL2 backend.
In Docker Desktop, enable integration for that distribution under **Settings > Resources > WSL Integration**.
Enable **Use containerd for pulling and storing images** under **Settings > General**, apply the change, and start Docker Desktop.
Switching image stores preserves the inactive store's images and containers but hides them until switched back.

In PowerShell, list your distributions and enter the intended one:

```powershell
wsl --list --verbose
wsl -d Ubuntu
```

Replace `Ubuntu` with your distribution's name.
Every remaining command uses Bash inside WSL.
Keep the checkout on the Linux filesystem, such as under `~/src`, to avoid Windows filesystem overhead.

Check the architecture and engine:

```sh
uname -m
docker version
docker info --format '{{json .DriverStatus}}'
```

Expect `aarch64`, a Docker server as well as a client, and `io.containerd.snapshotter.v1` in the driver status.
If the server is missing, start Docker Desktop and check WSL integration before continuing.

## Building the Checkout

Install Git, curl, a C toolchain, and Rust through your Linux distribution and [Rust's installer](https://www.rust-lang.org/tools/install).
The checkout's `rust-toolchain.toml` selects the required Rust version.
Clone the branch you intend to test, then run all build commands from its root:

```sh
git clone --branch v1 https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw
cargo ci tools
export PROTOC="$PWD/.tools/protoc-36.2/bin/protoc"
cargo run --locked -p nemoclaw-build -- bundle
export PATH="$PWD/dist/linux_arm64/bin:$PATH"
type -a nemoclaw
nemoclaw --version
nemoclaw --help
```

The first build compiles dependencies before installing the pinned tools.
The resolved executable must belong to this checkout's bundle, and help must list `onboard`, `plan`, `apply`, and `destroy`.
An existing NemoClaw Classic installation is a different CLI.
Refer to the [build guide](../build-deploy/build.md) for prerequisites and build failures.

Build the agent image from this same checkout:

```sh
cargo images build --platform linux/arm64 hermes
docker image inspect nc-fabric:hermes --format '{{index .RepoDigests 0}}'
```

Expect a `NAME@sha256:DIGEST` reference.
An empty digest list cannot supply the required immutable image reference; check the image-store setting and rebuild.
A tag or Docker image config ID does not replace that reference.

## Preparing the Matching OpenShell CLI

The OpenShell CLI used to invoke the agent must match this checkout's pin.
With `jq` installed, download and verify that archive into a local tools directory:

```sh
CLIENT_VERSION=$(jq -er '.openshell' versions.json) || exit 1
CLIENT_DIR="$PWD/.tools/openshell/$CLIENT_VERSION"
mkdir -p "$CLIENT_DIR"
curl -fL "$(jq -er '.platforms.linux_arm64.openshell.url' versions.json)" -o "$CLIENT_DIR/archive.tar.gz"
printf '%s  %s\n' "$(jq -er '.platforms.linux_arm64.openshell.sha256' versions.json)" "$CLIENT_DIR/archive.tar.gz" | sha256sum --check || exit 1
tar -xzf "$CLIENT_DIR/archive.tar.gz" -C "$CLIENT_DIR"
export PATH="$CLIENT_DIR:$PATH"
openshell --version
```

Stop if verification fails. The version must match `openshell` in `versions.json`.
Installing another OpenShell CLI does not configure its gateway profile.
Other versions remain in their own directories; [host client selection](../agents-inference/agents.md#selecting-the-host-openshell-client) describes release pins and external-gateway compatibility.

## Authoring and Applying a Deployment

Get an API key from [NVIDIA Endpoints](https://build.nvidia.com/settings/api-keys).
Read it without placing the value in shell history:

```sh
read -rsp 'NVIDIA API key: ' NVIDIA_API_KEY
printf '\n'
export NVIDIA_API_KEY
nemoclaw onboard --output deployment.yaml
```

Choose Hermes, a fresh deployment name, Docker, NVIDIA Endpoints, and a model available to your account.
When several images are offered, match the digest from the image inspection command.
The picker shows engine tags and the selected image's engine creation time and OCI revision label when available.
These labels help identify images; they do not verify source provenance, and reproducible images can share a creation time.
Review the image digest, model, credential status, and YAML before saving.
"Metadata compatible" means the advertised metadata matches the configuration; it does not establish that a runtime starts or inference works.
Onboarding writes a credential reference; it does not save the key value in YAML.
A missing inference key can be deferred by plan; interactive apply prompts for it.

Plan and review the changes, then apply with a separate state directory:

If another deployment uses the default gateway port or network range, set `spec.gateway.target.docker.port` and `spec.gateway.target.docker.networkCIDR` to unused values before the first successful plan.
A failed first plan binds neither setting; preserve the other deployment.
For example, if port `17683` and range `10.203.0.0/24` are unused, add them beside `engine` in the generated file:

```yaml
spec:
  gateway:
    target:
      docker:
        engine: unix:///var/run/docker.sock
        port: 17683
        networkCIDR: 10.203.0.0/24
```

This is a fragment; retain the rest of the generated configuration.

```sh
nemoclaw plan --state-dir .local/first-wsl/state deployment.yaml
nemoclaw apply --state-dir .local/first-wsl/state deployment.yaml
```

Apply starts containers and installs credentials in OpenShell.
Retain the YAML, state directory, and unchanged bundle if it fails; follow [operation recovery](../build-deploy/usage.md#recovering-an-interrupted-operation) before retrying.

## Verifying a Reply

For a first reply, copy the gateway and workspace selection commands from apply's output, then run the command after `Invoke:`.
The Bash sample works inside WSL and sends the JSON string `"Reply with exactly READY."` on stdin.
It can incur inference charges and saves the adapter's full result in `reply-assistant.json`.
Check that it exits successfully, then run the printed `Hermes reply (requires jq)` command to show the reply and both statuses.
Require both `command_status` and `agent_status` to be `succeeded`, with `READY` in `response`.

To retrieve the current runtime ID and check both statuses in a script, use the following alternative.
Use the gateway endpoint, workspace, agent name, and runtime ID from apply's output.
For this managed loopback gateway, select the endpoint and workspace in the current shell:

```sh
unset OPENSHELL_GATEWAY
export OPENSHELL_GATEWAY_ENDPOINT=REPLACE_WITH_REPORTED_ENDPOINT
export OPENSHELL_WORKSPACE=REPLACE_WITH_REPORTED_WORKSPACE
RUNTIME_ID=$(nemoclaw plan -o json --progress off --non-interactive --state-dir .local/first-wsl/state deployment.yaml | jq -er '.agents.assistant.runtimeId') || exit 1
openshell sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent primary --runtime-id "$RUNTIME_ID" --input - <<'JSON' > reply.json
"Reply with exactly READY."
JSON
INVOKE_STATUS=$?
jq '{command_status: .status, agent_status: .result.status, error: .result.error, response: .result.output.response}' reply.json
test "$INVOKE_STATUS" -eq 0
jq -e '.status == "succeeded" and .result.status == "succeeded"' reply.json >/dev/null
```

`--input -` reads one JSON value from stdin; the quoted prompt is that value.
The request can incur inference charges.
Check the invocation's exit status as well as `result.status`; a successful apply alone does not test inference.
The filter shows the Hermes reply while keeping the full response in `reply.json`.
Other adapters can return a different output shape.
An auxiliary Hermes title-generation warning can accompany a successful reply; check `result.status` and the reply before treating that warning as a failed request.
Harness configuration belongs to the adapter; do not run `hermes setup` against a managed deployment solely because that warning suggests it.
For rejected keys, follow [authentication diagnostics](../agents-inference/agents.md#diagnosing-an-authentication-failure) and the linked rotation procedure before retrying.

Retain the deployment for inspection, or follow [destroy and retention](../build-deploy/usage.md#destroying) with the same bundle and state directory when finished.
Clear the caller's key with `unset NVIDIA_API_KEY`; this does not revoke the upstream key or remove OpenShell's installed credential.
