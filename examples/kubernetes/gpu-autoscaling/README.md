<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GPU Autoscaling on Kubernetes

Run one agent sandbox per user on Kubernetes, all sharing a GPU inference Service that Kubernetes scales from one GPU pod to several as load grows.
The [kubernetes-gpu-autoscaling chart](https://github.com/NVIDIA/nemoclaw-community/tree/17a5af9b7eac0a33cb3a2b2f82bc83585cee8595/examples/recipes/nvidia/kubernetes-gpu-autoscaling) in NVIDIA/nemoclaw-community runs the inference pods, their HorizontalPodAutoscaler, and the metrics it scales on.
NemoClaw runs only the gateway and the sandboxes, which reach the chart's Service as [a model server in the cluster](../../../docs/build-deploy/kubernetes.md#use-a-model-server-in-the-cluster).

[openclaw-ollama.yaml](openclaw-ollama.yaml) declares two OpenClaw sandboxes, `user-0000` and `user-0001`, that use the chart's Ollama runtime.
The chart also serves vLLM and NVIDIA NIM; [Choose a Pairing](#choose-a-pairing) lists what to change for those.
[two-runtimes.yaml](two-runtimes.yaml) declares a Hermes sandbox on the chart's vLLM runtime and an OpenClaw sandbox on its Ollama runtime, set up for [load.sh](load.sh), which sends prompts to the agents to load the GPUs.
No automated test covers this procedure; [current limits](../../../docs/resources/limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

- **The cluster, NemoClaw bundle and agent images** that [Deploy to Kubernetes or OpenShift](../../../docs/build-deploy/kubernetes.md#prerequisites) lists.
- **For the chart:** NVIDIA GPU nodes with the NVIDIA GPU Operator and its DCGM exporter, Metrics Server, `helm` and `kubectl` with a context that can install cluster-wide charts, and `git`.
  The chart pins multi-platform image digests, so its pods run on `linux/amd64` and `linux/arm64` nodes; its [prerequisites](https://github.com/NVIDIA/nemoclaw-community/blob/17a5af9b7eac0a33cb3a2b2f82bc83585cee8595/examples/recipes/nvidia/kubernetes-gpu-autoscaling/README.md#prerequisites) list the images and what to check when you override one.
  The chart's [README](https://github.com/NVIDIA/nemoclaw-community/blob/17a5af9b7eac0a33cb3a2b2f82bc83585cee8595/examples/recipes/nvidia/kubernetes-gpu-autoscaling/README.md#install-details) describes its scheduling, storage and runtime options.
- **`jq`** and the pinned OpenShell CLI, to invoke an agent, and **`curl`**, for `load.sh`.

## Install the Inference Chart

The chart's `install-hpa.sh` installs, if missing, a Prometheus stack and Prometheus Adapter in `monitoring` and Envoy Gateway in `envoy-gateway-system`, then the chart as the Helm release `nemoclaw-gpu` in the namespace `nemoclaw-gpu`.
It waits until the first inference pod is ready, which includes the model download.
Clone the chart at the revision these instructions were written against, then install it with the runtime for your pairing:

```sh
git clone https://github.com/NVIDIA/nemoclaw-community.git
cd nemoclaw-community
git checkout 17a5af9b7eac0a33cb3a2b2f82bc83585cee8595
cd examples/recipes/nvidia/kubernetes-gpu-autoscaling
INFERENCE_RUNTIME=ollama DCGM_NAMESPACE=gpu-operator MAX_REPLICAS=8 ./scripts/install-hpa.sh
```

Set `DCGM_NAMESPACE` to the namespace of the DCGM exporter, `gpu-operator` for the Helm-installed GPU Operator, and `MAX_REPLICAS` to the most GPU pods the chart may run.
The chart runs one runtime per release; installing again with another `INFERENCE_RUNTIME` replaces the release's pods.
To run two pairings at once, see [Run Two Runtimes on Shared GPUs](#run-two-runtimes-on-shared-gpus).
Each pod is ready, `2/2`, when the runtime has the model and the metrics proxy beside it answers:

```sh
kubectl --namespace nemoclaw-gpu get pods,hpa
```

## Find the Service and Key

The sandboxes send requests to Envoy, which `install-hpa.sh` installs unless `ENABLE_ENVOY_LB=0`.
Envoy Gateway serves the chart's Gateway, `<release>-metrics-proxy`, through a Service in `envoy-gateway-system` whose name ends in a hash.
Find it by the Gateway's labels:

```sh
kubectl --namespace envoy-gateway-system get service \
  -l gateway.envoyproxy.io/owning-gateway-namespace=nemoclaw-gpu,gateway.envoyproxy.io/owning-gateway-name=nemoclaw-gpu-metrics-proxy
```

For the release `nemoclaw-gpu` in `nemoclaw-gpu`, the Service is `envoy-nemoclaw-gpu-nemoclaw-gpu-metrics-proxy-4620f768`, and the configuration's address is `http://envoy-nemoclaw-gpu-nemoclaw-gpu-metrics-proxy-4620f768.envoy-gateway-system.svc.cluster.local:80/v1`.
For another release or namespace, put the name the command prints in `endpoint`.
Envoy sends each request to the inference pod with the fewest requests in flight, so pods the autoscaler adds take load.
Its route for in-cluster callers has no authentication of its own; the metrics proxy in each pod checks the key.

If the chart runs without Envoy, set `endpoint` to its metrics proxy Service instead, `http://nemoclaw-gpu-metrics-proxy.nemoclaw-gpu.svc.cluster.local:8081/v1`.
Kubernetes then balances connections, not requests, so an open connection stays on its pod after the autoscaler adds more.

The proxy accepts requests that carry the key the chart generated.
The chart keeps the key in the Secret `nemoclaw-gpu-metrics-proxy-inference-api`, which survives `helm uninstall`.
Read it into the variable the configuration names, in the shell that runs `nemoclaw`, without printing it:

```sh
export GPU_INFERENCE_API_KEY="$(kubectl --namespace nemoclaw-gpu get secret nemoclaw-gpu-metrics-proxy-inference-api -o jsonpath='{.data.api-key}' | base64 -d)"
```

Apply stores the key in OpenShell, which adds it to the sandboxes' requests; the sandboxes never see it.
To rotate it, follow [A Key You Supply to a Model Server on Another Platform](../../../docs/security/credential-rotation.md#a-key-you-supply-to-a-model-server-on-another-platform).

## Choose a Pairing

The file pairs OpenClaw with Ollama.
For another pairing, install the chart with its runtime and change the file's `harness.kind`, image, `model` and `maxTokens`:

| Pairing | `INFERENCE_RUNTIME` | `harness.kind` | Image | `model` | `maxTokens` |
|---|---|---|---|---|---|
| OpenClaw and Ollama | `ollama` | `nvidia.fabric.openclaw` | `openclaw` | `llama3.2:3b` | 2048 |
| Hermes and vLLM | `vllm` | `nvidia.fabric.hermes` | `hermes` | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | 2048 |
| Deep Agents and NIM | `nim` | `nvidia.fabric.langchain.deepagents` | `deepagents` | `nvidia/nemotron-3-nano` | 1024 |

`model` must match the model the chart serves, its `inference.model` value; the proxy sends every request to that model.
NIM requires an NGC API key; the chart's README describes the Secrets to create before `install-hpa.sh`.
vLLM reserves the fraction `vllm.gpuMemoryUtilization` of the GPU's memory, 0.85 in the chart's `values.yaml`, and doesn't start if less is free.
On a GPU that shares its memory with the host, such as DGX Spark's, the host's own use can leave less free; lower the value in `values.yaml` before you install.
NemoClaw itself doesn't place NIM ([#12649](https://github.com/NVIDIA/NemoClaw/issues/12649)).

### Run Two Runtimes on Shared GPUs

To serve Hermes with vLLM and OpenClaw with Ollama from the same GPUs, install the chart twice with its `install-two-runtimes.sh` instead of `install-hpa.sh`:

```sh
DCGM_NAMESPACE=gpu-operator MAX_REPLICAS=8 ./scripts/install-two-runtimes.sh
```

It installs the release `nemoclaw-gpu-vllm` in the namespace of the same name, and `nemoclaw-gpu-ollama` likewise, each with its own autoscaler whose ceiling is `MAX_REPLICAS`.
Both ceilings count the same GPUs, so a pod that doesn't fit stays Pending until the other runtime scales down.
For each release, use its name as the namespace and release in [Find the Service and Key](#find-the-service-and-key): its Gateway is `<release>-metrics-proxy` and its key Secret is `<release>-metrics-proxy-inference-api`.
In the configuration, declare one inference provider and one inference per release, each with that release's key variable and model, and point each sandbox's `agent.inferenceRef` at the inference for its pairing, as [two-runtimes.yaml](two-runtimes.yaml) does with `GPU_VLLM_API_KEY` and `GPU_OLLAMA_API_KEY`.

## Deploy the Sandboxes

The agent image must match the architecture of the nodes that run the sandboxes; list each node's architecture:

```sh
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.architecture}{"\n"}{end}'
```

On a host of that architecture, from the NemoClaw repository root, build the agent image for its platform, `linux/arm64` or `linux/amd64`, and its metadata bundle, as [Prepare Agent Images](../../../docs/build-deploy/kubernetes.md#prepare-agent-images) and [Build Agent Images](../../../docs/build-deploy/build.md#build-agent-images) describe, then push the image and note the digest of the pushed index:

```sh
mkdir -p .local/gpu-autoscaling
PLATFORM=linux/arm64 # or linux/amd64, to match the nodes
cargo images build --platform "$PLATFORM" openclaw
cargo images export-metadata nc-fabric:openclaw --output .local/openclaw.metadata.json
```

For [two-runtimes.yaml](two-runtimes.yaml), build and export `hermes` as well, and set `HERMES_IMAGE_METADATA` and `OPENCLAW_IMAGE_METADATA` to the two bundles instead of `NEMOCLAW_AGENT_IMAGE_METADATA`.

Copy the file into the deployment directory:

```sh
cp examples/kubernetes/gpu-autoscaling/openclaw-ollama.yaml .local/gpu-autoscaling/deployment.yaml
```

In the copy, set:

- `metadata.uid` to a new UUID;
- `gateway.kubernetes.context` to the exact context;
- each sandbox's `image.ref` to the pushed image's digest;
- if you will [invoke agents](#invoke-an-agent) yourself, the `oidc` profile and your issuer, as [Authenticate Through an Existing OIDC Issuer](../../../docs/build-deploy/kubernetes.md#authenticate-through-an-existing-oidc-issuer) describes.

Each sandbox serves one user.
To add a user, copy a sandbox entry under a new name, such as `user-0002`.

From the deployment directory, preview the deployment, then apply it:

```sh
cd .local/gpu-autoscaling
export NEMOCLAW_CLUSTER_KUBECONFIG="$HOME/.kube/config"
export NEMOCLAW_AGENT_IMAGE_METADATA="$PWD/../openclaw.metadata.json"
nemoclaw plan --state-dir state deployment.yaml
nemoclaw apply --state-dir state deployment.yaml
```

Apply creates the gateway in `nemoclaw-gpu-autoscaling` and starts an agent in each sandbox; it changes nothing in `nemoclaw-gpu`.
Keep the state directory: destroy needs it.
A running agent does not show that inference works; invoke one to check.

## Invoke an Agent

With the `development` profile, only NemoClaw can authenticate to the gateway, so you can't invoke agents.
With the `oidc` profile:

1. [Reach the gateway from the OpenShell CLI](../../../docs/build-deploy/kubernetes.md#reach-the-gateway-from-the-openshell-cli).
2. [Select the gateway and workspace](../../../docs/agents-inference/interfaces.md#select-the-gateway-and-workspace).
3. Copy a sandbox's command from apply's **Agents** list, or read its runtime ID from `agents.SANDBOX.runtimeId` in apply's or a plan's JSON result, then send one prompt, as [Run One Headless OpenClaw Request](../../../docs/agents-inference/agents.md#run-one-headless-openclaw-request) describes.
   From the deployment directory, a plan reports the runtimes the last apply left without changing them:

```sh
sandbox=user-0000
RUNTIME_ID=$(nemoclaw plan -o json --progress off --non-interactive --state-dir state deployment.yaml | jq -r --arg sandbox "$sandbox" '.agents[$sandbox].runtimeId')
openshell sandbox exec -n "$sandbox" --no-tty -- fabric-agent-ctl invoke --agent assistant --runtime-id "$RUNTIME_ID" --input - <<'JSON'
"Reply with exactly READY."
JSON
```

Check `result.status` and `result.output.response`.
The request goes through Envoy and the chart's metrics proxy to a GPU pod.
Watch the autoscaler's metric and replica count while agents work:

```sh
kubectl --namespace nemoclaw-gpu get hpa --watch
```

The autoscaler scales on GPU utilization or on average request latency; the chart's `scripts/set-hpa-metric.sh gpu_utilization` or `scripts/set-hpa-metric.sh latency_avg` switches an installed release between them without changing its runtime or model.
Set `RELEASE` and `NAMESPACE` for a release other than `nemoclaw-gpu`.

## Drive Load Through the Agents

[load.sh](load.sh) sends prompts to every agent of a deployment, a bounded number at a time, and reports each request's latency and errors.
It reaches the agents only through the gateway, as the OpenShell CLI, so the deployment must use the `oidc` profile, as [two-runtimes.yaml](two-runtimes.yaml) does.
It sends each sandbox's prompts one of two ways:

- **Hermes's API server**, for a sandbox whose apply result lists an `api` interface and a service URL for it: an OpenAI chat completion to that URL, with the interface's token.
  Declare both in the sandbox, as `user-0000` in `two-runtimes.yaml` does: `harness.settings.interfaces.api` with its `port`, and a `serviceExposures` entry named `api` for that port with `authorizationMode: BEARER_PASSTHROUGH`, so that the gateway passes the token on to Hermes.
  The script reads the token once, with `openshell sandbox exec … cat` and the `tokenPath` that apply reports.
- **`fabric-agent-ctl invoke`**, for any other sandbox, such as OpenClaw or Deep Agents: through `openshell sandbox exec`, with the runtime ID that apply reports under `agents`.

Apply with JSON output and keep the result, from the deployment directory:

```sh
nemoclaw apply -o json --progress off --non-interactive --state-dir state deployment.yaml > apply.json
```

Then, as in [Invoke an Agent](#invoke-an-agent), keep the gateway's port forward running and select the gateway and workspace, and run the script with the number of prompts and the most to send at once:

```sh
PROMPTS=40 CONCURRENCY=8 ../../examples/kubernetes/gpu-autoscaling/load.sh apply.json
```

A service URL names the gateway's own port, `8080`, under `openshell.localhost`; the script connects to the port forward instead, at `GATEWAY_ADDRESS`, `127.0.0.1:17671` by default, and presents the client certificate from `MTLS_DIR`, by default the directory where you copied it for the OpenShell CLI.
`PROMPT_FILE` replaces the built-in prompts with one prompt per line, `TIMEOUT` limits each request, 300 seconds by default, and `RESULTS` names a file for one JSON line per request.
The script prints how many prompts it sent and how many replied, the median, 95th-percentile and longest latency of replies, overall and per sandbox, up to 10 failures, and one reply per sandbox.
It exits nonzero if any request failed.
A request that reaches `TIMEOUT` counts as failed; the script stops waiting for it but doesn't cancel the agent's run.

- Each apply that starts a new runtime changes its runtime ID and Hermes's token: apply again with `-o json`, then rerun the script.
- Each `fabric-agent-ctl invoke` is one `openshell sandbox exec` through the gateway, which NemoClaw limits to one CPU ([limits](../../../docs/resources/limits.md)), and Fabric runs one invocation at a time per runtime, so concurrent prompts to one such sandbox wait in the sandbox, not on the GPUs.
- Hermes's API server runs at most 10 requests at once per sandbox by default and answers `429` beyond that.
- A service URL skips the gateway's sign-in: anyone who can reach the gateway's listener with its client certificate can reach Hermes's API, which only its token protects; see [who can use an interface](../../../docs/agents-inference/interfaces.md#who-can-use-an-interface).
- The OpenShell CLI doesn't renew a token it got through client credentials ([NVIDIA/OpenShell#4287](https://github.com/NVIDIA/OpenShell/issues/4287)); for a run longer than the token's lifetime, sign in again first.

## Remove the Deployment

From the deployment directory, destroy the sandboxes and gateway, as [Destroy a Deployment](../../../docs/build-deploy/kubernetes.md#destroy-a-deployment) describes:

```sh
nemoclaw plan --destroy --state-dir state
nemoclaw destroy --state-dir state
```

Then remove the chart release and the Secrets it keeps, the inference key and Envoy's sign-in:

```sh
helm uninstall nemoclaw-gpu --namespace nemoclaw-gpu
kubectl --namespace nemoclaw-gpu delete secret nemoclaw-gpu-metrics-proxy-inference-api nemoclaw-gpu-metrics-proxy-ingress-auth
```

The chart's [uninstall section](https://github.com/NVIDIA/nemoclaw-community/blob/17a5af9b7eac0a33cb3a2b2f82bc83585cee8595/examples/recipes/nvidia/kubernetes-gpu-autoscaling/README.md#full-recipe-uninstall) lists the Prometheus stack, Prometheus Adapter and Envoy Gateway that remain installed.
Each GPU node keeps the downloaded model under `/var/lib/nemoclaw-gpu` until you delete it.
