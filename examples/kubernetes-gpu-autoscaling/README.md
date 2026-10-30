<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Agent Scaling: NemoClaw Kubernetes autoscaling on multi-GPUs

| Catalog field | Value |
| --- | --- |
| Description | One Fabric sandbox per end user, with GPU inference scaled by Kubernetes HPA. |
| Industry | Cloud Services |
| Requirements | Kubernetes 1.25+ · Helm 3 or 4 · NVIDIA GPU Operator and DCGM · Metrics Server · Docker Buildx · OpenShell 0.1.4 · a NemoClaw bundle built from this checkout · experimental |
| NemoClaw | this checkout (`nemoclaw.nvidia.com/v1alpha1`) |
| Harness | OpenClaw, Hermes, or Deep Agents |
| OpenShell | 0.1.4 |

This example runs one Fabric sandbox per end user and scales GPU inference from 1 to N pods, one GPU each. The pairing files in this directory are OpenClaw + Ollama, Hermes + vLLM, and Deep Agents + NIM. `nemoclaw apply` creates the sandboxes. The Helm chart in this directory serves inference. Sandboxes call:

```text
http://nemoclaw-gpu-metrics-proxy.nemoclaw-gpu.svc.cluster.local:8081/v1
```

The chart generates a local inference API key. Each pairing file reads it from `GPU_INFERENCE_API_KEY`. Do not print that key, and do not commit it.

Kubernetes HPA scales the inference pods on a Pods `AverageValue` metric. GPU utilization targets 40%. LLM latency targets 3000 ms. `./scripts/set-hpa-metric.sh` switches the metric without changing the runtime or the sandboxes.

Build the CLI from this checkout. There is no release download yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)). NemoClaw does not place NIM ([#12649](https://github.com/NVIDIA/NemoClaw/issues/12649)). For NIM, install this chart with `INFERENCE_RUNTIME=nim` and apply `deepagents-nim.yaml`. Hermes uses vLLM.

## Deployment architecture

One end user, one sandbox, one agent. `nemoclaw apply` installs a managed OpenShell gateway and starts `fabric-agent-ctl serve` in each sandbox. These files set `authentication.profile: development`. Only NemoClaw can mint those tokens.

A load test sends each prompt with `kubectl exec` into `fabric-agent-ctl invoke`. That skips gateway auth. The operator command is `./scripts/invoke.sh`, which runs `openshell sandbox exec`. `development` gives the OpenShell CLI no token, so `invoke.sh` waits until you switch the file to `oidc` and register the gateway.

Inference is the GPU chart Service `/v1` above. Envoy, when installed, load-balances with LeastRequest. Each GPU pod is 2/2 Ready when healthy: the inference runtime (`ollama`, `vllm`, or `nim`) and `metrics-proxy` (auth, `/v1`, health, `/metrics`).

LLM latency is chat-completions duration on that GPU pod, averaged over completed samples from the last 30 seconds. In-flight chats do not count. After 15 seconds with no completed sample the gauge publishes 0 so HPA can scale down. That 0 is not 0 ms of latency.

## Prerequisites

`kubectl get nodes` must succeed. This DGX is `x86_64`. Build the `linux_amd64` bundle and `linux/amd64` images. The checkout used below is `/home/maggiez/NemoClaw-v1`. Set `NEMOCLAW_V1_ROOT` when the checkout is somewhere else.

k3s on this host uses its own containerd. Do not remove k3s, containerd, or the GPU chart while installing Docker.

## Quick start

Stay in `examples/kubernetes-gpu-autoscaling` for every `./scripts/...` command after the build steps.

### 1. Checkout

```bash
git clone https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw
git checkout v1
cd examples/kubernetes-gpu-autoscaling
```

Until this example is on that branch, fetch it from the fork:

```bash
git fetch https://github.com/maggiezha/NemoClaw.git v1
git checkout -B v1 FETCH_HEAD
cd examples/kubernetes-gpu-autoscaling
```

### 2. Confirm GPUs and DCGM

```bash
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get pods -n "${DCGM_NAMESPACE:-gpu-operator-resources}" -l app=nvidia-dcgm-exporter
```

A Helm GPU Operator uses `DCGM_NAMESPACE=gpu-operator`. The microk8s GPU addon uses `gpu-operator-resources`.

### 3. Build NemoClaw and install OpenShell 0.1.4

`rust-toolchain.toml` selects Rust 1.99.1. `cargo ci tools` installs protobuf 36.2 under `.tools/protoc-36.2`. Docker Buildx must be present before the image build.

```bash
cd /home/maggiez/NemoClaw-v1
. "${HOME}/.cargo/env"
rustc --version
cargo ci tools
.tools/protoc-36.2/bin/protoc --version
docker buildx version
```

`rustc --version` must print `rustc 1.99.1`. `protoc --version` must print `libprotoc 36.2`. `docker buildx version` must print a Buildx version. Install Docker Engine 28 or later when Buildx is missing. A local Docker image is not visible to k3s until you load that digest into the k3s containerd store, or push it to a registry the node pulls.

Install the OpenShell 0.1.4 binary. Do not run the OpenShell `.deb` installer. That package replaces `openshell` and starts a user gateway. The 0.1.4 Linux x86_64 archive contains one file, `openshell`.

```bash
mkdir -p "${HOME}/.local/openshell-0.1.4"
curl -fL -o /tmp/openshell-0.1.4-linux-x86_64.tar.gz \
  https://github.com/NVIDIA/OpenShell/releases/download/v0.1.4/openshell-x86_64-unknown-linux-musl.tar.gz
tar -C "${HOME}/.local/openshell-0.1.4" -xzf /tmp/openshell-0.1.4-linux-x86_64.tar.gz
"${HOME}/.local/openshell-0.1.4/openshell" --version
```

The version command must print `0.1.4`.

```bash
cd /home/maggiez/NemoClaw-v1
cargo run -p nemoclaw-build -- bundle --platform linux_amd64
export PATH="/home/maggiez/NemoClaw-v1/dist/linux_amd64/bin:${HOME}/.local/openshell-0.1.4:${PATH}"
nemoclaw --help
```

Help must list `plan`, `apply`, `export`, and `destroy`. Keep this bundle unchanged while a deployment uses it.

Build the Fabric image for the pairing you will apply. Hermes is the image for `hermes-vllm.yaml`. Deep Agents is the image for `deepagents-nim.yaml`. OpenClaw is the image for `openclaw-ollama.yaml`.

```bash
cd /home/maggiez/NemoClaw-v1
cargo images build --platform linux/amd64 hermes
docker image inspect nc-fabric:hermes --format '{{index .RepoDigests 0}}'
cargo images export-metadata nc-fabric:hermes \
  --output /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling/hermes.metadata.json
```

Replace both `image.ref` values in the YAML with that digest. Load the same digest into k3s, or push it to a registry the node pulls. Do not commit `hermes.metadata.json`. For Deep Agents or OpenClaw, replace `hermes` in those commands and write `deepagents.metadata.json` or `openclaw.metadata.json`.

### 4. Install GPU inference and the Envoy load balancer

Skip this when `kubectl get gatewayclass eg` already succeeds and the chart runtime matches the pairing.

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
DCGM_NAMESPACE=gpu-operator-resources MAX_REPLICAS=8 ENABLE_ENVOY_LB=1 \
  INFERENCE_RUNTIME=vllm \
  ./scripts/install-hpa.sh
kubectl get gatewayclass eg
```

Set `INFERENCE_RUNTIME` to `ollama`, `vllm`, or `nim` before install. A later pairing that needs a different runtime must run `install-hpa.sh` again with that runtime so Helm points this same release at it. `./scripts/set-hpa-metric.sh` changes only the HPA metric.

For NIM, create `secrets.env` from `secrets.env.example` and run `./scripts/apply-local-secrets.sh` before `install-hpa.sh`. Do not commit `secrets.env`.

### 5. Check the pairing files

`./scripts/check.sh` validates the three YAML files and reads the cluster. It does not apply, helm-upgrade, or delete sandboxes.

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
export PATH="/home/maggiez/NemoClaw-v1/dist/linux_amd64/bin:${HOME}/.local/openshell-0.1.4:${PATH}"
export NEMOCLAW_V1_ROOT=/home/maggiez/NemoClaw-v1
export NEMOCLAW_CLUSTER_KUBECONFIG="${HOME}/.kube/config"
export NEMOCLAW_AGENT_IMAGE_METADATA="${PWD}/hermes.metadata.json"
export GPU_INFERENCE_API_KEY="$(kubectl -n nemoclaw-gpu get secret nemoclaw-gpu-metrics-proxy-inference-api -o jsonpath='{.data.api-key}' | base64 -d)"
./scripts/check.sh
```

Replace `metadata.uid` before apply. A placeholder digest is valid YAML and is not a runnable image.

### 6. Apply one pairing

| Step | File | Harness | Apply when |
| --- | --- | --- | --- |
| 6a OpenClaw + Ollama | [`openclaw-ollama.yaml`](openclaw-ollama.yaml) | `nvidia.fabric.openclaw` | The GPU chart serves Ollama. |
| 6b Hermes + vLLM | [`hermes-vllm.yaml`](hermes-vllm.yaml) | `nvidia.fabric.hermes` | The GPU chart serves vLLM. |
| 6c Deep Agents + NIM | [`deepagents-nim.yaml`](deepagents-nim.yaml) | `nvidia.fabric.langchain.deepagents` | The GPU chart serves NIM. |

Each file declares sandboxes `user-0000` and `user-0001`. This command prints a wider file and does not apply it:

```bash
E2E_USERS=5 ./scripts/render-sandboxes.sh hermes-vllm
```

Hermes uses state directory `.local/gpu-autoscaling` and namespace `nemoclaw-v1-gpu-autoscaling`. OpenClaw uses `.local/gpu-autoscaling-openclaw` and `nemoclaw-v1-gpu-autoscaling-openclaw`. Deep Agents uses `.local/gpu-autoscaling-deepagents` and `nemoclaw-v1-gpu-autoscaling-dagent`. Apply refuses to take over a namespace that already exists. OpenClaw and Deep Agents use their own namespaces, so either can stay up beside the Hermes deployment.

```bash
nemoclaw plan --non-interactive --state-dir .local/gpu-autoscaling hermes-vllm.yaml
nemoclaw apply --non-interactive --state-dir .local/gpu-autoscaling hermes-vllm.yaml
```

For ten sandboxes:

```bash
E2E_USERS=10 ./scripts/render-sandboxes.sh hermes-vllm > .local/hermes-vllm-10.yaml
nemoclaw apply --non-interactive --state-dir .local/gpu-autoscaling .local/hermes-vllm-10.yaml
```

Put the real image digest and a new `metadata.uid` in the rendered file before apply. `.local/` is gitignored. Do not commit it.

After apply, a gateway prompt is:

```bash
NEMOCLAW_V1_STATE_DIR=.local/gpu-autoscaling ./scripts/invoke.sh
```

`development` gives that command no operator token. To use it, set `gateway.kubernetes.authentication.profile` to `oidc`, fill `openshell.gateway.oidc`, and set `token.env`. Export a bearer token, apply again with the same state directory, port-forward the gateway, and run `openshell gateway add`. Those `oidc` steps have not been run on a cluster. Until an issuer exists, keep `development` for apply. The load clients below do not need that token.

## Load tests

[`client-hermes.sh`](scripts/client-hermes.sh), [`client-openclaw.sh`](scripts/client-openclaw.sh), and [`client-deepagents.sh`](scripts/client-deepagents.sh) send each prompt as `fabric-agent-ctl invoke` inside the sandbox. They read Fabric runtime ids from the state directory and stop new chats at `TARGET_PODS` GPUs (default 8). Apply a file with at least `E2E_USERS` sandboxes first. Every sandbox pod must be Ready.

```bash
export PATH="/home/maggiez/NemoClaw-v1/dist/linux_amd64/bin:${HOME}/.local/openshell-0.1.4:${HOME}/.local/bin:${PATH}"

# 6b GPU utilization (chart default).
INFLIGHT=2 MAX_TOKENS=1024 E2E_USERS=10 ./scripts/client-hermes.sh

# 6c GPU utilization. One chat in flight stayed at 5 GPUs, so this uses 3.
INFLIGHT=3 E2E_USERS=10 ./scripts/client-deepagents.sh

# LLM latency. Switch the HPA metric, then run the client at one chat in flight.
./scripts/set-hpa-metric.sh latency_avg
E2E_USERS=10 ./scripts/client-hermes.sh
./scripts/set-hpa-metric.sh gpu_utilization
```

OpenClaw latency uses `INFLIGHT=1 MAX_TOKENS=2048`. OpenClaw GPU utilization uses `INFLIGHT=4 MAX_TOKENS=2048`. Hermes latency uses `INFLIGHT=1 MAX_TOKENS=2048`. Hermes GPU utilization uses `INFLIGHT=2 MAX_TOKENS=1024`.

Set `E2E_OUTPUT_DIR` to keep each run's logs apart. Results from a DGX with 7 free GPUs are in [`RESULTS-6b.md`](RESULTS-6b.md) and [`RESULTS-6c.md`](RESULTS-6c.md). The node has 8 GPUs. Another workload held one, so the live HPA maximum was 7. The client default remains `TARGET_PODS=8`.

## Laptop client for 6a

`client-openclaw.sh` runs `kubectl exec` in each OpenClaw sandbox. The cluster API on the DGX listens on `127.0.0.1:6443`. Leave this tunnel open in one terminal. It prints nothing.

```bash
ssh -N -L 16443:127.0.0.1:6443 maggiez@10.184.164.109
```

`~/nemoclaw-v1-kube/config` is a copy of the DGX `~/.kube/config`. The `sed` command points that copy at the tunnel port. macOS `sed` needs the empty backup argument. `terraform.tfstate` is the OpenClaw apply state. Do not commit the kubeconfig or the state file.

In a second terminal:

```bash
cd /Users/maggiez/Desktop/demoK8s/NemoClaw
git fetch https://github.com/maggiezha/NemoClaw.git v1
git checkout -B v1 FETCH_HEAD

mkdir -p examples/kubernetes-gpu-autoscaling/.local
if [[ -d examples/kubernetes-gpu-autoscaling/v1/.local ]]; then
  mv examples/kubernetes-gpu-autoscaling/v1/.local/* examples/kubernetes-gpu-autoscaling/.local/
fi

sed -i '' 's#https://127.0.0.1:6443#https://127.0.0.1:16443#' ~/nemoclaw-v1-kube/config
export KUBECONFIG="${HOME}/nemoclaw-v1-kube/config"
kubectl get pods -n nemoclaw-v1-gpu-autoscaling-openclaw

cd examples/kubernetes-gpu-autoscaling
TARGET_PODS=8 E2E_USERS=10 ./scripts/client-openclaw.sh
```

`kubectl get pods` must list `user-0000` through `user-0009` as Running before the client starts. Leave `INFLIGHT` unset when the live HPA metric is `nemoclaw_llm_latency_avg_milliseconds`. The client then uses one chat in flight per user.

## HPA-only load

`./scripts/hpa-load-test-dgx-8xh100.sh` checks that HPA can change GPU pod count from synthetic inference load in `files/load-generator.ts`. It does not create sandboxes. GPU utilization is the default. For latency:

```bash
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test-dgx-8xh100.sh
```

`./scripts/get-hpa.sh` and `./scripts/hpa-watch.sh` print the live metric. `./scripts/hpa-load-test-brev-4xl40s.sh` is the same check for 4× L40S.

## Uninstall

Destroy the sandboxes with the same state directory you applied:

```bash
nemoclaw destroy --non-interactive --state-dir .local/gpu-autoscaling
```

Repeat for `.local/gpu-autoscaling-openclaw` and `.local/gpu-autoscaling-deepagents` when those deployments exist.

`./scripts/hpa-reset.sh` restores an idle HPA without deleting the release. Remove the GPU release when you are finished with inference:

```bash
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
```
