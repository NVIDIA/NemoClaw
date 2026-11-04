<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GPU Autoscaling on Kubernetes

Run one agent sandbox per user on Kubernetes, all sharing a GPU inference Service that Kubernetes scales from one GPU pod to several as load grows.
The [kubernetes-gpu-autoscaling chart](https://github.com/NVIDIA/nemoclaw-community/tree/ae756c28bda501eb9c4b7ec26d977e6f0c6fd2fc/examples/recipes/nvidia/kubernetes-gpu-autoscaling) in NVIDIA/nemoclaw-community runs the inference pods, their HorizontalPodAutoscaler, and the metrics it scales on.
NemoClaw runs only the gateway and the sandboxes, which reach the chart's Service as [a model server in the cluster](../../../docs/kubernetes.md#use-a-model-server-in-the-cluster).

[openclaw-ollama.yaml](openclaw-ollama.yaml) declares two OpenClaw sandboxes, `user-0000` and `user-0001`, that use the chart's Ollama runtime.
The chart also serves vLLM and NVIDIA NIM; [Choose a Pairing](#choose-a-pairing) lists what to change for those.
No automated test covers this procedure; [current limits](../../../docs/limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

- **The cluster, NemoClaw bundle and agent images** that [Deploy to Kubernetes or OpenShift](../../../docs/kubernetes.md#prerequisites) lists.
- **For the chart:** NVIDIA GPU nodes with the NVIDIA GPU Operator and its DCGM exporter, Metrics Server, `helm` and `kubectl` with a context that can install cluster-wide charts, and `git`.
  The chart pins its Ollama and Node.js images to linux/amd64 digests, so its pods need AMD64 GPU nodes.
  The chart's [README](https://github.com/NVIDIA/nemoclaw-community/blob/ae756c28bda501eb9c4b7ec26d977e6f0c6fd2fc/examples/recipes/nvidia/kubernetes-gpu-autoscaling/README.md#install-details) describes its scheduling, storage and runtime options.
- **`jq`** and the pinned OpenShell CLI, to invoke an agent.

## Install the Inference Chart

The chart's `install-hpa.sh` installs, if missing, a Prometheus stack and Prometheus Adapter in `monitoring` and Envoy Gateway in `envoy-gateway-system`, then the chart as the Helm release `nemoclaw-gpu` in the namespace `nemoclaw-gpu`.
It waits until the first inference pod is ready, which includes the model download.
Clone the chart at the revision these instructions were written against, then install it with the runtime for your pairing:

```sh
git clone https://github.com/NVIDIA/nemoclaw-community.git
cd nemoclaw-community
git checkout ae756c28bda501eb9c4b7ec26d977e6f0c6fd2fc
cd examples/recipes/nvidia/kubernetes-gpu-autoscaling
INFERENCE_RUNTIME=ollama DCGM_NAMESPACE=gpu-operator MAX_REPLICAS=8 ./scripts/install-hpa.sh
```

Set `DCGM_NAMESPACE` to the namespace of the DCGM exporter, `gpu-operator` for the Helm-installed GPU Operator, and `MAX_REPLICAS` to the most GPU pods the chart may run.
The chart runs one runtime per release; installing again with another `INFERENCE_RUNTIME` replaces the release's pods.
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
To rotate it, follow [A Key You Supply to a Model Server on Another Platform](../../../docs/credential-rotation.md#a-key-you-supply-to-a-model-server-on-another-platform).

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
NemoClaw itself doesn't place NIM ([#12649](https://github.com/NVIDIA/NemoClaw/issues/12649)).

## Deploy the Sandboxes

From the NemoClaw repository root, build the agent image and its metadata bundle, as [Prepare Agent Images](../../../docs/kubernetes.md#prepare-agent-images) describes, then push the image and note the digest of the pushed index:

```sh
mkdir -p .local/gpu-autoscaling
cargo images build --platform linux/amd64 openclaw
cargo images export-metadata nc-fabric:openclaw --output .local/openclaw.metadata.json
```

Copy the file into the deployment directory:

```sh
cp examples/kubernetes/gpu-autoscaling/openclaw-ollama.yaml .local/gpu-autoscaling/deployment.yaml
```

In the copy, set:

- `metadata.uid` to a new UUID;
- `gateway.kubernetes.context` to the exact context;
- each sandbox's `image.ref` to the pushed image's digest;
- if you will [invoke agents](#invoke-an-agent) yourself, the `oidc` profile and your issuer, as [Authenticate Through an Existing OIDC Issuer](../../../docs/kubernetes.md#authenticate-through-an-existing-oidc-issuer) describes.

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

1. [Reach the gateway from the OpenShell CLI](../../../docs/kubernetes.md#reach-the-gateway-from-the-openshell-cli).
2. [Select the gateway and workspace](../../../docs/interfaces.md#select-the-gateway-and-workspace).
3. Copy a sandbox's command from apply's **Agents** list, or, from the deployment directory, read its runtime ID from a plan's JSON result, then send one prompt, as [Run One Headless OpenClaw Request](../../../docs/agents.md#run-one-headless-openclaw-request) describes:

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

This directory has no load client to drive many agents at once.

## Remove the Deployment

From the deployment directory, destroy the sandboxes and gateway, as [Destroy a Deployment](../../../docs/kubernetes.md#destroy-a-deployment) describes:

```sh
nemoclaw plan --destroy --state-dir state
nemoclaw destroy --state-dir state
```

Then remove the chart release and the Secrets it keeps, the inference key and Envoy's sign-in:

```sh
helm uninstall nemoclaw-gpu --namespace nemoclaw-gpu
kubectl --namespace nemoclaw-gpu delete secret nemoclaw-gpu-metrics-proxy-inference-api nemoclaw-gpu-metrics-proxy-ingress-auth
```

The chart's [uninstall section](https://github.com/NVIDIA/nemoclaw-community/blob/ae756c28bda501eb9c4b7ec26d977e6f0c6fd2fc/examples/recipes/nvidia/kubernetes-gpu-autoscaling/README.md#full-recipe-uninstall) lists the Prometheus stack, Prometheus Adapter and Envoy Gateway that remain installed.
Each GPU node keeps the downloaded model under `/var/lib/nemoclaw-gpu` until you delete it.
