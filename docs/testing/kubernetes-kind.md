<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Kubernetes Locally with kind

This optional fixture creates one disposable kind cluster for local Kubernetes tests.
For an existing cluster, use the [Kubernetes backend guide](../kubernetes.md); the SDK does not invoke this fixture.
The [branch scope decision](../design/scope.md#kubernetes-development-branch) permits this isolated setup.
Deleting the cluster deletes its local persistent volumes and every sandbox in it.

## Create an Isolated kind Stack

Run the following commands from the repository root on a Linux AMD64 development host.
Install Python 3.12 or newer, OpenSSL, Docker with Buildx, kind, kubectl, and Helm before starting.
The helper uses existing noninteractive sudo only when the current user cannot access Docker; it does not change groups, socket permissions, host packages, drivers, or kernel settings.
Build the [native bundle](../build.md#build-a-native-bundle) before running NemoClaw.

The helper downloads checksum-verified upstream sources and digest-selected images from [sources.json](../../tools/kubernetes/sources.json) and [versions.json](../../versions.json).
Additional fixture image pins are defined in the [local issuer](../../tools/kubernetes/auth.py) and [CPU model](../../tools/kubernetes/model.py) helpers.
It installs the upstream OpenShell chart without editing or maintaining a chart fork.
It creates one randomly named `nemoclaw-v1-` cluster with a private kubeconfig outside the checkout and never changes the user's current context.
Subsequent operations verify the saved node IDs, API endpoint, CA, context, and Kubernetes namespace identity before accessing the cluster.
An identity mismatch stops the operation.

```sh
python3 tools/kubernetes/stack.py preflight
python3 tools/kubernetes/stack.py render
python3 tools/kubernetes/stack.py deploy
python3 tools/kubernetes/stack.py verify
```

The default private state directory is `$HOME/.local/state/nemoclaw/kubernetes-dev` with mode `0700`.
Use the same explicit `--state-dir` on every command if changing it.
Private certificate files, token material, kubeconfig, and generated deployment inputs remain there with mode `0600`.
Do not copy them into the repository or publish them with test results.
The authentication fixture is for this disposable cluster only; its signing material must never be trusted by another gateway.
The JWT signing key stays in private operator state; the issuer Pod receives public verification metadata and a separate TLS key.
The upstream chart supplies the fixture CA through the gateway process's `SSL_CERT_FILE` setting, which affects outbound TLS trust beyond OIDC requests.
This setting does not change host trust or the SDK's gateway TLS configuration.

The installer checks both ingress and egress enforcement using a healthy connection, a deny policy, and restored connectivity.
Keep TLS and user authentication enabled.
In a second terminal, start the loopback gateway connection:

```sh
python3 tools/kubernetes/stack.py connect
```

Keep that process running during SDK operations.
When adapting a [general Kubernetes example](../../examples/kubernetes/), replace its gateway endpoint with `https://127.0.0.1:17671` and use this fixture's `NEMOCLAW_K8S_TOKEN`, `NEMOCLAW_K8S_CA`, `NEMOCLAW_K8S_CERT`, and `NEMOCLAW_K8S_KEY` references.
These variable names belong to the fixture; they do not select a different credential mechanism.
In the client terminal, load the local connection references:

```sh
. "$HOME/.local/state/nemoclaw/kubernetes-dev/environment.env"
```

The environment supplies certificate-file paths and a local development bearer token that expires after one hour.
This token grants administrative access to the isolated gateway with config, provider, sandbox, and workspace read/write scopes.
The shell and its child processes can read that credential.
Remove those variables and delete the dedicated cluster's private credential files when retiring the stack.

Before the token expires, renew it and reload the environment:

```sh
python3 tools/kubernetes/auth.py renew
. "$HOME/.local/state/nemoclaw/kubernetes-dev/environment.env"
```

The issuer TLS certificates expire after seven days.
Renewal refuses certificates with less than one hour remaining and does not rotate keys or trust automatically.
Retire the stack and create a fresh one with a new private state directory when its certificates expire.

## Run a Local Agent and CPU Model

The Docker image store must retain repository digests for local builds, as described in [agent image prerequisites](../build.md#build-agent-images).
If Docker requires sudo, run the build command with `sudo -n env AGENT_PLATFORM=linux/amd64 IMAGE_PREFIX=nc-kubernetes-dev docker buildx bake openclaw-kubernetes --load` and prefix the inspect command with `sudo -n`.
Build the AMD64 OpenClaw Kubernetes target and load it into the owned kind cluster.
This target uses UID and GID `10001` for the sandbox runtime and retains mode `0700` on its sandbox directory.
The existing Docker and Podman image targets retain their original identity.

```sh
AGENT_PLATFORM=linux/amd64 IMAGE_PREFIX=nc-kubernetes-dev \
  docker buildx bake openclaw-kubernetes --load
python3 tools/kubernetes/stack.py load-image --image nc-kubernetes-dev:openclaw-kubernetes
docker image inspect nc-kubernetes-dev:openclaw-kubernetes --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in the configuration command below.
Local image loading does not publish an image.
The optional CPU fixture downloads the official [Qwen3 4B Instruct 2507 Q4_K_M model](https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M) into its PVC and grants serving ingress only after its manifest matches the full SHA-256 pin in [model.py](../../tools/kubernetes/model.py).
It requests 2 CPUs and `8Gi` memory, with limits of 8 CPUs and `16Gi`, a `6Gi` model PVC, and a 32,768-token context matching the OpenClaw adapter.
The model runner uses 8 inference threads to match its CPU limit; automatic thread selection can oversubscribe the Pod's quota on large hosts.
The context must accommodate OpenClaw's system and tool instructions as well as the user's request and model response.
Allow that capacity in addition to the gateway, cluster services, and agent workload.
The model snapshot contains about 2.5 GB of blobs; the larger PVC leaves room for downloads and metadata.
Its outbound access is removed after model acquisition, including on failure.
It exercises inference routing on CPU and does not qualify the managed GPU installers.

```sh
python3 tools/kubernetes/model.py deploy
python3 tools/kubernetes/model.py configuration \
  --agent-image repository@sha256:YOUR_IMAGE_DIGEST
```

The second command creates `deployment.json` in the private stack directory.
JSON is accepted by the YAML parser.
The command refuses to overwrite existing desired state so its deployment UID cannot change accidentally.
Keep the file and its state directory together for later operations.
Choose either the manual commands below or the live lifecycle test in the next section for this deployment UID.

```sh
dist/linux_amd64/bin/nemoclaw \
  --state-dir "$HOME/.local/state/nemoclaw/kubernetes-dev/agent-state" \
  plan --non-interactive "$HOME/.local/state/nemoclaw/kubernetes-dev/deployment.json"
dist/linux_amd64/bin/nemoclaw \
  --state-dir "$HOME/.local/state/nemoclaw/kubernetes-dev/agent-state" \
  apply --non-interactive "$HOME/.local/state/nemoclaw/kubernetes-dev/deployment.json"
```

On failure, retain the private stack and deployment state and correct the reported prerequisite before retrying.
Do not delete the SDK state to bypass an identity conflict.
After a lost creation response, follow [interrupted-operation recovery](../usage.md#recover-an-interrupted-operation).

## Validate and Retire the Stack

Run deterministic tooling tests without contacting a cluster:

```sh
python3 -m unittest discover -s tools/kubernetes -p 'test_*.py'
```

Run the [Kubernetes lifecycle test](live.md#kubernetes) with this fixture's private configuration and a new state directory.
The generated CPU configuration contains one OpenClaw sandbox, as required by that test.
Supply its three absolute paths as shown in the test guide.
The test destroys the agent workload on success and retains the platform and SDK state.

To retain the platform but remove a manually applied agent, use `nemoclaw destroy` with that agent's original state directory.
To delete the entire disposable cluster and its data, supply the cluster name printed by `deploy`:

```sh
python3 tools/kubernetes/stack.py cleanup --confirm-cluster nemoclaw-v1-XXXXXXXX
```

Cleanup verifies ownership before deleting anything and removes local connection credentials after deleting the cluster.
It leaves source caches and SDK state for inspection; those files cannot recover data deleted with the cluster.
To create another disposable stack after cleanup, select a new private `--state-dir`; the completed ownership receipt is retained.
