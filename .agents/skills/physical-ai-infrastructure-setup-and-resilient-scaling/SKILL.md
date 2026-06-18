---
name: physical-ai-infrastructure-setup-and-resilient-scaling
description: >-
  Use when the user wants to set up, scale, validate, or harden NVIDIA
  physical AI infrastructure for synthetic data generation workflows across
  local MicroK8s or Azure AKS, including Kubernetes clusters, inference endpoint
  deployment, OSMO deployment, workload submission readiness, and infrastructure
  failure recovery. Trigger keywords: physical ai infrastructure, resilient
  scaling, SDG infrastructure, microk8s, azure aks, NVCF deployment,
  NIM Operator, OSMO deploy, workflow scaling. Don't trigger for: OSMO log
  summarization or workload-only operations unless infrastructure setup, scaling,
  validation, or recovery is requested.
license: Apache-2.0
version: "1.0.0"
tools:
  - Read
  - Shell
compatibility: >-
  Requires the selected component prerequisites, usually kubectl plus either
  MicroK8s or Azure CLI/Terraform, and OSMO or inference credentials for the
  chosen target.
metadata:
  author: NVIDIA Physical AI
  tags:
    - physical-ai
    - infrastructure
    - kubernetes
    - azure
    - microk8s
    - osmo
    - nim-operator
    - scaling
  domain: ai-ml
  languages:
    - bash
    - hcl
    - yaml
---

# Physical AI Infrastructure Setup And Resilient Scaling

Canonical skill for the Physical AI infrastructure stack. Use it to compose cluster,
inference, OSMO, and workload stages into a reproducible Physical AI SDG
environment, then keep the environment observable and recoverable.

## Operating Rules

- Read only the component references needed for the selected target. Do not
  load every component by default.
- Keep the repo as the durable artifact. Fix checked-in config or scripts, then
  rerun. Do not recover a failed install with untracked one-off changes.
- Run mutating cluster, OSMO, Helm, Terraform, or Azure operations through
  checked-in scripts when a script exists. Read-only diagnostics are allowed.
- Stop at the first red gate. Fix the lowest owning layer in this order:
  config, script, then skill guidance.
- Derive values from the environment when possible. Ask only for values that
  cannot be inferred, such as API keys, target choice, or quota tradeoffs.
- Store secrets in `${REPO_ROOT}/.env`. Cluster-derived values such as storage,
  database, Redis, and endpoint names come from Terraform outputs or platform
  queries, not `.env`.
- Preflight means no deployed state: no cluster API, Terraform outputs, Helm
  releases, OSMO pools, or workflow state. Those belong to deploy/verify gates.
- Never print, echo, or paste raw keys into commands, YAML, logs, or
  transcripts. Prefer credential handles, Kubernetes `secretKeyRef`, and
  runtime-only secret injection. Scan raw transcript exports with
  `scripts/scan_transcript_secrets.py` before sharing.
- Use absolute paths. Derive repo root with `git rev-parse --show-toplevel`.

## Component References

Each component lives inside this skill so the stack has one canonical trigger.
Load the component reference only when the selected target needs that slice.

| Concern | Load | Assets |
| --- | --- | --- |
| Stage matrix and old driver notes | `components/driver/reference.md` | None |
| MicroK8s cluster | `components/cluster-microk8s/reference.md` | `components/cluster-microk8s/scripts/`, `components/cluster-microk8s/runtimeclass-nvidia-runc.yaml` |
| Azure AKS cluster | `components/cluster-azure/reference.md` | `components/cluster-azure/scripts/`, `components/cluster-azure/terraform/` |
| NIM Operator inference | `components/inference-nim-operator/reference.md` | `components/inference-nim-operator/scripts/`, `components/inference-nim-operator/nims/` |
| NVCF inference | `components/inference-nvcf/reference.md` | `components/inference-nvcf/scripts/` |
| Azure AI Foundry inference | `components/inference-azure/reference.md` | `components/inference-azure/scripts/` |
| MicroK8s OSMO | `components/osmo-k8s/reference.md` | `components/osmo-k8s/scripts/`, upstream OSMO deploy scripts |
| Azure OSMO | `components/osmo-azure/reference.md` | `components/osmo-azure/scripts/`, upstream OSMO deploy scripts plus Azure TF outputs |
| Azure access setup | `components/azure-access/reference.md` | None |
| OSMO CLI and workflow operations | `components/osmo-cli/reference.md` | `components/osmo-cli/scripts/`, `components/osmo-cli/references/`, `components/osmo-cli/agents/`, `components/osmo-cli/tests/` |
| OpenClaw Azure device login | `components/openclaw-azure-login/reference.md` | None |

### OSMO CLI Support Files

The OSMO CLI component has second-level support files because its command and
workflow surface is large. Load these directly only for the stated case.

| File | Read when |
| --- | --- |
| `components/osmo-cli/agents/workflow-expert.md` | Spawning a workflow-generation or workflow-failure subagent. |
| `components/osmo-cli/agents/logs-reader.md` | Spawning a log summarization subagent for OSMO workflow failures. |
| `components/osmo-cli/references/cli-commands.md` | Exact OSMO CLI flags, payloads, or command syntax are needed. |
| `components/osmo-cli/references/workflow-spec.md` | Workflow YAML schema, credentials, outputs, or provider fields are needed. |
| `components/osmo-cli/references/workflow-patterns.md` | Multi-task, data dependency, Jinja, serial, or parallel workflow design is needed. |
| `components/osmo-cli/references/advanced-patterns.md` | Checkpointing, retry/exit behavior, or node exclusion is needed. |
| `components/osmo-cli/tests/orchestrator-runtime-failure.md` | Validating or debugging the OSMO orchestration review pattern. |

## Target Selection

Pick exactly one option per stage. Stage 2 follows stage 1.

1. Kubernetes: `MicroK8s` or `Azure`
2. OSMO: `MicroK8s OSMO` when Kubernetes is MicroK8s, `Azure OSMO` when
   Kubernetes is Azure
3. Inference: `NIM Operator`, `NVCF`, `Azure AI Foundry`, or `None`
4. Workload: Video Data Augmentation, Defect Image Generation, NuRec Carline
   Adaptation, NRE, NCore, Asset Harvester, or custom workflow YAML

Reject invalid combinations before provisioning:

| Cluster | NIM Operator | NVCF | Azure AI Foundry |
| --- | --- | --- | --- |
| MicroK8s | yes | yes | no, Foundry requires Azure identities |
| Azure | yes | yes | yes |

For OpenClaw or any chat-only environment that cannot open a browser, read
`components/openclaw-azure-login/reference.md` before Azure prerequisites.
For any Azure target, read `components/azure-access/reference.md` before Azure
component preflights.

## Setup Flow

1. Confirm target choices and workload compute requirements.
2. Load the selected component references.
3. Resolve prerequisites up front, including API keys, Azure access, caller
   CIDR, GPU quota, storage class, and OSMO login requirements.
4. Run `scripts/preflight.sh` for every selected infrastructure component plus
   any OSMO CLI/workload preflight before provisioning; build the implementation
   plan from the results and stop on red preflight.
5. Deploy Kubernetes first. Nothing else starts until the cluster gate is green.
6. Deploy OSMO and inference after Kubernetes. These can proceed in parallel
   once the cluster exists, but workload submission waits for both selected
   gates.
7. Submit the workload only after OSMO, storage credentials, compute pool, and
   selected inference endpoints are verified. For VDA, this includes
   `preflight_credentials.sh`, `pre_submit_guard.py` with resolved `--set`
   values, non-empty model-cache prefixes, and workflow-namespace endpoint
   smoke checks.
8. Monitor through completion. On failed workflow state, inspect events and logs
   from `components/osmo-cli/reference.md`; do not resubmit blindly.

## Inference Discovery

Avoid over-deploying expensive endpoints.

1. Scan the chosen workflow spec and default values for endpoint references:
   `*.osmo-nims.svc.cluster.local`, `api.nvcf.nvidia.com/*`,
   `*.inference.ai.azure.com`, or `*.cognitiveservices.azure.com`.
2. Map each reference to the selected backend:
   - NIM Operator: service name must match a directory under
     `components/inference-nim-operator/nims/`.
   - NVCF: function URL or function ID must be supplied by the environment.
   - Azure AI Foundry: endpoint name must be deployed through
     `components/inference-azure/scripts/install.sh`.
3. If the workflow needs a capability the selected backend lacks, stop and
   report the mismatch. Do not silently substitute another model.

## Verification Gates

Each stage has its own Verify section in the component reference. These gates
are mandatory:

| Stage | Gate |
| --- | --- |
| Kubernetes | Cluster API reachable, nodes Ready, GPU capacity advertised for GPU paths, and CPU+NVCF paths have `runtimeclass/nvidia` mapped to `runc`. |
| Inference | Every endpoint referenced by the workload is reachable. NIM readiness uses `/v1/health/ready`; NVCF and Foundry still need task-specific authenticated checks. |
| OSMO | OSMO pods Ready, pool ONLINE, port-forward watchdogs alive, storage credentials configured, and verify-hello workflow COMPLETED. |
| Workload | Selected workload pre-submit guards pass before submit. `osmo workflow query <id>` reports `COMPLETED` and every task is green. Failed terminal states require events and logs before retry. |

## Resilient Scaling

- Size the cluster from workload needs before provisioning. For Azure, check CPU
  and GPU quota for the selected VM families before `terraform apply`.
- For NIM Operator, deploy only the NIMServices referenced by the workload.
  Each service pins GPU and model-cache storage for the lifetime of the cluster.
- Keep OSMO storage URL schemes aligned with the active backend. Local MicroK8s
  uses MinIO, Azure uses Blob-backed configuration.
- Treat Pending, Unknown, ImagePullBackOff, unbound PVCs, or 0 Ready replicas as
  layer failures. Investigate scheduling, storage, image credentials, and
  adjacent platform state before retrying the same command.
- For long deploys or workflow watches, provide heartbeat updates with current
  state, elapsed time, last useful observation, and next check.

## Workload Routing

- Video Data Augmentation: use `skills/physical-ai-video-data-augmentation/SKILL.md`.
- Defect Image Generation: use `skills/physical-ai-defect-image-generation/SKILL.md`.
- NuRec carline adaptation: use `skills/carline-adaptation/SKILL.md`.
- NRE, NCore, and Asset Harvester live in the canonical NuRec catalog listed in
  `skills/INDEX.md`.
- Custom workload: submit the provided workflow YAML through OSMO after checking
  resource requests, image credentials, data credentials, and inference URLs.

## Evaluation Prompts And Results

- Positive trigger: "Set up resilient Physical AI infrastructure for VDA on
  Azure AKS with NIM Operator."
  Expected: use this skill.
- Negative trigger: "Summarize recent OSMO workflow logs for this workflow ID."
  Expected: do not use this infrastructure setup skill unless the request also
  involves setup, scaling, validation, or recovery of the infrastructure stack.

Latest static review: 2026-05-26, description keywords match the expected
routes above.
