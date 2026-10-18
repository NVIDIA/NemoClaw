<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy to Kubernetes or OpenShift

Run agent sandboxes on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development OpenShell gateway in a namespace it creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes and OpenShift.

The managed gateway's authentication is a development fixture, not a production identity service ([#12692](https://github.com/NVIDIA/NemoClaw/issues/12692)).
OpenShift's security policy admitting these pods is untested; [current limits](limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

- **A NemoClaw bundle:** [build one](build.md#build-a-native-bundle) from this revision.
  The bundle includes the Helm provider that installs the gateway; no Helm CLI is needed.
- **Cluster access:** a kubeconfig file and an exact context that can create a namespace and, inside it, Secrets, ConfigMaps, Services, Deployments, StatefulSets and NetworkPolicies.
  The SDK reads the cluster's CustomResourceDefinitions, StorageClasses and namespaces.
  If the kubeconfig runs an exec plugin that needs your environment, such as `aws` for EKS, list those variables in `gateway.kubernetes.environment`, for example `[AWS_PROFILE, AWS_REGION]`.
  OpenTofu and its providers receive only platform variables such as `PATH` and `HOME`, plus the ones you list.
- **Cluster setup, done by the platform operator:**
  - [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox), with its controller running in `agent-sandbox-system`; CI tests version 0.5.0.
  - Exactly one default StorageClass.
- **Agent images:** pushed to a registry the cluster can pull from, and referenced by digest.
- **Inference:** an endpoint reachable from inside the sandboxes, such as a [model server you run in the cluster](#use-a-model-server-in-the-cluster).
  Managed model services under `spec.services` are not supported on Kubernetes ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

NemoClaw installs nothing cluster-wide and never selects a context for you.

## Prepare Agent Images

A cluster sandbox names its image's metadata bundle in `image.metadata`, because no local engine can inspect the image there.
From the repository root, build the image, then write its bundle to a new file:

```sh
cargo images build --platform linux/amd64 openclaw
cargo images export-metadata nc-fabric:openclaw --platform linux/amd64 --output openclaw.metadata.json
```

Push the image, then use the digest of the pushed index in `image.ref`.
The bundle is checked against that digest, so it must come from the same build.
Set the environment variable named in `image.metadata` to the bundle's path before each command.
See [Build agent images](build.md#build-agent-images) for the harnesses each platform builds.

## Deploy with a Managed Gateway

The SDK creates the namespace and a credential key, starts a development token issuer, and installs the pinned OpenShell chart.
The `openshell` and `fabric` providers reach the gateway through port forwards they open on free loopback ports while OpenTofu runs.
Start from [the Kubernetes example](../examples/kubernetes/managed-development.yaml) and set:

- `metadata.uid` to a new UUID.
- `gateway.kubernetes.kubeconfig` to the environment variable holding the kubeconfig path, and `context` to the exact context.
- `gateway.kubernetes.namespace` to a namespace that does not exist yet; NemoClaw does not take over an existing one.
- `gateway.endpoint` to `https://127.0.0.1:` and an explicit port. Providers forward on free ports of their own, so this port is not bound.
- Each sandbox's `image.ref` and `image.metadata`.

```yaml
spec:
  gateway:
    management: managed
    runtime:
      provider: kubernetes
    endpoint: https://127.0.0.1:17671
    kubernetes:
      kubeconfig: {env: NEMOCLAW_CLUSTER_KUBECONFIG}
      context: my-cluster
      namespace: nemoclaw-development
      authentication:
        profile: development
```

From the directory holding `deployment.yaml`, preview the deployment, then apply it:

```sh
export NEMOCLAW_CLUSTER_KUBECONFIG="$HOME/.kube/config"
export NEMOCLAW_AGENT_IMAGE_METADATA="$PWD/openclaw.metadata.json"
nemoclaw plan --state-dir .local/kubernetes deployment.yaml
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

Apply creates the gateway and every sandbox, and starts each agent.
Keep the state directory: it holds the cluster ownership receipt and the development issuer's keys, and destroy needs both.
[Managed Kubernetes ownership](design/architecture.md#managed-kubernetes-ownership) describes which component owns each resource.

## Deploy to OpenShift

Set `gateway.runtime.provider: openshift`; everything else matches the managed Kubernetes deployment above.
Start from [the OpenShift example](../examples/openshift/managed-development.yaml).

OpenShift assigns each namespace a UID and group range and admits only those identities.
After creating the namespace, the SDK waits up to 30 seconds for OpenShift to record that range, then runs the gateway as its first UID and group.
OpenShell runs each sandbox as the same UID.
If the range never appears, apply stops before installing the gateway with `OpenShift did not assign the namespace a UID range`; check that the context points at an OpenShift cluster.

The SDK records the range in its receipt, and a later apply refuses a namespace whose range has changed.
The agent images need no OpenShift variant: any UID can read their workspace seed.

## Use an Existing Gateway

To use an OpenShell gateway someone else runs on the cluster, set `gateway.management: external` with `runtime.provider` set to `kubernetes` or `openshift`.
Give its endpoint, credential and TLS material as environment references, as in [the external gateway example](../examples/kubernetes/external-gateway.yaml).
NemoClaw then manages only the sandboxes; it neither installs nor removes the gateway.
Sandboxes still need `image.metadata`.

## Use a Model Server in the Cluster

Sandboxes can use a model server that you run in the gateway's cluster.
NemoClaw creates nothing for it; you deploy the server, and the sandboxes reach it through its Service.
This has been tried on one kind cluster; [current limits](limits.md#platforms-models-and-placement) lists what is untested.
Name the Service by its cluster DNS name and port:

```yaml
spec:
  inferenceProviders:
    - name: qwen
      provider: openai
      api: openai-completions
      endpoint: http://qwen.models.svc.cluster.local:8000/v1
      credential: {env: QWEN_INFERENCE_KEY}
```

- **Form:** `http://<service>.<namespace>.svc.cluster.local:<port>`, with an optional path such as `/v1`, and `gateway.runtime.provider` set to `kubernetes` or `openshift`.
  Only the `cluster.local` domain is accepted, and the short `<service>.<namespace>` form is not.
- **No catalog read:** cluster names resolve only inside the cluster, so plan and onboarding do not read the server's model catalog.
  A successful plan does not show that the server is running or serves the route's model.
- **Destination:** OpenShell decides which address the name may reach when sandboxes connect; NemoClaw grants no address.
  OpenShell refuses the Kubernetes control-plane ports 2379, 2380, 6443, 10250 and 10255, so serve the model on another port.
- **Key:** `credential` is optional.
  It names the variable that holds the server's key where you run `nemoclaw`; OpenShell stores the key and adds it to sandbox requests.
  The key crosses the cluster network over plain HTTP unless your network plugin or a service mesh encrypts Pod traffic.

Start from [the in-cluster vLLM example](../examples/kubernetes/in-cluster-vllm.yaml), or from [the in-cluster Ollama example](../examples/kubernetes/in-cluster-ollama.yaml) for a server without a key.

### Run NemoClaw's vLLM Runtime in the Cluster

The steps below run NemoClaw's vLLM runtime as a Deployment in the namespace `models`, protected by a key.
They are a starting point, not a qualified configuration; choose the GPU, storage and limits for your cluster.
You need:

- A GPU node with the NVIDIA device plugin.
- A network plugin that enforces NetworkPolicies.
- The [vLLM runtime image](build.md#build-a-runtime-image) for the node's architecture, pushed to a registry the cluster can pull from and referenced by digest.

Run `kubectl` against the gateway's cluster, for example with `--context my-cluster`.

1. Compute the runtime's settings with `vllm_runtime`, in an OpenTofu configuration of its own that installs the bundle's `vllm` provider as [Direct OpenTofu Usage](provider.md#direct-opentofu-usage) describes.
   Set `hardware` to the node's [hardware profile](models.md#choose-a-hardware-profile):

   ```hcl
   data "vllm_runtime" "qwen" {
     authentication = "bearer"
     hardware {
       profile      = "l40s"
       architecture = "amd64"
     }
     model {
       repository = "Qwen/Qwen3-4B"
       revision   = "1cfa9a7208912126459214e8b04321603b3df60c"
     }
     memory {
       gpu_memory_gib = 20
       kv_cache_gib   = 6
     }
     serving {
       port             = 8000
       tool_parser      = "hermes"
       reasoning_parser = "qwen3"
     }
   }

   output "spec" {
     value = data.vllm_runtime.qwen.spec
   }
   ```

   ```sh
   tofu init
   tofu apply
   tofu output -raw spec > runtime-spec.json
   ```

   - **`memory`:** the model's weights, the KV cache and 2 GiB must fit in `gpu_memory_gib`.
     Qwen3-4B's weights take about 7.5 GiB, so the defaults, 16 GiB with an 8 GiB KV cache, are too small, and the server stops with "model weights exceed the declared GPU memory budget".
   - **Parsers:** OpenClaw lets the model choose tools, and vLLM answers such requests with HTTP 400 unless `tool_parser` is set.
     `reasoning_parser` returns Qwen3's reasoning apart from its reply.

   The Deployment below follows the rest of its [`launch` and `requirements`](provider.md#vllm-runtime-contract): the entrypoint, the spec in `NEMOCLAW_RUNTIME_SPEC`, the key in `NEMOCLAW_INFERENCE_KEY`, port 8000, the model cache at `/data`, one GPU, and 8 GiB of shared memory.
   Kubernetes cannot set the `memlock` and `stack` limits, so the node's limits apply.

2. Create the namespace, the key and the settings.
   The key must be 16 to 4096 printable characters without whitespace; keep it in your secret manager.

   ```sh
   export QWEN_INFERENCE_KEY="$(openssl rand -hex 32)"
   kubectl create namespace models
   printf %s "$QWEN_INFERENCE_KEY" |
     kubectl -n models create secret generic qwen-inference-key --from-file=key=/dev/stdin
   kubectl -n models create configmap qwen-runtime --from-file=spec=runtime-spec.json
   ```

3. Create the server's storage, Deployment, Service and NetworkPolicy.
   Replace the image digest, and the sandbox namespace in the NetworkPolicy; a managed gateway runs sandboxes in `gateway.kubernetes.namespace`.
   If the node's default container runtime is not NVIDIA's, set `runtimeClassName` to the cluster's GPU RuntimeClass, such as `nvidia`.

   ```sh
   kubectl apply -f - <<'EOF'
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: qwen-data
     namespace: models
   spec:
     accessModes: [ReadWriteOnce]
     resources:
       requests:
         storage: 100Gi
   ---
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: qwen
     namespace: models
   spec:
     replicas: 1
     # The runtime locks its storage, so the old Pod must stop before a new one starts.
     strategy:
       type: Recreate
     selector:
       matchLabels: {app: qwen}
     template:
       metadata:
         labels: {app: qwen}
       spec:
         # runtimeClassName: nvidia
         automountServiceAccountToken: false
         containers:
           - name: vllm
             image: registry.example.com/nemoclaw/vllm-amd64@sha256:REPLACE_WITH_DIGEST
             command: [/usr/local/bin/nemoclaw-runtime]
             env:
               - name: NEMOCLAW_RUNTIME_SPEC
                 valueFrom:
                   configMapKeyRef: {name: qwen-runtime, key: spec}
               - name: NEMOCLAW_INFERENCE_KEY
                 valueFrom:
                   secretKeyRef: {name: qwen-inference-key, key: key}
             ports:
               - containerPort: 8000
             resources:
               limits:
                 nvidia.com/gpu: 1
             securityContext:
               allowPrivilegeEscalation: false
               capabilities:
                 drop: [ALL]
             volumeMounts:
               - {name: data, mountPath: /data}
               - {name: shm, mountPath: /dev/shm}
             # GET /health needs no key. Downloading and loading may take hours.
             startupProbe:
               httpGet: {path: /health, port: 8000}
               periodSeconds: 10
               failureThreshold: 3240
             readinessProbe:
               httpGet: {path: /health, port: 8000}
               periodSeconds: 10
         volumes:
           - name: data
             persistentVolumeClaim: {claimName: qwen-data}
           - name: shm
             emptyDir: {medium: Memory, sizeLimit: 8Gi}
   ---
   apiVersion: v1
   kind: Service
   metadata:
     name: qwen
     namespace: models
   spec:
     selector: {app: qwen}
     ports:
       - port: 8000
         targetPort: 8000
   ---
   # Admits only OpenShell's sandbox supervisors in the sandbox namespace.
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: qwen
     namespace: models
   spec:
     podSelector:
       matchLabels: {app: qwen}
     policyTypes: [Ingress]
     ingress:
       - from:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: nemoclaw-in-cluster-vllm
             podSelector:
               matchLabels:
                 openshell.ai/managed-by: openshell
                 openshell.ai/boundary-role: supervisor
         ports:
           - port: 8000
   EOF
   ```

4. Wait until the server is ready.
   Apply does not check the server, so a deployment applied earlier fails its requests until then:

   ```sh
   kubectl -n models rollout status deployment/qwen --timeout=9h
   ```

5. With `QWEN_INFERENCE_KEY` still set, [plan and apply](#deploy-with-a-managed-gateway) the deployment.

Each sandbox's OpenShell supervisor Pod makes the sandbox's network connections, so the NetworkPolicy admits only those Pods.
Its selector uses OpenShell's own Pod labels, which OpenShell does not document as a stable interface ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).
The policy trusts those labels: anyone who can create a Pod in the sandbox namespace can give it the labels and reach the server.
Without a network plugin that enforces the policy, every Pod in the cluster can reach the server.
For a server without a key, such as Ollama, the NetworkPolicy is the only access control.

To change the key, give the new key a new variable name.
Apply does not notice a new value behind the same name, so OpenShell would keep sending the old key.

1. Set the new key in a new variable, such as `QWEN_INFERENCE_KEY_2`, and replace the Secret's value:

   ```sh
   printf %s "$QWEN_INFERENCE_KEY_2" |
     kubectl -n models create secret generic qwen-inference-key --from-file=key=/dev/stdin \
       --dry-run=client -o yaml | kubectl apply -f -
   ```

2. Restart the server, which reads the key when it starts, and wait for it as in step 4:

   ```sh
   kubectl -n models rollout restart deployment/qwen
   kubectl -n models rollout status deployment/qwen --timeout=9h
   ```

3. Change the provider's `credential` to `{env: QWEN_INFERENCE_KEY_2}`, then plan and apply.
   Apply [updates OpenShell's registration in place](provider.md#inference-providers) with the new key.

Requests fail from the restart until the apply finishes.
Whether a running sandbox uses the new key without a restart is untested.

NemoClaw's destroy leaves the server, its storage and its Secret in place; delete them yourself, for example with `kubectl delete namespace models`.

### Run Ollama Instead

The [in-cluster Ollama example](../examples/kubernetes/in-cluster-ollama.yaml) uses NemoClaw's Ollama runtime as the Service `ollama` on port 11434, without a key.
Follow the vLLM steps with these changes:

- **Image:** the [Ollama runtime image](inference.md#run-managed-ollama) for the node's architecture.
- **Step 1:** compute `ollama_runtime` instead, with the same `hardware` and the `spec` output.
  It takes no `authentication`, `memory` or parsers here; Ollama's default 16 GiB budget holds `qwen3:0.6b`:

  ```hcl
  data "ollama_runtime" "ollama" {
    hardware {
      profile      = "l40s"
      architecture = "amd64"
    }
    model {
      name   = "qwen3:0.6b"
      digest = "7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435"
    }
    serving {
      port = 11434
    }
  }
  ```

- **Step 2:** skip the key and the Secret, and name the ConfigMap `ollama-runtime`.
- **Step 3:**
  - Name the PVC `ollama-data`, and the Deployment, its container, the Service, the NetworkPolicy and the `app` label `ollama`.
  - Leave out `NEMOCLAW_INFERENCE_KEY`.
  - Use port 11434 in `containerPort`, the probes, the Service and the NetworkPolicy.
  - Point both probes at `GET /api/version`; Ollama has no `/health`.
  - Admit the example's sandbox namespace, `nemoclaw-in-cluster-ollama`.
- **Steps 4 and 5:** wait for `deployment/ollama`, then plan and apply; no key variable is needed.

## Destroy a Deployment

**Destroy deletes every sandbox's files and conversation history.**
Preview it, then run it with the same bundle and state directory:

```sh
nemoclaw plan --destroy --state-dir .local/kubernetes
nemoclaw destroy --state-dir .local/kubernetes
```

Destroy removes the sandboxes, the gateway release and the development issuer.
It keeps the namespace, the credential key Secret and the gateway's persistent volumes, as described in [deletion and retention](state.md#deletion-and-retention).
Removing them is not covered yet ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).
If destroy fails or is interrupted while removing the gateway release, follow [Recover an Interrupted Helm Removal](usage.md#recover-an-interrupted-helm-removal).
