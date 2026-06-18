# Infrastructure Driver Notes

Setup the infrastructure needed to run NVIDIA physical AI synthetic data
generation (SDG) workflows.

## Infrastructure stack

This infrastructure skill covers the Kubernetes stack: OSMO for workflow
execution plus an inference provider of choice. Kubernetes deployment may be a
proper cluster like Azure Kubernetes Engine, or a single-node deployment like
MicroK8s. Docker-only workflows are out of scope for this infrastructure skill;
route those to the workload skill directly.

## Full stack component selection

Pick exactly one option per component. The sub-skill handles its own layer — this root only sequences them.

## 1. Kubernetes

| Option | Sub-skill | When |
|--------|-----------|------|
| MicroK8s | `../cluster-microk8s/reference.md` | Local dev, single-node CPU+NVCF or GPU+NIM |
| Azure | `../cluster-azure/reference.md` | Production, multi-node, managed |

## 2. Orchestration (OSMO)

Sub-skill is dictated by component selection in **1. Kubernetes**.

| Kubernetes Component | Sub-skill | When |
|--------|-----------|------|
| MicroK8s | `../osmo-k8s/reference.md` | MicroK8s cluster |
| Azure | `../osmo-azure/reference.md` | Azure AKS cluster |

Both OSMO install paths leave a persistent port-forward on `localhost:9000` — downstream skills (workload) rely on it and will not start their own.

OSMO storage is configured in-band by the upstream deploy script - all options run `deploy-osmo-minimal.sh` in the main OSMO repo which in turn runs `configure-storage.sh`.

## 3. Inference Provider

| Option | Sub-skill | When |
|--------|-----------|------|
| NIM Operator (in-cluster) | `../inference-nim-operator/reference.md` | GPU in cluster; low-latency/air-gapped |
| NVCF (pre-deployed cloud) | `../inference-nvcf/reference.md` | Cloud inference, no cluster GPU budget; needs `NVCF_API_KEY` |
| Azure AI Foundry (serverless) | `../inference-azure/reference.md` | Azure cluster, pay-per-token |
| None | — | Workflow does not need inference endpoints |

## 4. Workload

Any skill exposing an OSMO workflow YAML can be submitted via `osmo workflow submit`. OSMO workflow YAMLs are largely portable across environments, with exception to those that may specify an inference provider.

| Option | Skill | Notes |
|--------|-------|-------|
| Video Data Augmentation (VDA) | `skills/physical-ai-video-data-augmentation/SKILL.md` | End-to-end SDG: augmentation + auto-labeling |
| Defect Image Generation (AOI) | `skills/physical-ai-defect-image-generation/SKILL.md` | PCBA / metal / glass defect image generation: Day 0 from CAD (texture / good-image / structural-defect) or Day 1 from clean inspection images |
| NRE (Neural Reconstruction) | [`nre`](https://github.com/NVIDIA/nurec-skills/blob/main/.agents/skills/nre/SKILL.md) (canonical: `NVIDIA/nurec-skills`) | Train / render / export via NRE Docker CLI (covers 26.02 + 26.04) |
| NCore data conversion | [`ncore`](https://github.com/NVIDIA/nurec-skills/blob/main/.agents/skills/ncore/SKILL.md) (canonical: `NVIDIA/nurec-skills`) | Convert sensor datasets to NCore V4 |
| NuRec carline adaptation | `skills/carline-adaptation/SKILL.md` | Adapt USDZ reconstructions to new camera rigs |
| Asset Harvester | [`asset-harvester`](https://github.com/NVIDIA/nurec-skills/blob/main/.agents/skills/asset-harvester/SKILL.md) (canonical: `NVIDIA/nurec-skills`) | 3DGS asset extraction from NCore clips |
| Custom / external spec | any YAML path | `osmo workflow submit /abs/path/spec.yaml --pool <pool>` |

## Compatibility matrix

Not every option combines with every other — enforce these when picking:

| Cluster | NIM Operator | NVCF | AI Foundry |
|---------|--------------|------|------------|
| MicroK8s | ✅ | ✅ | ❌ (Foundry requires Azure identities) |
| Azure | ✅ | ✅ | ✅ |

# Deployment

## Component Dependencies

* **1. Kubernetes** is required and blocks everything else.
* **2. OSMO** and **3. Inference Provider** can be deployed in parallel once **1. Kubernetes** is deployed. Deploy these two in parallel; gate everything downstream on their readiness.
* **4. Workload**: Workload will specify the compute requirements, the OSMO workflow spec, and any inference endpoints it needs. Ensure the compute requirements are available in OSMO prior to submission, and any inference endpoints are reachable.

### Pipeline → inference requirement discovery

Over-deploying wastes GPUs and oversubscribes small pools. Derive the minimum set before running the inference stage:

1. Scan the chosen pipeline spec's `default-values` + task `args` for URL-shaped references:
   - `*.osmo-nims.svc.cluster.local` → NIMService of that name (NIM Operator)
   - `api.nvcf.nvidia.com/*` → NVCF function ID
   - `*.inference.ai.azure.com` / `*.cognitiveservices.azure.com` → Foundry endpoint
2. Pass the filtered set to the sub-skill: `NIM_SERVICES="<a> <b>"`, the matching `*_URL` / function ID envs (NVCF), or `install.sh --endpoint-name <name>` (Foundry).
3. If a required capability isn't in the chosen backend's catalog, STOP and surface — never substitute.

# Decision prompt

Prompt for stages 1, 3, and 4 (stage 2 resolves from Kubernetes choice):

1. Kubernetes: MicroK8s | Azure
2. OSMO: Resolves based on **1. Kubernetes**
3. Inference Provider: NIM Operator | NVCF | Azure AI Foundry
4. Workload: NuRec Carline Adaptation | Video Data Augmentation | Defect Image Generation | Custom spec (path)

Reject invalid cluster/inference pairs per the matrix. Custom spec → `osmo workflow submit <path>`.

# Prerequisites

Each sub-skill owns its own prerequisites. Before provisioning anything, read the Prerequisites section of the SELECTED components, enumerate every selected preflight, run them (Azure targets first run `components/azure-access/reference.md`), then compile a single implementation plan. Resolve everything up front - don't prompt the user mid-deploy. Derive what you can (caller IP for `allowed_cidr`, subscription ID from `az account show`); TF outputs are deploy-time inputs, not preflight inputs.

Preflight is before flight: no cluster API, Terraform outputs, Helm releases, OSMO pools, or workflow state are expected. Stage deploy/verify gates check those after resources exist.

Workflow submit/query requires `components/osmo-cli/reference.md`; run its `scripts/preflight.sh` with the resolved prerequisites.

Prior to provisioning Kubernetes, collect compute requirements from the SELECTED workload skill. Check these compute requirements against the SELECTED environment before proceeding.

Prompt the user only for values you truly can't derive such as API keys.

Secrets should be stored in `${REPO_ROOT}/.env`. Stage scripts source it via `${REPO_ROOT}/.env` where `REPO_ROOT` is this repo's root.

## Runtime Routing

If running under OpenClaw and any selected Azure stage needs `az` auth, read `../openclaw-azure-login/reference.md` before resolving Azure prerequisites.

## Verification gates (mandatory, per stage)

Each sub-skill has a Verify section — **run it to completion before moving to the next stage**.

| After stage | Must run + confirm |
|-------------|--------------------|
| 1. Kubernetes | `kubectl cluster-info`, all nodes Ready. GPU paths: GPU capacity advertised (`kubectl get nodes -o custom-columns=NAME:.metadata.name,GPU:'.status.allocatable.nvidia\.com/gpu'`). CPU+NVCF paths: `kubectl get runtimeclass nvidia -o jsonpath='{.handler}'` returns `runc`. |
| 2 Inference | Every endpoint YOUR pipeline references is reachable. NIM `/v1/health/ready` should return 200. NVCF preflight treats any HTTP response other than `000` as endpoint reachability, while authenticated worker calls must still satisfy the task-specific response check. Foundry endpoint reachable with `az cognitiveservices account keys list` credential. |
| 3 Orchestration | `helm status -n osmo-minimal osmo-minimal`, `kubectl get pods -n osmo-minimal`, `osmo pool list` default ONLINE, port-forward watchdogs up (`pgrep -f 'osmo-pf-watchdog:'`), OSMO storage configured (`osmo config show WORKFLOW`, `osmo config show DATASET`, `osmo credential list`) |
| 3 Smoke | The upstream deploy-osmo-minimal.sh runs `verify.sh` (verify-hello workflow) as its final step — verify-hello-N COMPLETED is the gate. CPU instances pass `SKIP_GPU=1` to the deploy script. Re-run via `"$OSMO_DIR/deployments/scripts/verify.sh"` (where `$OSMO_DIR=$HOME/.cache/physical-ai/osmo`). This catches backend-operator / storage mis-wires before any pipeline runs — do not skip. |
| 4 Workload | `osmo workflow query <id>` → `COMPLETED` with every task green. FAILED/CANCELLED/TERMINATED → `osmo workflow events` + `osmo workflow logs`, NOT "retry and hope". |

Failing gate → AGENTS.md rule 5 (Stop on red gate) + rule 4 (Config > Script > Skill).
