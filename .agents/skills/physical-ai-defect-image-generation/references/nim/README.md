# Day 0 Image-Edit Endpoint


## Table of Contents

- [Option A: Existing Endpoint](#option-a-existing-endpoint)
- [Option B: Local Cluster Endpoint](#option-b-local-cluster-endpoint)
  - [Prerequisite: OSMO pool sizing](#prerequisite-osmo-pool-sizing)
  - [Deploy](#deploy)
- [Verify Endpoint Health Before Submitting Day 0](#verify-endpoint-health-before-submitting-day-0)
- [Why `vllm/vllm-omni` Runs Under NIMService](#why-vllmvllm-omni-runs-under-nimservice)

Day 0 calls the `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL` endpoint through
`image_edit_endpoint`; it does not own the endpoint lifecycle. **The model is
always `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL`** — the generic upstream
`qwen-image-edit` checkpoint is NOT a substitute (see "Why `vllm/vllm-omni`
Runs Under NIMService" below). Pick one endpoint source for that model before
submitting `texture_defect_generation_day0.yaml`.

## Option A: Existing Endpoint

Use any endpoint reachable from OSMO task pods that serves the image-edit model
through the `/v1` API:

```bash
osmo workflow submit assets/configs/texture_defect_generation_day0.yaml \
  --pool <pool> \
  --set name=texture_defect_gen_day0-$(cat /proc/sys/kernel/random/uuid | cut -c1-8) \
        dig_url_root=<dig_url_root> \
        image_edit_endpoint=https://<host>/v1 \
        image_edit_model=nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL
```

Use this path when the endpoint is already hosted, or when another team owns the
serving stack.

## Option B: Local Cluster Endpoint

> **Require the `physical-ai-infrastructure-setup-and-resilient-scaling` skill to
> stand up this endpoint.** Use it to (1) confirm the NIM Operator is installed
> and that `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL` is a supported model, and
> (2) deploy and manage the NIMService. **Never hand-roll
> a plain `vllm serve` Deployment** — without the operator's PVC it caches model
> weights to ephemeral storage and the pod is evicted (`ephemeral local storage
> usage exceeds the total limit`).

Use this path when the endpoint should run in the same Kubernetes cluster as
OSMO. The manifest in this directory mirrors the local Docker command:

### Prerequisite: OSMO pool sizing

The local NIM consumes 1 GPU in `osmo`; the DIG workflow needs ≥1 more from
the same OSMO pool. A pool with `Total Capacity < 2` cannot host both — the
NIM permanently occupies the only GPU and DIG tasks queue indefinitely.

Before `kubectl apply`, consult `skills/physical-ai-infrastructure-setup-and-resilient-scaling/SKILL.md` §"Check pool
resources" to read `Total Capacity` for the target pool (it documents
`osmo pool list` + column semantics). Proceed only when `Total Capacity >= 2`;
otherwise grow the pool or fall back to Option A.

### Deploy

Local equivalent (Docker) for reference:

```bash
docker run --rm -ti --gpus all \
  -e HF_TOKEN=xxx \
  vllm/vllm-omni:v0.20.0 \
  nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL --omni --port 8000
```

Apply the NIMService (NIM Operator must already be installed in the cluster — see `skills/physical-ai-infrastructure-setup-and-resilient-scaling/SKILL.md` for the operator install + lifecycle. The infra skill's `install.sh` already creates the `osmo-nims` namespace and the `ngc-api-secret` / `nvcr-pull-secret` / `hf-token-secret` there; the steps below only run those preconditions when applying this NIMService standalone):

```bash
kubectl create namespace osmo-nims --dry-run=client -o yaml | kubectl apply -f -
kubectl -n osmo-nims create secret generic hf-token-secret \
  --from-literal=HF_TOKEN="${HF_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f references/nim/qwen-image-edit-nvpcb-ovsl2sl.yaml
kubectl -n osmo-nims wait --for=condition=Ready \
  nimservice.apps.nvidia.com/qwen-image-edit-nvpcb-ovsl2sl --timeout=60m
```

Use the in-cluster service DNS as the Day 0 endpoint:

```bash
osmo workflow submit assets/configs/texture_defect_generation_day0.yaml \
  --pool <pool> \
  --set name=texture_defect_gen_day0-$(cat /proc/sys/kernel/random/uuid | cut -c1-8) \
        dig_url_root=<dig_url_root> \
        image_edit_endpoint=http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1 \
        image_edit_model=nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL
```

Verify the endpoint from inside the cluster:

```bash
kubectl run curl -n osmo-nims --rm -i --restart=Never \
  --image=curlimages/curl -- \
  curl -sS http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1/models
```

## Verify Endpoint Health Before Submitting Day 0

The Day 0 `image-edit` task fails immediately if the endpoint is in
`CrashLoopBackOff` or not yet `Ready`. Always confirm the deployment is
healthy first; otherwise OSMO wastes a full `usd2roi-render` run before
failing on `image-edit`. Two quick checks to run before every Day 0 submit:

```bash
# 1. NIMService + pod state — expect Ready condition True, pod 1/1 no recent restarts
kubectl -n osmo-nims get nimservice,deploy,po -l app.kubernetes.io/name=qwen-image-edit-nvpcb-ovsl2sl

# 2. /v1/models reachable AND serves the expected model id
kubectl run curl -n osmo-nims --rm -i --restart=Never \
  --image=curlimages/curl -- \
  curl -fsS http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1/models \
  | grep -q 'nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL' && echo OK || echo NOT_READY
```

Proceed with `osmo workflow submit assets/configs/texture_defect_generation_day0.yaml ...`
only when both report healthy. If the pod is `CrashLoopBackOff` with
`OSError: [Errno 28] No space left on device` in `kubectl logs --previous`,
confirm the manifest still sets `spec.storage.sharedMemorySizeLimit: 32Gi` —
NIM Operator translates that into an `emptyDir{medium:Memory}` mounted at
`/dev/shm`, and the default container `/dev/shm` is too small for vLLM-omni's
multi-proc executor.

## Why `vllm/vllm-omni` Runs Under NIMService

**Every DIG workflow REQUIRES the `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL`
finetuned checkpoint.** The generic upstream Qwen-Image-Edit NIM
(`qwen/qwen-image-edit-2511` or any other generic variant) is **NOT** an
acceptable substitute under any circumstance — not as a fallback, not for
"smoke testing", not because the finetuned image is harder to deploy. The
NVPCB OVSL2SL checkpoint was finetuned on the OV→SL appearance distribution
that downstream AnomalyGen finetune + inference were trained against;
substituting the generic checkpoint produces augmented ROIs outside that
distribution and causes **silent quality regressions** (the workflow appears
to succeed; the labels are degraded). If the agent cannot deploy
`nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL` for any reason, **stop and surface the
blocker to the user** — do not fall back to a generic NIM.

This endpoint uses `vllm/vllm-omni:v0.20.0` rather than an official NGC NIM
image. NIMService's generic `spec.command` / `spec.args` fields run the
`vllm serve nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL --omni` invocation directly
while the operator still manages PVC, probes, service, and lifecycle.
NIM Operator mounts `spec.storage.pvc` at `/model-store` and auto-sets
`NIM_CACHE_PATH=/model-store`; the manifest sets `HF_HOME=/model-store/huggingface`
so model weights persist on the PVC across pod restarts. `authSecret` is
required by the NIMService schema even though the vLLM container ignores
`NGC_API_KEY` — model access comes from `HF_TOKEN` instead.

Reference: NVIDIA NIM Operator `NIMService` configuration:
https://docs.nvidia.com/nim-operator/latest/service.html
