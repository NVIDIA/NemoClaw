# Kubernetes Recipe Workflow

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: CC-BY-4.0
-->

## Selection Rules

Use this order when multiple recipes match:

1. exact model, framework, deployment mode, and GPU type/count
2. exact model and framework, nearest deployment mode
3. same framework and topology with a similar model size
4. stop and ask before adapting an unrelated recipe

Treat recipes marked functional or experimental in `recipes/README.md` as usable
for bring-up but do not claim production performance unless the recipe includes
benchmark results.

## Common Commands

Set the namespace:

```bash
export NAMESPACE=dynamo-demo
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
```

Create the Hugging Face secret without printing the token:

```bash
kubectl create secret generic hf-token-secret \
  --from-literal=HF_TOKEN="${HF_TOKEN}" \
  -n "${NAMESPACE}" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Find storage classes:

```bash
kubectl get storageclass
```

Apply model cache:

```bash
kubectl apply -f recipes/<model>/model-cache/ -n "${NAMESPACE}"
kubectl logs -f job/model-download -n "${NAMESPACE}"
kubectl wait --for=condition=Complete job/model-download -n "${NAMESPACE}" --timeout=6000s
```

Apply deployment:

```bash
kubectl apply -f recipes/<model>/<framework>/<mode>/deploy.yaml -n "${NAMESPACE}"
kubectl get dynamographdeployment -n "${NAMESPACE}"
kubectl get pods -n "${NAMESPACE}" -o wide
```

Find frontend service:

```bash
kubectl get svc -n "${NAMESPACE}" | grep frontend
```

Smoke test:

```bash
kubectl port-forward svc/<frontend-service> 8000:8000 -n "${NAMESPACE}"
curl http://127.0.0.1:8000/v1/models
```

## Readiness Signals

Healthy path:

- model-download job completed
- model cache PVC is bound
- `DynamoGraphDeployment` exists and is not reporting reconciliation errors
- frontend and worker pods are `Running`
- containers are ready
- frontend service exists
- `/v1/models` returns at least one model
- `/v1/chat/completions` returns a completion

Do not move to benchmarking until the smoke test passes.

## Common Blockers

Storage:

- `storageClassName` does not exist
- PVC is pending
- model cache path is not mounted in worker

Auth:

- HF secret missing
- secret key name does not match manifest env var
- model license/access not accepted upstream

Images:

- image tag still uses a placeholder
- private registry pull secret missing
- backend image does not include required backend/runtime version

Scheduling:

- requested GPU count exceeds available nodes
- wrong GPU SKU for recipe
- node taints/tolerations missing

Routing:

- frontend has `DYN_ROUTER_MODE=kv` but workers are not ready
- KV events are expected but backend is not publishing them
- service forwards to frontend but no workers are registered
