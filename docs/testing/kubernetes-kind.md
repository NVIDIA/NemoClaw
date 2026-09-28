<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Kubernetes Locally with kind

This optional fixture creates one disposable kind cluster for local Kubernetes tests.
For an existing cluster, use the [Kubernetes backend guide](../kubernetes.md); the SDK does not invoke this fixture.
The [branch scope decision](../design/scope.md#kubernetes-development-branch) permits this isolated setup.
Deleting the cluster deletes its local persistent volumes and every sandbox in it.

## Run the Complete Test

From the `codex/kubernetes-backend` checkout, install Python 3.12 or newer, Rustup or the pinned Rust toolchain, a C compiler, Docker with Buildx, kind, kubectl, Helm, and OpenSSL.
Docker must be running with Linux containers matching the host architecture and a containerd image store that retains repository digests.
The script detects macOS or Linux and ARM64 or AMD64, prepares the pinned Rust and Protocol Buffers tools locally, and builds the native bundle and matching Linux agent image.
It does not change system packages, Docker permissions, or the default kubeconfig.

The only required configuration input is `NVIDIA_INFERENCE_API_KEY`.
This opt-in test first checks the key and model directly against the hosted NVIDIA endpoint, then creates a fresh disposable cluster and sends real requests from the agents configured in the [three-agent sample](../../examples/kubernetes/managed-development.yaml).
If the direct request fails, the runner stops before building or creating cluster resources.
The direct check uses verified HTTPS, refuses redirects, and sends one bounded request; it does not establish that inference inside a sandbox will succeed.
On success, it destroys the deployment and deletes its owned cluster, including that cluster's volumes and Secrets.
On failure or interruption, it retains the cluster and private state for diagnosis.
Previous clusters are preserved.

From the repository root, read the key without placing its value in shell history and run:

```sh
export NVIDIA_INFERENCE_API_KEY="$(python3 -c 'import getpass; print(getpass.getpass("NVIDIA inference API key: "))')"
python3 tools/kubernetes/e2e.py
```

If the key is already exported, run only the second command.
The runner creates a private directory under `$HOME/.local/state/nemoclaw/k8s-e2e-*` and prints its path.
It generates `deployment.yaml` from the managed example, selects an available loopback port, and uses the cluster's explicit private kubeconfig.
No bundle, image, context, state-directory, or test configuration exports are needed.
The runner uses the inference key for the direct check and passes it to the compiled lifecycle test; build tools and cluster setup do not receive it.
Generated manifests and retry commands contain environment references, never the key value.
The log redacts the supplied key, and SDK diagnostics do not include upstream response bodies or credentials.
Generated development authentication and retained SDK state remain private and outside Git.

A successful run prints `PASS` after checking all three native agent responses, an unchanged plan, CLI export, unchanged SDK reapply with identical resource IDs, and CLI destroy.
After all tests or inference retries finish, run `unset NVIDIA_INFERENCE_API_KEY` to remove the key from this shell.
Private state and evidence remain after cluster cleanup; local build caches and the uniquely tagged agent image also remain.
Use `python3 tools/kubernetes/e2e.py --keep-cluster` to keep the cluster after a successful test; the test still destroys the agents and gateway, retaining the SDK's default storage and authentication resources.

If the test fails, use the exact inspection and cleanup commands printed by the runner.
The inspection command includes `--kubeconfig`; your default `kubectl` context remains unchanged.
When a manifest has been generated, the runner also prints a single `sh .../retry-inference.sh` command that uses the retained test binary, manifest, and SDK state.
Use it only after apply has completed and the deployment is retained.
This retry uses the provider credential already installed in OpenShell; re-exporting a different key does not update that credential.
It invokes inference without rerunning apply or destroy and does not resume the remaining lifecycle assertions.
Keep the matching bundle and checkout available for that retry.
A new `e2e.py` invocation always starts a fresh test and leaves earlier failures intact.
Cleanup refuses deletion if a partially created cluster cannot prove its saved ownership.

The probe reports fixed failure categories such as missing credentials, TLS or DNS failure, timeout, malformed response, or selected HTTP statuses, together with the affected sandbox name.
These messages do not reveal upstream response content.
Older agent images retain the previous generic failure; this runner builds the current image.

For an inference `HTTP 401`, check the key exported in this shell without building or creating a cluster:

```sh
python3 tools/kubernetes/e2e.py --check-inference
```

A direct `HTTP 401` means the hosted endpoint rejected that request's authentication; check for an incorrect, expired, or revoked key.
Enter the replacement key privately using the initial `getpass` export command in this section and repeat the check.
After correcting the key, run the full test again to install it in a fresh deployment, or follow the [existing-deployment credential update procedure](../kubernetes.md#supply-credentials-as-on-docker).
The inference-only retry does not perform that update.
If the direct check passes but a fresh deployment still returns `HTTP 401`, retain that deployment for investigation of the sandbox credential path; do not assume the key is invalid.
The failed cluster remains until its printed ownership-checked cleanup command is run.

The automated runner [passed on Linux AMD64](../validation/kubernetes-script-linux-amd64.md); Apple silicon still needs a live run on that host.

## Test the Managed YAML Path

Use this manual procedure when you want to run each lifecycle command separately.
The SDK can provision the gateway and agents through one managed manifest.
For that path, this helper prepares only a disposable kind cluster and enforcing CNI; `nemoclaw apply` owns OpenShell and agent deployment.
Use a fresh private cluster state directory, a verified native bundle, and the tools listed below.
On Apple silicon, build the native bundle with `--platform darwin_arm64` under the pinned Rust toolchain and build the agent image with `AGENT_PLATFORM=linux/arm64`.
The [managed lifecycle test](../validation/kubernetes-managed-kind-linux-amd64.md) passed on Linux AMD64.
The Apple silicon instructions have not been qualified by that run.

For Apple silicon, build the Kubernetes agent target from the repository root before loading it:

```sh
AGENT_PLATFORM=linux/arm64 IMAGE_PREFIX=nc-kubernetes-dev \
  docker buildx bake openclaw-kubernetes --load
docker image inspect nc-kubernetes-dev:openclaw-kubernetes \
  --format '{{index .RepoDigests 0}}'
```

On Linux AMD64, use `AGENT_PLATFORM=linux/amd64` instead.
Keep the printed repository digest for the manifest; the image store must retain repository digests as described in the [agent image procedure](../build.md#build-agent-images).
Create the cluster and load that image from the repository root:

```sh
export NC_KIND_STATE="$HOME/.local/state/nemoclaw/managed-kind-test"
python3 tools/kubernetes/stack.py cluster --state-dir "$NC_KIND_STATE"
python3 tools/kubernetes/stack.py load-image \
  --state-dir "$NC_KIND_STATE" --image nc-kubernetes-dev:openclaw-kubernetes
export NEMOCLAW_CLUSTER_KUBECONFIG="$NC_KIND_STATE/kubeconfig"
python3 -B - "$NC_KIND_STATE/ownership.json" <<'PYCODE'
import json, sys
receipt = json.load(open(sys.argv[1]))
print("Use this context in the manifest: kind-" + receipt["cluster"])
PYCODE
```

`load-image` verifies the imported OCI content and registers the immutable digest references in the owned kind nodes.
It does not publish the image.
If this private state directory already owns a completed test, choose a new directory or retire that exact old cluster first; do not delete its ownership receipt to bypass checks.

Copy [managed-development.yaml](../../examples/kubernetes/managed-development.yaml) outside the checkout.
Set its context to the printed value, replace its deployment UID, and replace all three image references with your built image’s repository digest.
Keep the generated development authentication profile and managed prerequisite selection.
Supply `NVIDIA_INFERENCE_API_KEY` privately through the same environment-reference mechanism as Docker.
From the directory containing the adapted `deployment.yaml`, run:

```sh
nemoclaw plan --state-dir ./state deployment.yaml
nemoclaw apply --state-dir ./state deployment.yaml
nemoclaw export --state-dir ./state --output exported.yaml
```

No `stack.py deploy`, `stack.py connect`, or `environment.env` step is needed for this workflow.
The SDK automatically provisions the managed gateway and opens its authenticated connection for each operation.
Keep both the cluster ownership directory and the SDK state directory.
After testing, use `nemoclaw destroy --state-dir ./state` to remove agents and uninstall the owned gateway release while retaining data.
Use the separate confirmed `stack.py cleanup --state-dir "$NC_KIND_STATE" --confirm-cluster NAME` command only when ready to delete the entire disposable cluster and all its persistent volumes.
Its cluster name must match the saved ownership receipt.
Local SDK credentials remain in `state/kubernetes` and need separate private-file cleanup after retirement.

## Create an Isolated kind Stack

This older fixture installs the platform separately for testing an external-gateway manifest.
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
The generated CPU configuration contains one OpenClaw sandbox.
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
