---
name: launch-nemo-rl
license: Apache-2.0
description: Playbook for launching, monitoring, stopping, and debugging NeMo-RL recipes on a Kubernetes cluster via the nrl-k8s CLI. Covers ephemeral vs long-lived RayCluster modes, iterating on runs, and debugging hung or failed training jobs.
when_to_use:
  - "run this recipe on k8s"
  - "launch on the cluster"
  - "submit a training job"
  - "tear down the cluster"
  - "resubmit as rayjob"
  - "why is the run stuck"
  - "how do I get logs for job X"
  - "bring the cluster back up"
allowed-tools: Bash Read Grep Glob Edit Write
---

# launch-nemo-rl — running NeMo-RL recipes on Kubernetes via nrl-k8s

This is the playbook for the `nrl-k8s` CLI at `infra/nrl_k8s/`. Follow it when the user asks to launch / iterate / debug a NeMo-RL recipe on a Kubernetes cluster. Verify current state (`kubectl`, `git log`, the recipe + infra files) before acting — the cluster is shared and the cost of a wrong action is high.

## 1. One command, two modes

There is a single top-level submission command: **`nrl-k8s run`**. It has two lifecycle modes.

| Mode               | Invocation        | When to use                                                                                                                                                                   | Cluster after? |
| :----------------- | :---------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------- |
| Ephemeral (default)  | `nrl-k8s run`              | One-shot. KubeRay applies a RayJob, runs, tears the cluster down. Best for most runs.                                                                                          | No (auto)      |
| Long-lived           | `nrl-k8s run --raycluster` | Dev loop. Reuses a matching live cluster, applies if absent, warns + reuses on drift (pass `--recreate` to replace). Then submits daemons and training. First-choice for iteration. | Yes            |

Ask: *Do I need this cluster after the run?* If yes, use `--raycluster`. Otherwise use the default (ephemeral).

The rest of the CLI is observability / stage-by-stage control:

| Command                 | Purpose                                                                                         |
| :---------------------- | :---------------------------------------------------------------------------------------------- |
| `nrl-k8s check`         | Validate a recipe + infra pair; optionally write the fully-resolved manifests (`-o`).           |
| `nrl-k8s status`        | Per-role RayCluster state, head pod phase, worker pod phases, daemon job status.                |
| `nrl-k8s cluster up/down/list/dashboard` | Manage RayClusters independently of a run (e.g. render a manifest with `--dry-run`). |
| `nrl-k8s job list/logs/stop` | Observability over Ray Jobs already submitted to a role's cluster.                         |
| `nrl-k8s logs`          | Tail a role's pod / daemon logs without needing a submission id.                                |

## 2. Recipe + infra pair

Every launch takes two files. Pass the infra with `--infra`, not merged inline:

```
nrl-k8s run infra/nrl_k8s/examples/<recipe>.yaml \
  --infra infra/nrl_k8s/examples/<recipe>.<profile>.infra.yaml
```

- **Recipe** (e.g. `qwen3_30b_math_8n_4gpu.yaml`) — NeMo-RL config: model, GRPO/SFT knobs, `cluster.{gpus_per_node,num_nodes}`. Uses `defaults:` to inherit from `examples/configs/recipes/llm/...`.
- **Infra** (e.g. `*.<profile>.infra.yaml`) — K8s/Ray shape: namespace, image, service account, RayCluster spec under `kuberay:`, optional Deployments under `deployments:`, `submit.submitter`, `launch.{mode,codeSource,codePath,entrypoint}`. Pair names follow `<recipe>.<profile>[.prod].infra.yaml` where `<profile>` names the hardware target (e.g. `gb300`).

Example pairs in `infra/nrl_k8s/examples/` — read the neighbouring files to see the current conventions for the target profile.

## 3. Long-lived mode flags

Three independent dimensions. `--mode` is a macro that picks defaults; individual flags override it.

```
--mode interactive   → --submitter portForward  --code-source upload  (tails logs)
--mode batch         → --submitter exec         --code-source image   (returns after nohup)
```

- **Submitter**: `portForward` uses `kubectl port-forward` + Ray Job SDK (gets a `submission_id` the dashboard tracks). `exec` uses `kubectl exec` + `nohup` on the head pod (no submission_id; driver appears as `type=DRIVER` in the dashboard).
- **Code source**: `upload` stages a working_dir from the laptop (Ray 100 MiB cap). `image` / `lustre` expect code on the pod's filesystem — paired with `--code-path` (typically `/opt/nemo-rl`), which is a subPath of the shared-filesystem PVC mount in the standard infra examples.
- **Wait**: `--wait` tails logs until terminal; `--no-wait` returns as soon as the driver is running.

Other long-lived-only flags:

- `--replace` — stop any running training / daemon job before submitting new ones (suffixes daemon submissionIds with a timestamp so Ray accepts the resubmit).
- `--recreate` — delete + re-apply a RayCluster whose live spec has drifted from the rendered manifest (default is warn + reuse).
- `--skip-daemons` — bring up all declared clusters but only submit training. Use on disagg recipes where gym/generation are already healthy.

Gotcha: on infra where the entrypoint does `cd /opt/nemo-rl` (or another in-image / Lustre path) and loads the recipe from there, **`--code-source upload` does NOT override the recipe on the pod** — the uploaded working_dir sits in `/tmp/ray/...` but the entrypoint `cd`s away from it. To actually test a local recipe change, either sync your edits to the shared filesystem mounted into the pods or flip the Hydra overrides in the entrypoint.

## 4. Ephemeral mode flags (`--rayjob`)

When `--rayjob` is set, `run` branches into the RayJob code path. Relevant flags:

- `--rayjob-name NAME` — RayJob metadata name (defaults to the training cluster name).
- `--shutdown / --no-shutdown` — default `true`: KubeRay deletes the RayCluster once the Ray Job reaches a terminal state.
- `--ttl SECONDS` — default 3600s: keep the RayJob object around after the run finishes for post-mortem log access.
- `--wait / --no-wait` — default `wait`: poll `jobDeploymentStatus` until Complete/Failed. `--no-wait` returns as soon as the RayJob is applied.
- `--timeout SECONDS` — default 86400s (24h): bound the `--wait` poll.
- `--dry-run` — render the RayJob manifest and print it; do not apply.

`--replace` / `--recreate` / `--skip-daemons` are silently ignored in `--rayjob` mode (KubeRay owns lifecycle).

## 5. Iterating on a config without touching the shared filesystem

When the recipe on the pod filesystem has the wrong value for your experiment, use Hydra overrides on the entrypoint instead of forking the recipe. Pattern:

```yaml
entrypoint: |
  set -eu
  cd /opt/nemo-rl
  RUN_ID="\${RAY_JOB_SUBMISSION_ID:-\${NRL_K8S_RUN_ID:-$(date -u +%Y%m%d-%H%M%S)}}"
  python -u examples/run_grpo.py \
    --config infra/nrl_k8s/examples/<recipe>.yaml \
    logger.wandb_enabled=true \
    logger.wandb.project=<project> \
    "logger.wandb.name=<run-name>-\${RUN_ID}"
```

**Escape `${…}`** with a backslash. OmegaConf otherwise interprets it as interpolation and errors on shell-style `${VAR:-default}`. `RUN_ID` resolves to `RAY_JOB_SUBMISSION_ID` (injected by KubeRay in rayjob mode) → `NRL_K8S_RUN_ID` (injected by the CLI in long-lived mode) → local timestamp — so the name is unique across either path.

## 6. Per-profile concerns (hardware + scheduler + DRA)

Every infra YAML encodes a hardware/scheduler profile. The concrete examples in `infra/nrl_k8s/examples/` are authoritative for the profiles they target — read the neighbouring infra file before writing a new one. Things that commonly vary:

- **Per-node GPUs** (e.g. 4 vs 8) — must match `cluster.gpus_per_node` in the recipe, otherwise workers stay `Pending`.
- **Node selectors** — head pods usually land on a CPU-only node pool; GPU workers match on `nvidia.com/gpu.product` or a node-group label.
- **Scheduler** — KAI (`schedulerName: kai-scheduler` + `kai.scheduler/queue` label) with topology annotations (`kai.scheduler/topology`, `kai.scheduler/topology-required-placement`) gang-schedules workers into one clique. Without it, pods may land on different racks and NVLink/RoCE won't span them.
- **DRA claims** — ComputeDomain + RoCE are attached via `resourceClaims` referencing `ResourceClaimTemplate`s. The CLI auto-creates/deletes these when the worker pod spec contains DRA claim references — no manual setup needed.
- **Secrets** — always via `secretKeyRef` (`wandb-api-key`, image pull secret). Never embed.
- **Shared filesystem mounts** — typically a Lustre PVC mounted twice: once at the code path (e.g. `/opt/nemo-rl` with a user-scoped `subPath`) and once at a workspace root (e.g. `/mnt/rl-workspace`) for datasets, HF cache, and checkpoints.

Before applying an infra, verify prereqs exist in the target namespace:

```bash
kubectl get pvc <workspace-pvc>
kubectl get secret <wandb-secret> <image-pull-secret>
kubectl get sa <service-account>
```

## 7. End-to-end workflows

### 7a. Fresh one-shot run (rayjob)
```bash
# From the NeMo-RL repo root:
nrl-k8s check <recipe> --infra <infra>                               # validate first
nrl-k8s run <recipe> --infra <infra> --rayjob --dry-run              # render RayJob manifest
nrl-k8s run <recipe> --infra <infra> --rayjob --no-wait              # apply, returns fast
```

Watch status + teardown (works even after your laptop disconnects because KubeRay owns the lifecycle):
```bash
kubectl get rayjob -n default <name> -w
kubectl get raycluster -n default                                    # empty = teardown succeeded
```

### 7b. Dev loop (long-lived)
```bash
nrl-k8s run <recipe> --infra <infra> --run-id $(date +%Y%m%d-%H%M%S)
# Edits in the recipe? Just re-run — reuses the live cluster.
# Pod spec changed? Add --recreate to delete + re-apply.
# Disagg recipe with gym/gen already healthy? --skip-daemons.
```

### 7c. First-time disaggregated bring-up
```bash
nrl-k8s run <recipe> --infra <disagg-infra> --mode batch --code-source image
```

### 7d. Cluster-only lifecycle
```bash
nrl-k8s cluster up   <recipe> --infra <infra> --target kuberay.training --wait
nrl-k8s cluster up   <recipe> --infra <infra> --target kuberay.training --dry-run   # render manifest
nrl-k8s cluster down <recipe> --infra <infra> --target kuberay.training --wait
nrl-k8s cluster down <recipe> --infra <infra>                                       # tear down all
nrl-k8s cluster list -n default
nrl-k8s cluster dashboard <cluster-name>                                  # port-forward + browser
```

### 7e. Deployments (e.g. nemo-skills sandbox)
```bash
# Bring up just the deployment
nrl-k8s cluster up <recipe> --infra <infra> --target deployments.nemo_skills
# Tear down just the deployment
nrl-k8s cluster down <recipe> --infra <infra> --target deployments.nemo_skills
# Tear down everything (RayClusters + Deployments)
nrl-k8s cluster down <recipe> --infra <infra>
```

The `deployments:` section in infra YAML declares Kubernetes Deployments managed alongside RayClusters. The CLI patches image, imagePullSecrets, and serviceAccountName from the top-level infra keys (same as RayClusters). Deployments start in parallel with cluster bring-up — no ordering dependency.

## 8. Monitoring a run

```bash
# Status
nrl-k8s status <recipe> --infra <infra>
kubectl get rayjob,raycluster -n default

# Follow the driver
nrl-k8s job list <recipe> --infra <infra> --role training
nrl-k8s job logs <run-id> <recipe> --infra <infra> --role training -f
```

When the `nrl-k8s job logs -f` subprocess dies (`kubectl port-forward` i/o timeout after ~15 min idle), just re-run it. The training job keeps going.

To fetch driver logs for a terminal job (SUCCEEDED/FAILED) or a RayJob via the dashboard API:
```bash
RC=$(kubectl get rayjob -n default <rayjob-name> -o jsonpath='{.status.rayClusterName}')
kubectl port-forward -n default svc/${RC}-head-svc 18266:8265 &
curl -s http://localhost:18266/api/jobs/                              # lists jobs, find submission_id
curl -s "http://localhost:18266/api/jobs/<submission_id>/logs"        # full driver log
```

`type=DRIVER` with `submission_id=null` means an exec-submitter run (no dashboard log endpoint — use `nrl-k8s job logs` instead). `type=SUBMISSION` has `submission_id` set and `/api/jobs/<id>/logs` works.

Wandb URL appears in the driver log on the first `wandb.init` call; grep `grep -oE 'https://wandb\.ai/[A-Za-z0-9_./-]+'`.

## 9. Stopping things

| What to stop                     | Command                                                                              |
| :------------------------------- | :----------------------------------------------------------------------------------- |
| One training run                 | `nrl-k8s job stop <run-id> <recipe> --infra <infra> --role training`                 |
| All running Ray jobs on a cluster (+ submit new) | `nrl-k8s run <recipe> --infra <infra> --replace`                         |
| A long-lived RayCluster          | `nrl-k8s cluster down <recipe> --infra <infra> --target kuberay.training --wait`     |
| A RayJob (ephemeral)             | `kubectl delete rayjob <name> -n default` — only if `shutdownAfterJobFinishes` didn't fire |

Confirm before deleting shared infra. The cost of `cluster down` on someone else's cluster is high.

## 10. Verifying RayJob teardown

After a `run --rayjob` completes with `--shutdown` (default), KubeRay should delete the RayCluster:

```bash
kubectl get rayjob   -n default <rayjob-name>                        # jobDeploymentStatus = Complete
kubectl get raycluster -n default | grep <rayjob-name>               # no output = torn down
```

The RayJob object itself sticks around for `--ttl` seconds (default 3600s) so you can still fetch logs.

## 11. Common gotchas

- **OmegaConf interpolation** eats `${VAR}` in recipe/infra YAML. Escape shell variables with `\${VAR}` so OmegaConf passes them through to the pod shell verbatim.
- **Megatron optimizer configs** don't carry `foreach` / `fused`. Overrides like `~policy.optimizer.kwargs.foreach ~policy.optimizer.kwargs.fused` (valid for DTensor configs) break on Megatron recipes. Omit them for Megatron.
- **DTensor vs Megatron** — MoE recipes typically use `megatron_cfg.enabled=true`; ensure `dtensor_cfg.enabled=false` in inherited defaults.
- **Shared filesystem vs git divergence** — `codeSource: image|lustre` reads from the pod filesystem. If your local edits aren't on the shared filesystem the pods mount, the run is testing the on-disk version, not yours. Either sync via a helper pod (head pod exec is often blocked) or override via Hydra flags.
- **Ephemeral-storage + readinessProbe** are injected by kuberay/CDI webhooks at pod-apply time. Do NOT add them to the inline RayCluster spec.
- **Node taints** vary per cluster. `tolerations: [{operator: Exists}]` on workers is defensive and worth keeping.
- **Dashboard blank page** — Ray 2.52 installs dashboard assets as symlinks by default; `nrl-k8s cluster dashboard <name>` auto-reinstalls `ray[default] --link-mode=copy` to fix it. Bake `ENV UV_LINK_MODE=copy` in the image to avoid this entirely.
- **`kubectl exec` is usually blocked** in automation — route around with `kubectl get ... -o yaml`, `kubectl logs`, and `kubectl port-forward` + Ray dashboard APIs.

## 12. Checklist before calling a run "done"

Before reporting a launch as successful, verify:

1. `kubectl get rayjob/raycluster -n default` shows the expected objects.
2. `nrl-k8s job list` (or `curl /api/jobs/`) shows the job in `RUNNING` / `SUCCEEDED`.
3. Driver log contains `wandb.ai/<project>/runs/<id>` (if wandb is enabled) — share the URL with the user.
4. At least one `Processed prompts: 100%` line appears (confirms generation is wired).
5. For `--rayjob` mode only: after `jobDeploymentStatus=Complete`, confirm `kubectl get raycluster | grep <name>` is empty (teardown worked).

## 13. Dev pod

`nrl-k8s dev` manages a lightweight CPU pod on the cluster for code syncing, debugging, and running `kubectl`/`nrl-k8s` from within the cluster.

```bash
# One-time: set up secrets (HF token, wandb, SSH key, rclone)
nrl-k8s dev setup-secrets --ssh-key ~/.ssh/id_rsa --add-rclone

# Create pod and exec in (idempotent — reuses existing pod)
nrl-k8s dev connect

# Switch image (must stop first — image change is warned but not auto-applied)
nrl-k8s dev stop
nrl-k8s dev connect --image nvcr.io/nvidian/nemo-rl:v0.7.0

# Tear down
nrl-k8s dev stop
```

The dev pod:
- Runs on a CPU-only node (anti-affinity to GPU nodes)
- Mounts the shared `rl-workspace` PVC at `/mnt/rl-workspace`
- Sets `USER` env var to the `nrl-k8s` username (so `$USER` and `getpass.getuser()` work correctly despite running as root)
- Installs `kubectl`, `rclone` (if configured) on first boot
- Injects SSH keys and tokens via `envFrom` on a per-user K8s Secret

The pod's `default` service account needs an `edit` RoleBinding in the namespace for `kubectl` to work inside. `dev connect` checks this and prints the required YAML if missing.

## 14. Where things live in the repo

- CLI code: `infra/nrl_k8s/src/nrl_k8s/` (`cli.py`, `orchestrate.py`, `manifest.py`, `rayjob.py`, `k8s.py`, `submitters/`, `schema.py`).
- Tests: `infra/nrl_k8s/tests/unit/` — run with `uv run --extra test pytest -x -q` from `infra/nrl_k8s/`.
- Recipe + infra examples: `infra/nrl_k8s/examples/`.
- Base recipes this tool wraps: `examples/configs/recipes/llm/…` and `examples/nemo_gym/…`.
