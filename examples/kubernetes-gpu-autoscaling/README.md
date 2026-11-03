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

<img width="1672" height="941" alt="architecture" src="https://github.com/user-attachments/assets/4e61491d-7a8b-4ce7-9910-9715965e4e7c" />

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

`install-hpa.sh` starts the GPU chart in `nemoclaw-gpu`. It does not create sandboxes or start agents. Run it before `nemoclaw apply`. The chart serves one runtime at a time.

| Pairing | `INFERENCE_RUNTIME` |
| --- | --- |
| Hermes + vLLM | `vllm` |
| OpenClaw + Ollama | `ollama` |
| Deep Agents + NIM | `nim` |

Skip the install when `kubectl get gatewayclass eg` already succeeds and the chart already serves that runtime.

This DGX uses the Helm GPU Operator, so `DCGM_NAMESPACE=gpu-operator`. The install uses `MAX_REPLICAS=8`.

Hermes:

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
DCGM_NAMESPACE=gpu-operator MAX_REPLICAS=8 ENABLE_ENVOY_LB=1 \
  INFERENCE_RUNTIME=vllm \
  ./scripts/install-hpa.sh
kubectl get gatewayclass eg
```

OpenClaw uses the same Helm release with Ollama:

```bash
DCGM_NAMESPACE=gpu-operator MAX_REPLICAS=8 ENABLE_ENVOY_LB=1 \
  INFERENCE_RUNTIME=ollama \
  ./scripts/install-hpa.sh
```

A later pairing runs `install-hpa.sh` again with its runtime. Sandboxes that are already Running stay up. `./scripts/set-hpa-metric.sh` changes only the HPA metric. Run it after the sandbox pods are Ready.

For NIM, create `secrets.env` from `secrets.env.example` and run `./scripts/apply-local-secrets.sh` before `install-hpa.sh` with `INFERENCE_RUNTIME=nim`. Do not commit `secrets.env`.

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

`nemoclaw apply` starts the agents. It creates the OpenShell gateway and one Fabric sandbox per user. Each sandbox runs `fabric-agent-ctl serve` and that pairing's harness. The plan prints `data.fabric_harness` and `data.fabric_harnesses`.

Run step 4 for that pairing first. Apply leaves the GPU chart unchanged.

A sandbox is ready when its `user-NNNN` pod is `1/1 Running`. When those pods are already Running, skip apply.

```bash
kubectl get pods -n nemoclaw-v1-gpu-autoscaling
kubectl get pods -n nemoclaw-v1-gpu-autoscaling-openclaw
```

| Step | File | Harness | Chart runtime | State directory | Namespace |
| --- | --- | --- | --- | --- | --- |
| 6a OpenClaw + Ollama | [`openclaw-ollama.yaml`](openclaw-ollama.yaml) | `nvidia.fabric.openclaw` | `ollama` | `.local/gpu-autoscaling-openclaw` | `nemoclaw-v1-gpu-autoscaling-openclaw` |
| 6b Hermes + vLLM | [`hermes-vllm.yaml`](hermes-vllm.yaml) | `nvidia.fabric.hermes` | `vllm` | `.local/gpu-autoscaling` | `nemoclaw-v1-gpu-autoscaling` |
| 6c Deep Agents + NIM | [`deepagents-nim.yaml`](deepagents-nim.yaml) | `nvidia.fabric.langchain.deepagents` | `nim` | `.local/gpu-autoscaling-deepagents` | `nemoclaw-v1-gpu-autoscaling-dagent` |
| 6d OpenClaw + Hermes | rendered `.local/openclaw-hermes.yaml` | OpenClaw and Hermes | `ollama` and `vllm`, one release each | `.local/gpu-autoscaling-mixed` | `nemoclaw-v1-gpu-autoscaling-mixed` |

Each file declares sandboxes `user-0000` and `user-0001`. `render-sandboxes.sh` prints a wider file. It does not apply. Put the real image digest and a new `metadata.uid` in that file before apply. `.local/` is gitignored. Do not commit it.

Hermes. The chart must serve vLLM.

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
export PATH="/home/maggiez/NemoClaw-v1/dist/linux_amd64/bin:${HOME}/.local/openshell-0.1.4:${PATH}"
E2E_USERS=10 ./scripts/render-sandboxes.sh hermes-vllm > .local/hermes-vllm-10.yaml
nemoclaw apply --non-interactive --state-dir .local/gpu-autoscaling .local/hermes-vllm-10.yaml
kubectl get pods -n nemoclaw-v1-gpu-autoscaling
```

OpenClaw. The chart must serve Ollama.

```bash
E2E_USERS=10 ./scripts/render-sandboxes.sh openclaw-ollama > .local/openclaw-ollama-10.yaml
nemoclaw apply --non-interactive --state-dir .local/gpu-autoscaling-openclaw .local/openclaw-ollama-10.yaml
kubectl get pods -n nemoclaw-v1-gpu-autoscaling-openclaw
```

Deep Agents uses `render-sandboxes.sh deepagents-nim` and `--state-dir .local/gpu-autoscaling-deepagents`. The chart must serve NIM.

### 6d. OpenClaw and Hermes together

Step 6d runs 2 OpenClaw sandboxes and 6 Hermes sandboxes in one deployment. It installs this same chart twice. The vLLM release is `nemoclaw-gpu-vllm`. The Ollama release is `nemoclaw-gpu-ollama`. Each Horizontal Pod Autoscaler ceiling is 8. Both releases schedule onto the same GPUs. A pod that does not fit stays Pending. A quiet runtime holds only the replicas it is still running. Scale-down removes one of those replicas every 10 seconds after a 60 second wait.

`DCGM_NAMESPACE=gpu-operator` matches this DGX. The script installs the vLLM release with Prometheus and Envoy, then adds the Ollama release.

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
DCGM_NAMESPACE=gpu-operator ./scripts/install-two-runtimes.sh
```

Put the real image digests in `openclaw-ollama.yaml` and `hermes-vllm.yaml` before rendering. Export each image's metadata to its own file. Do not commit those files or `.local/`.

```bash
export PATH="/home/maggiez/NemoClaw-v1/dist/linux_amd64/bin:${HOME}/.local/openshell-0.1.4:${PATH}"
export NEMOCLAW_OPENCLAW_IMAGE_METADATA="${PWD}/openclaw.metadata.json"
export NEMOCLAW_HERMES_IMAGE_METADATA="${PWD}/hermes.metadata.json"
export GPU_OLLAMA_API_KEY="$(kubectl -n nemoclaw-gpu-ollama get secret nemoclaw-gpu-ollama-metrics-proxy-inference-api -o jsonpath='{.data.api-key}' | base64 -d)"
export GPU_VLLM_API_KEY="$(kubectl -n nemoclaw-gpu-vllm get secret nemoclaw-gpu-vllm-metrics-proxy-inference-api -o jsonpath='{.data.api-key}' | base64 -d)"
./scripts/render-mixed-sandboxes.sh > .local/openclaw-hermes.yaml
nemoclaw apply --non-interactive --state-dir .local/gpu-autoscaling-mixed .local/openclaw-hermes.yaml
kubectl get pods -n nemoclaw-v1-gpu-autoscaling-mixed
```

`user-0000` and `user-0001` are OpenClaw. `user-0002` through `user-0007` are Hermes. Ready means each pod is `1/1 Running`. Skip apply when those pods are already Running.

Apply writes `terraform.tfstate` in the state directory from that command. Apply refuses to take over a namespace that already exists. OpenClaw and Deep Agents use their own namespaces, so their sandboxes can stay up beside Hermes.

After the `user-NNNN` pods are Ready, switch the metric with `./scripts/set-hpa-metric.sh` and start a client under [Load tests](#load-tests).

After apply, a gateway prompt is:

```bash
NEMOCLAW_V1_STATE_DIR=.local/gpu-autoscaling ./scripts/invoke.sh
```

`development` gives that command no operator token. To use it, set `gateway.kubernetes.authentication.profile` to `oidc`, fill `openshell.gateway.oidc`, and set `token.env`. Export a bearer token, apply again with the same state directory, port-forward the gateway, and run `openshell gateway add`. Those `oidc` steps have not been run on a cluster. Until an issuer exists, keep `development` for apply. The load clients below do not need that token.

## Load tests

The DGX serves inference and prints the HPA. A client only sends chats. The same client flags work on the DGX and on a laptop. The client does not set `maxReplicas` and does not print the HPA.

On the DGX, leave this watch running. It prints the live metric.

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```

`INFLIGHT` is the concurrent chats per user. `MAX_TOKENS` is the maximum reply length. GPU utilization sets both flags on the client. Latency omits them. Hermes latency is `INFLIGHT=1` and `MAX_TOKENS=2048` in the code, and a leftover `MAX_TOKENS` from a GPU-utilization run does not apply. The HPA `maxReplicas` is the GPU ceiling. The client reads it and stops new chats there. The sandbox pods from apply must be Ready before the client starts. One sandbox per user.

Hermes GPU utilization:

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
INFLIGHT=2 MAX_TOKENS=1024 E2E_USERS=10 ./scripts/client-hermes.sh
```

Hermes latency. Switch the metric on the DGX first, then run the client with the flags omitted:

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
./scripts/set-hpa-metric.sh latency_avg
E2E_USERS=10 ./scripts/client-hermes.sh
```

OpenClaw GPU utilization is `INFLIGHT=4 MAX_TOKENS=2048` with [`client-openclaw.sh`](scripts/client-openclaw.sh). OpenClaw latency omits the flags (`INFLIGHT=1`, `MAX_TOKENS=2048`). Deep Agents GPU utilization is `INFLIGHT=3` with [`client-deepagents.sh`](scripts/client-deepagents.sh). One chat in flight stayed at 5 GPUs.

Step 6d uses one state directory and two clients. Run them in two terminals after the mixed pods are Ready. Each client reads its own HPA.

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
export NEMOCLAW_V1_STATE_DIR=.local/gpu-autoscaling-mixed
export V1_NAMESPACE=nemoclaw-v1-gpu-autoscaling-mixed
NAMESPACE=nemoclaw-gpu-ollama HPA_NAME=nemoclaw-gpu-ollama-metrics-proxy \
  E2E_USERS=2 E2E_USER_OFFSET=0 INFLIGHT=4 MAX_TOKENS=2048 \
  ./scripts/client-openclaw.sh
```

```bash
cd /home/maggiez/NemoClaw-v1/examples/kubernetes-gpu-autoscaling
export NEMOCLAW_V1_STATE_DIR=.local/gpu-autoscaling-mixed
export V1_NAMESPACE=nemoclaw-v1-gpu-autoscaling-mixed
NAMESPACE=nemoclaw-gpu-vllm HPA_NAME=nemoclaw-gpu-vllm-metrics-proxy \
  E2E_USERS=6 E2E_USER_OFFSET=2 INFLIGHT=2 MAX_TOKENS=1024 \
  ./scripts/client-hermes.sh
```

Watch each pool with `./scripts/get-hpa.sh -n nemoclaw-gpu-ollama -w` and `./scripts/get-hpa.sh -n nemoclaw-gpu-vllm -w`. Switch one pool's metric with `NAMESPACE=nemoclaw-gpu-ollama RELEASE=nemoclaw-gpu-ollama ./scripts/set-hpa-metric.sh latency_avg` or `NAMESPACE=nemoclaw-gpu-vllm RELEASE=nemoclaw-gpu-vllm ./scripts/set-hpa-metric.sh gpu_utilization`.

A laptop uses the same `INFLIGHT` and `MAX_TOKENS` flags. It does not run `get-hpa.sh`. The DGX watch above is the HPA print. This Fabric client still runs on the DGX, next to the apply state. Fabric does not serve the v0 Hermes HTTP port, so the laptop cannot send chats to `:8642`.

Set `E2E_OUTPUT_DIR` to keep each run's logs apart. The chart `maxReplicas` is 8. Recorded runs in [`RESULTS-6b.md`](RESULTS-6b.md) and [`RESULTS-6c.md`](RESULTS-6c.md) peaked at 7 because another workload held one GPU.

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
