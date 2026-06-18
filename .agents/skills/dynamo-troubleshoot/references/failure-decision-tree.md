# Dynamo Failure Decision Tree

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: CC-BY-4.0
-->

## Cluster Or Namespace

Signals:

- `kubectl config current-context` fails
- namespace does not exist
- no GPU nodes are visible

Checks:

```bash
kubectl config current-context
kubectl get namespace "${NAMESPACE}"
kubectl get nodes -o wide
kubectl describe nodes | grep -A5 -E "nvidia.com/gpu|Capacity|Allocatable"
```

Next action: create namespace, switch context, or use a GPU-capable cluster.

## Secret Or Model Access

Signals:

- model-download job exits quickly
- logs show authentication, 401, 403, gated model, or missing token
- manifest references `HF_TOKEN` but secret/key does not exist

Checks:

```bash
kubectl get secret hf-token-secret -n "${NAMESPACE}"
kubectl logs job/model-download -n "${NAMESPACE}" --tail=100
```

Next action: create or fix the HF secret. Never paste the token into manifests.

## PVC Or Storage Class

Signals:

- PVC is `Pending`
- pod waits on volume mount
- model-download pod cannot write model cache

Checks:

```bash
kubectl get storageclass
kubectl get pvc -n "${NAMESPACE}"
kubectl describe pvc -n "${NAMESPACE}"
```

Next action: patch `storageClassName` in the recipe model-cache YAML and
recreate the PVC/job if needed.

## Image Pull Or Runtime Image

Signals:

- `ImagePullBackOff`
- `ErrImagePull`
- auth errors against a private registry
- backend binary missing at container start

Checks:

```bash
kubectl describe pod <pod> -n "${NAMESPACE}"
kubectl get events -n "${NAMESPACE}" --sort-by=.lastTimestamp | tail -50
```

Next action: patch image tag, add image pull secret, or choose a recipe image
that contains the requested backend.

## GPU Scheduling

Signals:

- pod is `Pending`
- events mention insufficient `nvidia.com/gpu`
- wrong node selector, taint, or toleration

Checks:

```bash
kubectl describe pod <pod> -n "${NAMESPACE}"
kubectl describe nodes | grep -A8 -E "nvidia.com/gpu|Taints|Allocatable"
```

Next action: use the correct recipe for the available GPU SKU/count or adjust
scheduling constraints only if the recipe remains valid.

## DynamoGraphDeployment Or Operator

Signals:

- manifest applied but no pods appear
- `DynamoGraphDeployment` has reconcile errors
- CRD is missing

Checks:

```bash
kubectl get dynamographdeployment -n "${NAMESPACE}"
kubectl describe dynamographdeployment <name> -n "${NAMESPACE}"
kubectl get crd | grep -i dynamo
```

Next action: install/fix Dynamo Kubernetes Platform or repair invalid DGD YAML.

## Frontend Or Router

Signals:

- frontend pod ready but `/v1/models` empty or 503
- logs show no registered workers
- KV mode enabled but workers do not publish events

Checks:

```bash
kubectl logs <frontend-pod> -n "${NAMESPACE}" --tail=200
kubectl get svc -n "${NAMESPACE}" | grep frontend
```

Next action: verify workers are ready and registered. For KV smoke tests without
worker KV events, set `DYN_ROUTER_USE_KV_EVENTS=false`.

## Endpoint/API

Signals:

- port-forward succeeds but `/v1/models` fails
- chat completion fails while models list works

Checks:

```bash
curl http://127.0.0.1:8000/v1/models
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"<model>","messages":[{"role":"user","content":"hello"}],"max_tokens":16}'
```

Next action: check frontend and worker logs for request-time errors.

## Benchmark/Perf Job

Signals:

- endpoint smoke test passes but `perf.yaml` job fails
- benchmark cannot reach service
- benchmark uses wrong model name or URL

Checks:

```bash
kubectl get jobs -n "${NAMESPACE}"
kubectl logs job/<benchmark-job> -n "${NAMESPACE}" --tail=200
```

Next action: fix benchmark URL/model/concurrency only after the endpoint smoke
test passes.
