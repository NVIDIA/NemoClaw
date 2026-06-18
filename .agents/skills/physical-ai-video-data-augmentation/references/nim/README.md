# VDA VLM/LLM Endpoints


## Table of Contents

- [Option A: Reuse Existing In-Cluster NIMs (default)](#option-a-reuse-existing-in-cluster-nims-default)
- [Option B: Deploy/Repair In-Cluster NIMs](#option-b-deployrepair-in-cluster-nims)
- [Verify Endpoint Health Before Submitting](#verify-endpoint-health-before-submitting)
- [Option C: External Endpoint Override (opt-in only)](#option-c-external-endpoint-override-opt-in-only)

VDA workers call OpenAI-compatible VLM/LLM endpoints via `vlm_url` and `llm_url`.
Default behavior is in-cluster persistent NIM reuse.

## Option A: Reuse Existing In-Cluster NIMs (default)

Default endpoint values in VDA workflow YAMLs:

```text
vlm_url=http://qwen3-vl.osmo-nims.svc.cluster.local:8000/v1
llm_url=http://qwen25-14b.osmo-nims.svc.cluster.local:8000/v1
```

Use these unless the user explicitly requests external mode or provides explicit
URLs.

## Option B: Deploy/Repair In-Cluster NIMs

This is the default action when either endpoint is missing/unhealthy — deploy
automatically as a prerequisite; do not pause for user confirmation:

```bash
export NIM_SERVICES="qwen3-vl qwen25-14b"
skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/inference-nim-operator/scripts/install.sh
```

Rules:

- Keep the allow-list fixed to VDA-required services only.
- Do not deploy unrelated services.
- Never scale down or delete existing NIM deployments to free GPUs.

## Verify Endpoint Health Before Submitting

Check deployments and model APIs:

```bash
kubectl -n osmo-nims get deploy,po -l 'app.kubernetes.io/name in (qwen3-vl,qwen25-14b)'

kubectl run curl-vlm -n osmo-nims --rm -i --restart=Never \
  --image=curlimages/curl -- \
  curl -fsS http://qwen3-vl.osmo-nims.svc.cluster.local:8000/v1/models

kubectl run curl-llm -n osmo-nims --rm -i --restart=Never \
  --image=curlimages/curl -- \
  curl -fsS http://qwen25-14b.osmo-nims.svc.cluster.local:8000/v1/models
```

Proceed only when both endpoints return healthy model lists.

## Option C: External Endpoint Override (opt-in only)

Use external endpoints only when user explicitly asks, or provides explicit URLs:

```bash
--set-string vlm_url=https://<provider>/v1 llm_url=https://<provider>/v1
```

Worker scripts normalize OpenAI-compatible paths and run bounded readiness
checks; they support in-cluster NIM, NVCF-style invoke endpoints, and other
OpenAI-compatible providers.
