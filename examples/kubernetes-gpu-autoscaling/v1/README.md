<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# GPU autoscaling example for NemoClaw v1

This folder is an experimental community example.
It is not a NemoClaw release, and v1 has not tested DGX or Linux AMD64 deployment end to end.
v1 has no release download ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).

The v0 recipe is in the parent folder, [`kubernetes-gpu-autoscaling`](../README.md).
Its Helm chart, Horizontal Pod Autoscaler, and Envoy load balancer stay installed.
v1 does not install that chart.
Each pairing file calls the GPU chart Service `nemoclaw-gpu-metrics-proxy.nemoclaw-gpu.svc.cluster.local:8081`.

Leave these v0 resources in place:

- Helm release `nemoclaw-gpu` in namespace `nemoclaw-gpu`
- OpenShell gateway `nemoclaw-k8s` in namespace `nemoclaw-sandboxes` (CLI and gateway 0.0.85)
- The OpenShell port-forward on `127.0.0.1:18080`

`nemoclaw apply` creates a second gateway in namespace `nemoclaw-v1-gpu-autoscaling`.
That namespace must not already exist.
The v1 gateway uses OpenShell 0.1.4, commit `5a7728c304b5528e954e9ae900cf21f84e1a12b1`.

## What this host must have before apply

This DGX is `x86_64`. Build the `linux_amd64` bundle and `linux/amd64` images.
The v1 source checkout on this machine is `/home/maggiez/NemoClaw-v1`.
Set `NEMOCLAW_V1_ROOT` when that checkout is somewhere else.

| Tool | Required result | This host before these steps |
| --- | --- | --- |
| Rust | `rustc 1.99.1`, from `rust-toolchain.toml` and `versions.json` | Missing |
| C compiler | Present for the TLS build | `cc` is present |
| Protocol Buffers | `libprotoc 36.2` from `cargo ci tools` | Missing |
| Docker | Docker Engine with Buildx. `docker buildx version` succeeds | Missing |
| OpenShell CLI | `0.1.4` beside the existing `0.0.85` binary | `~/.local/bin/openshell` is 0.0.85 |
| `nemoclaw` | `plan`, `apply`, `export`, and `destroy` from a source bundle | Missing |
| Fabric image | Immutable `sha256` digest on the k3s node | Placeholder digest only |
| GPU chart | Metrics-proxy Deployment and inference Secret | Installed by the v0 recipe |

k3s on this host uses its own containerd.
Do not remove k3s, containerd, or the GPU chart while installing Docker.

### Rust 1.99.1

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
. "${HOME}/.cargo/env"
cd /home/maggiez/NemoClaw-v1
rustup show
rustc --version
```

`rustc --version` must print `rustc 1.99.1`.

### Protocol Buffers 36.2

`versions.json` pins protobuf `36.2`.
`cargo ci tools` installs it under the v1 checkout at `.tools/protoc-36.2`.

```bash
cd /home/maggiez/NemoClaw-v1
cargo ci tools
.tools/protoc-36.2/bin/protoc --version
```

The version line must be `libprotoc 36.2`.

### Docker with Buildx

Install Docker Engine and the Buildx plugin from [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
OpenShell's runtime table requires Docker Engine 28 or later when Docker is the compute driver.

```bash
docker buildx version
```

The command must print a Buildx version.
A local Docker image is not visible to k3s until you load that same digest into the k3s containerd store, or push it to a registry the node pulls.

### OpenShell 0.1.4 beside 0.0.85

Do not run the OpenShell `.deb` installer.
That package replaces the `openshell` command and starts a user gateway.
The v0 demo still needs `~/.local/bin/openshell` at 0.0.85 for gateway `nemoclaw-k8s`.

The v0.1.4 Linux x86_64 archive contains one file, `openshell`.

```bash
mkdir -p "${HOME}/.local/openshell-0.1.4"
curl -fL -o /tmp/openshell-0.1.4-linux-x86_64.tar.gz \
  https://github.com/NVIDIA/OpenShell/releases/download/v0.1.4/openshell-x86_64-unknown-linux-musl.tar.gz
tar -C "${HOME}/.local/openshell-0.1.4" -xzf /tmp/openshell-0.1.4-linux-x86_64.tar.gz
"${HOME}/.local/openshell-0.1.4/openshell" --version
~/.local/bin/openshell --version
```

The first version command must print `0.1.4`.
The second must still print `0.0.85`.
For v1 commands, put the 0.1.4 directory first on `PATH`:

```bash
export PATH="${HOME}/.local/openshell-0.1.4:${PATH}"
```

## Build the v1 bundle and a Fabric image

Run these commands from the v1 checkout.
The bundle build downloads OpenTofu, the Helm provider, and the Docker provider, then compiles the CLI.

```bash
cd /home/maggiez/NemoClaw-v1
cargo run -p nemoclaw-build -- bundle --platform linux_amd64
export PATH="/home/maggiez/NemoClaw-v1/dist/linux_amd64/bin:${HOME}/.local/openshell-0.1.4:${PATH}"
nemoclaw --help
```

Help must list `plan`, `apply`, `export`, and `destroy`.
Keep this bundle unchanged while a deployment uses it.

Build one Fabric image for the pairing you will apply.
Hermes is the image for `hermes-nim.yaml` and `hermes-vllm.yaml`.
Deep Agents is the image for `deepagents-nim.yaml`.
OpenClaw is the image for `openclaw-ollama.yaml`.

```bash
cd /home/maggiez/NemoClaw-v1
cargo images build --platform linux/amd64 hermes
docker image inspect nc-fabric:hermes --format '{{index .RepoDigests 0}}'
cargo images export-metadata nc-fabric:hermes \
  --output /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling/v1/hermes.metadata.json
```

Replace both `image.ref` values in the YAML with that digest.
Load the same digest into k3s, or push it to a registry the node pulls.
Do not commit `hermes.metadata.json`.

For Deep Agents, replace `hermes` with `deepagents` in the three commands above and write `deepagents.metadata.json`.

## Step 6 files

| v0 README step | File here | Harness | Apply when |
| --- | --- | --- | --- |
| 6a OpenClaw + Ollama | [`openclaw-ollama.yaml`](openclaw-ollama.yaml) | `nvidia.fabric.openclaw` | The GPU chart serves Ollama. |
| 6b Hermes + vLLM | [`hermes-vllm.yaml`](hermes-vllm.yaml) | `nvidia.fabric.hermes` | The GPU chart serves vLLM. |
| 6b Hermes while the chart serves NIM | [`hermes-nim.yaml`](hermes-nim.yaml) | `nvidia.fabric.hermes` | The GPU chart already serves NIM. Do not helm-upgrade it to vLLM for this check. |
| 6c Deep Agents + NIM | [`deepagents-nim.yaml`](deepagents-nim.yaml) | `nvidia.fabric.langchain.deepagents` | The GPU chart serves NIM. v1 has no managed NIM ([#12649](https://github.com/NVIDIA/NemoClaw/issues/12649)). |

Each file declares sandboxes `user-0000` and `user-0001`.
This command prints a wider file and does not apply it:

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling/v1
E2E_USERS=5 ./scripts/v1-render-sandboxes.sh hermes-nim
```

## Prompt hop and inference hop

Hermes, OpenClaw, and Deep Agents share the managed OpenShell gateway and one Fabric invoke.
Only `harness.kind` and the image change.

| Agent | `harness.kind` | Canonical example |
| --- | --- | --- |
| OpenClaw | `nvidia.fabric.openclaw` | [`examples/kubernetes/managed-development.yaml`](../../../examples/kubernetes/managed-development.yaml), [Agents](../../../docs/agents.md) |
| Hermes | `nvidia.fabric.hermes` | [`examples/managed-hermes.yaml`](../../../examples/managed-hermes.yaml), [`examples/gtc-dc/hermes-dgx-spark.yaml`](../../../examples/gtc-dc/hermes-dgx-spark.yaml) |
| Deep Agents | `nvidia.fabric.langchain.deepagents` | [`examples/spark/deepagents-team.yaml`](../../../examples/spark/deepagents-team.yaml) |

**Apply.** `nemoclaw plan` / `apply` / `destroy` uses the managed OpenShell gateway to create each sandbox and start `fabric-agent-ctl serve`.
These files set `authentication.profile: development`.
Only NemoClaw can mint those tokens ([Deploy to Kubernetes](../../../docs/kubernetes.md)).

**Operator prompt.** The command is the same for every harness ([Get started](../../../docs/get-started.md), [Agents](../../../docs/agents.md)):

```bash
openshell sandbox exec -n NAME -- fabric-agent-ctl invoke --agent NAME --runtime-id ID --input -
```

`./scripts/v1-invoke.sh` runs that command.
`development` gives the OpenShell CLI no token, so this waits on `oidc` and an identity provider you supply ([Reach the Gateway from the OpenShell CLI](../../../docs/kubernetes.md#reach-the-gateway-from-the-openshell-cli)).
Do not add an unauthenticated v1 gateway.

The recorded 6b and 6c HPA clients invoked Fabric inside the sandbox because `development` blocked that CLI. Fabric did not choose that hop.

**Inference.** Each file already sets `inferenceProviders` to the GPU chart metrics-proxy Service `/v1` (or the Envoy dataplane Service URL). That is the in-cluster pattern in [Use a Model Server in the Cluster](../../../docs/kubernetes.md#use-a-model-server-in-the-cluster):

```text
http://nemoclaw-gpu-metrics-proxy.nemoclaw-gpu.svc.cluster.local:8081/v1
```

with `credential: {env: GPU_INFERENCE_API_KEY}`.
OpenShell stores the key and attaches the provider.
Leave this URL on cluster DNS `/v1`.

## Check, plan, and one prompt

`./scripts/v1-check.sh` validates the four YAML files and reads the cluster.
It does not apply, helm-upgrade, or delete sandboxes.
It reports the first `openshell` and `nemoclaw` on `PATH`.

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling/v1
export PATH="/home/maggiez/NemoClaw-v1/dist/linux_amd64/bin:${HOME}/.local/openshell-0.1.4:${PATH}"
export NEMOCLAW_V1_ROOT=/home/maggiez/NemoClaw-v1
export NEMOCLAW_CLUSTER_KUBECONFIG="${HOME}/.kube/config"
export NEMOCLAW_AGENT_IMAGE_METADATA="${PWD}/hermes.metadata.json"
export GPU_INFERENCE_API_KEY="$(kubectl -n nemoclaw-gpu get secret nemoclaw-gpu-metrics-proxy-inference-api -o jsonpath='{.data.api-key}' | base64 -d)"
./scripts/v1-check.sh
```

`GPU_INFERENCE_API_KEY` is the chart inference key.
Do not print it, and do not commit it.
Replace `metadata.uid` before apply.
A placeholder digest is valid YAML and is not a runnable image.

```bash
nemoclaw plan --non-interactive --state-dir .local/gpu-autoscaling hermes-nim.yaml
```

After a successful apply, a gateway prompt is `./scripts/v1-invoke.sh` for 6b and 6c.
These files use `development`, so that command waits on `oidc`.

### Switch apply and invoke to oidc

Supply an issuer URL, audience, and OpenShell CLI client ID, then switch YAML to `oidc`.
Do not add an unauthenticated v1 gateway.

1. Set `gateway.kubernetes.authentication.profile` to `oidc`, fill `openshell.gateway.oidc`, and set `token.env` as [Authenticate Through an Existing OIDC Issuer](../../../docs/kubernetes.md#authenticate-through-an-existing-oidc-issuer) shows.
2. Export a bearer token in that variable, then run `nemoclaw apply` with the same state directory, or destroy and apply if you are replacing a development gateway.
3. Port-forward the gateway, copy client TLS, and run `openshell gateway add` as [Reach the Gateway from the OpenShell CLI](../../../docs/kubernetes.md#reach-the-gateway-from-the-openshell-cli) shows. Those steps have not been run on a cluster.
4. Run `NEMOCLAW_V1_STATE_DIR=.local/gpu-autoscaling ./scripts/v1-invoke.sh` (6b) or the Deep Agents state directory (6c).

Until that issuer exists, keep `development` for apply.

## Load tests for 6b and 6c

[`v1-client-hermes.sh`](scripts/v1-client-hermes.sh) and [`v1-client-deepagents.sh`](scripts/v1-client-deepagents.sh) send each prompt as `fabric-agent-ctl invoke`, read each Fabric runtime id from the state directory, and stop new chats at `TARGET_PODS` GPUs (default 8).
The recorded runs used that in-sandbox invoke because `development` blocked the OpenShell CLI. A gateway prompt is `v1-invoke.sh` after `oidc`.
Apply a YAML with enough sandboxes first, for example ten:

```bash
export PATH="/home/maggiez/NemoClaw-v1/dist/linux_amd64/bin:${HOME}/.local/openshell-0.1.4:${HOME}/.local/bin:${PATH}"
E2E_USERS=10 ./scripts/v1-render-sandboxes.sh hermes-vllm > .local/hermes-vllm-10.yaml
nemoclaw apply --non-interactive --state-dir .local/gpu-autoscaling .local/hermes-vllm-10.yaml
```

Put the real image digest and a new `metadata.uid` in the rendered file before apply.
Deep Agents uses its own state directory and namespace, so both deployments can stay up.

```bash
# GPU utilization (the chart's default HPA metric). Run from this folder.
INFLIGHT=2 MAX_TOKENS=1024 E2E_USERS=10 ./scripts/v1-client-hermes.sh        # 6b
INFLIGHT=3 E2E_USERS=10 ./scripts/v1-client-deepagents.sh                    # 6c

# LLM latency. Switch the HPA metric first, then run the client without INFLIGHT.
./scripts/v1-set-hpa-metric.sh latency_avg
E2E_USERS=10 ./scripts/v1-client-hermes.sh
./scripts/v1-set-hpa-metric.sh gpu_utilization                               # switch back
```

Set `E2E_OUTPUT_DIR` to keep each run's logs apart.
Results from a DGX with 7 free GPUs are in [`RESULTS-6b.md`](RESULTS-6b.md) and [`RESULTS-6c.md`](RESULTS-6c.md).
Deep Agents at one chat in flight per user stayed at 5 GPUs, so 6c uses `INFLIGHT=3`.

