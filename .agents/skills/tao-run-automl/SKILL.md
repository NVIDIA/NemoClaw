---
name: tao-run-automl
description: Run AutoML / hyperparameter optimization (HPO) for NVIDIA TAO networks using AutoMLRunner. Handles algorithm
  selection (bayesian, hyperband, asha, bohb, llm, hybrid, autoresearch), WandB experiment tracking, job execution on any TAO SDK
  platform, result interpretation, and per-rec custom evaluation hooks. Use when the user mentions TAO AutoML, hyperparameter
  optimization, HPO, automl, automl_settings, AutoMLRunner, tao_automl, bayesian search, hyperband, ASHA, LLM-guided search,
  autoresearch, or wants to tune training hyperparameters for any TAO network. Platform-agnostic — runs on any SDK (Lepton, Brev,
  SLURM, Kubernetes, Docker).
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit. Workflows declare additional requirements.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash Write
tags:
- automl
- hpo
- workflow
- training
- optimization
- llm
---

# TAO AutoML Skill

Run automated hyperparameter optimization (HPO) for any TAO network. The agent uses `AutoMLRunner` — a single interface that manages the full loop: generate recommendations, launch training jobs, extract metrics, and feed results back to the optimizer.

The runner is **platform-agnostic** — it takes any object implementing the standard SDK shape (`create_job`, `get_job_status`, `get_job_logs`, `get_failure_analysis`) and calls those methods. Pick whichever SDK matches where you want jobs to run:

| SDK | Best for AutoML |
|---|---|
| `LeptonSDK` | Multi-node sweeps on DGX Cloud; managed scheduling |
| `BrevSDK` | Cost-tuned sweeps on Brev instances (single-instance per rec, multi-GPU OK). Multi-credential / multi-workspace accounts must pass `cloud_cred_id=` and `workspace_group_id=` to `create_job` — see `skills/platform/tao-run-on-brev/SKILL.md`. |
| `SlurmSDK` | Large sweeps on shared HPC clusters with queue/quota |
| `KubernetesSDK` | Sweeps on EKS / GKE / AKS / on-prem clusters with the NVIDIA GPU Operator |
| `DockerSDK` | Local debugging or single-host sweeps |

Multi-node per rec works on Lepton, SLURM, and K8s (each rec is an N-node distributed training job). Brev and local Docker are single-host per rec — multi-GPU within one host still works (`gpu_count > 1`), but one rec can't span multiple hosts.

**Workflow:** (1) parse user intent + preflight, (2) select algorithm, (3) configure and run, (4) monitor/resume/query status, (5) interpret results. Each step below links the reference holding its full detail. Failure modes: `references/pitfalls.md`. Example exchanges: `references/examples.md`. Setup detail: `references/prerequisites.md`.

## Preflight

This skill needs `nvidia-tao-automl` (which pulls `nvidia-tao-sdk` transitively). Both are on public PyPI; pinned versions live in `versions.yaml` (`wheels.tao_automl_*`), resolved via `scripts/resolve_versions_key.py`. Pick the platform extra you want:

```bash
python -c "import tao_automl" 2>/dev/null || {
  SB="${TAO_SKILL_BANK_PATH:?}"
  echo "MISSING: nvidia-tao-automl not installed. Pick the platform extra you need:"
  echo "  pip install \"$($SB/scripts/resolve_versions_key.py wheels.tao_automl_lepton)\"      # DGX Cloud / Lepton"
  echo "  pip install \"$($SB/scripts/resolve_versions_key.py wheels.tao_automl_slurm)\"       # on-prem SLURM cluster"
  echo "  pip install \"$($SB/scripts/resolve_versions_key.py wheels.tao_automl_kubernetes)\"  # K8s (EKS / GKE / on-prem)"
  echo "  pip install \"$($SB/scripts/resolve_versions_key.py wheels.tao_automl_docker)\"      # local Docker daemon"
  echo "  pip install \"$($SB/scripts/resolve_versions_key.py wheels.tao_automl_brev)\"        # Brev GPU instances"
  echo "  pip install \"$($SB/scripts/resolve_versions_key.py wheels.tao_automl_all)\"         # all 5 platforms"
  echo "  (append ,llm or ,wandb to the extra for agentic-search or experiment-tracking deps)"
  exit 1
}
```

(Local development against a checkout: `pip install -e '~/tao-run-automl[lepton]'`.) If missing, the agent prompts the user to authorize the install via Bash, then re-runs the preflight before continuing.

## Prerequisites

Before running AutoML, satisfy all of these — the full detail (per-platform credential filtering, dataset URI formats, the bank-structure tree, and the install commands) is in `references/prerequisites.md`:

1. **Shared launch preflight** — run the `tao-launch-workflow` intake pattern first. AutoML must not create runner files, workspaces, state files, logs, compatibility shims, or install dependencies until the selected platform's credentials, access check, dataset visibility, model credentials, container image confirmation, and compute shape are satisfied. This prevents wasting the budget on fake recommendation failures caused by SSH, storage, image, or credential setup.
2. **SDK credentials** — env vars sourced from `~/.config/tao/.env` (auto-loaded by the skill bank's SessionStart hook). Filter required vars per platform with `scripts/list_tao_platforms.py --platform <platform> --format text` and ask only for what it lists (S3 only when URIs use `s3://`; `NGC_KEY` for container pulls). The agent never reads values — only checks presence with `[ -n "$VAR_NAME" ]`. Construct the SDK with no arguments, e.g. `LeptonSDK()`.
3. **Dataset** — accessible from the compute backend; URI format depends on the platform (`s3://...` for Lepton, an absolute shared path for SLURM, `azure://...` for Azure, a local path for Docker; never generate `aws://...`). Accept dataset roots or exact spec-key paths, preserving user-supplied keys such as `custom.train_dataset.annotation_path=` without forcing files to share a parent directory.
4. **Skill bank available** — the runner takes an explicit `skill_dir` (absolute path to `<bank-root>/models/<network>`, no env-var fallback). Use the same bank root the agent loaded the workflow from. **CRITICAL**: AutoML requires a packaged, valid `<bank-root>/models/<network>/schemas/train.schema.json` — it is the AutoML support gate (defines `automl_enabled` params, defaults, ranges, options, weights, popular metadata). The runtime must not expect `~/tao-core` to exist; if the packaged train schema is missing, do not run AutoML for that model. `references/spec_template_<action>.yaml` is required for non-TAO-Core models (cosmos-rl, clip) and optional for TAO Core / Hydra-based models (DINO, BEVFusion).
5. **`nvidia-tao-automl` installed** with the platform extra you want (public PyPI; pin in `versions.yaml`). Use the install commands from the Preflight block above or `references/prerequisites.md`; append `,llm` to the extra for agentic algorithms.

Verify setup:
```bash
python3 -c "from tao_automl.runner import AutoMLRunner; print('OK')"
python3 -c "from tao_automl.brain.llm_brain import LLMBrain; print('LLM OK')"   # optional, LLM features
python3 -c "import wandb; print('WandB OK')"                                    # optional, WandB
```

---

## Concepts: What is TAO AutoML?

TAO AutoML automates the "try different hyperparameter values → train → compare results → repeat" cycle. You tell it **what network** (`network_arch`), **which hyperparameters** to search (from the model skill and schema), **what metric** to optimize (from the model skill or user request), and **how many trials** (budget). It then picks hyperparameter values with a search algorithm (Bayesian, Hyperband, LLM, etc.), launches a real training job on whichever backend the SDK targets, reads the result metric from training logs, feeds it back so the algorithm learns what works, repeats until budget is exhausted, and returns the best configuration found.

Each "trial" is called a **recommendation** (rec). One rec = one full training run with a specific set of hyperparameters.

---

## Quick Support Queries

When the user asks what models/networks are supported for AutoML, run the packaged model-list helper in AutoML mode. AutoML enablement is **model-level** metadata (`skills/models/<network>/references/skill_info.yaml` has `automl_enabled: true`), not workflow-level. The helper reads that metadata, then validates whether the model also has a packaged, parseable train dataclass schema:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_models.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} --scope automl --format text
```

The compatibility wrapper below is also valid and delegates to the same logic:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_automl_support.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} --format text
```

Return both sections from that output: runnable AutoML models and AutoML-enabled models still blocked on schema packaging. The support rule: AutoML is enabled at model level; runnable AutoML also requires `skills/models/<network>/schemas/train.schema.json` to be packaged and valid.

---

## Step 1: Parse User Intent

Default to a quick-start run unless the user explicitly asks to customize AutoML or agrees to a customization offer. Do not present algorithm, budget, or search-space choices as required inputs for a normal "run AutoML" request.

Any workflow/application that reaches a train-capable model skill must consult the selected model's `automl_enabled` metadata. If it is `true`, use this AutoML workflow as the default training path unless the run/workflow setting has `automl_policy: off` or the user explicitly asks for a plain single training run. This keeps AutoML enablement scalable across tao-train-single-step, DEFT, and future workflows without duplicating allowlists in each application skill.

Extract the default-run inputs and apply the quick-start defaults. The full required-field table (`network_arch`, `platform`, dataset URIs / direct spec paths, `image`, `metric`, `direction`, `skill_dir`, `long_running_enabled`, `status_interval_minutes`, credentials, compute shape, and the LLM endpoint/model/key trio), the quick-start defaults (`bayesian`, `10` recs, `None` hyperparameters/ranges, `5`-minute monitoring), the friendly launch-intake prompting checklist, the customization-only fields, the quick-start runner shape, and metric-choice best practices all live in `references/intake-and-inputs.md`.

Key gating policy that always applies:

- If any required field is missing, ask the user. Do NOT guess dataset paths, skill bank paths, credentials, or hardware that the model skill marks as required.
- `image`: resolve the default, show it to the user, and require confirmation or `image=<override>` before creating the AutoML runner.
- `direction`: only needed when the metric name disagrees with the implicit "contains 'loss' → minimize, else maximize" rule.
- `llm_endpoint`, `llm_model`, `llm_api_key`: **MUST prompt** for `llm`/`hybrid`/`autoresearch`; the code default `https://integrate.api.nvidia.com/v1` returns 404, so always pass `llm_endpoint` explicitly.

Before generating an AutoML script, verify platform access and dataset visibility using the shared launch preflight. For SLURM, that means passwordless SSH to at least one login host and remote `test -e` checks for each required annotation/media path. Verify container image confirmation the same way — the confirmed train image must be passed into `AutoMLRunner.run(..., image=chosen_image, ...)` or the SDK adapter's `create_job(..., image=chosen_image, ...)`; do not rely on an implicit default. Also run any model-specific annotation content checks documented by the model skill. If preflight fails, stop with remediation steps instead of creating a runner that will immediately fail. Missing required annotation fields are a preflight failure, not an AutoML recommendation failure.

**Customization gate:** After the required quick-start fields are resolved, you may briefly offer customization. If the user declines, proceed with the defaults. If the user chooses customization, present the customization-only fields from `references/intake-and-inputs.md`.

**MANDATORY: Read the generated dataclass schema before configuring AutoML.** For the selected model/action, read `${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/models/<network>/schemas/train.schema.json` and `.../schemas/manifest.json`. AutoML can run only when `train.schema.json` is packaged and valid. Do not fall back to hand-written notes, old runner scripts, or a local `~/tao-core` checkout. If the schema is missing, stop and report that AutoML is enabled but not runnable until the schema is generated and shipped. Use the schema JSON as the source of truth for `automl_default_parameters`, `automl_disabled_parameters`, per-parameter defaults, ranges, enums, `option_weights`, `math_cond`, `depends_on`, `parent_param`, and `popular`. When `automl_hyperparameters=None`, the runner discovers all params marked `automl_enabled=True` in the schema; each network has its own set, so never hardcode them here.

**The following MANDATORY rules gate every run** — full text, code patterns, and rationale in `references/mandatory-rules.md`:

- **MANDATORY prompting for LLM-based algorithms** (`llm`, `hybrid`, `autoresearch`) — resolve `llm_endpoint`, `llm_model`, and `llm_api_key` before generating the script (precedence chains in the reference). Without valid LLM settings the brain silently falls back to random sampling and wastes GPU budget.
- **MANDATORY: Read the model skill before generating the script** — read `<bank-root>/models/<network>/SKILL.md` and apply its **Training Requirements**, **Per-Action Dataset Requirements**, **Typical Spec Overrides**, **AutoML / HPO Notes**, and **Error Patterns**. Do not hardcode model-specific knowledge.
- **MANDATORY: No model-specific constants in this AutoML skill** — hyperparameter names, ranges, defaults, metric names, dataset layouts, spec override keys, images, and metric regexes belong in the schema and model skill, not here.
- **MANDATORY: Timestamped workspace folders** — always suffix `workspace_path` with `datetime.now().strftime("%Y%m%d_%H%M%S")`; never use a flat path.
- **MANDATORY: Fresh runner per new AutoML request, after preflight passes** — every new request creates a new runner script, log, PID file, SDK `state_file`, and `workspace_path` with a unique timestamp; only resume when the user explicitly asks to resume/continue/recover/inspect.

**Best-practice on metric choice:** prefer the model skill's recommended validation or task metric over cheap training loss (which overfits on small fine-tuning sets); when using a validation proxy, also apply the model skill's required validation-related `spec_overrides` so the metric is emitted; a real task metric via `eval_fn` is most honest but adds per-rec cost. Details in `references/intake-and-inputs.md`.

---

## Step 2: Select Algorithm

Default to `bayesian`. The full classical and LLM/agentic algorithm tables (use-when, typical budget, how it works), the default/caveat rules, and the decision tree are in `references/algorithms.md`. Present the algorithm guide only in customization mode or when the user names one.

---

## Step 3: Configure and Run

Build the runner from the generic shapes in `references/automl-settings.md` — minimal example, full all-options example, LLM-powered example, the programmatic `AutoML` API, the complete `automl_settings` key table, `kpi` metric resolution, the LLM analyzer environment toggles, and `spec_overrides` rules.

- Constrain the search space with `custom_param_ranges`: `references/custom-param-ranges.md` (format table, examples, model-specific search-space rules).
- Opt-in `metric_extractor` / `eval_fn` hooks and WandB tracking: `references/hooks-and-wandb.md`.
- LLM/agentic deep dive — `NLConfigGenerator`, the standalone `LLMAnalyzer`, the five autoresearch agent components, and multi-phase research programs: `references/nl-config-and-research.md`.

All model-specific hyperparameters, metric extractors, and `spec_overrides` come from the model skill.

---

## Step 4: Monitor Progress

`runner.run()` blocks until all recommendations complete; use `on_recommendation` / `on_result` callbacks to report progress. Each rec takes 10–90 minutes — don't assume failure during long uploads. If the orchestrator dies mid-run, relaunch with the full suffixed `workspace_path` and `resume=True`. Check progress from a separate process with `query_status()`. Callbacks, resume behaviour, and full `query_status()` / `get_status()` usage: `references/monitoring-and-resume.md`.

---

## Step 5: Interpret Results

`runner.run()` returns a plain dict with `best`, `progress`, and `history` keys; metric values are always in the user's original scale. Report the best config, a ranked comparison table, insights, the WandB link if enabled, and next steps. Full result-dict shape, reporting checklist, and all-recs-failed triage: `references/results.md`.

---

## Model-Specific Notes

Model-specific notes do not belong here. For every requested `network_arch`, read `<bank-root>/models/<network>/SKILL.md` and use its **Training Requirements**, **Per-Action Dataset Requirements**, **Typical Spec Overrides**, **AutoML / HPO Notes**, and **Error Patterns** sections as the source of truth.

---

## Common Pitfalls

The 15 recurring failure modes — including wrong/missing `skill_dir`, wrong LLM endpoint (404), model-specific training failures, workspace collisions, weak proxy metrics, the implicit-direction trap, spec-override typos, mid-sweep orchestrator death, silent random LLM configs, missing `openai`, WandB not logging, and `conda run` buffering — are documented with fixes in `references/pitfalls.md`. Review them before and during any run.

---

## Example Conversations

Representative agent/user exchanges for optimizing a network, requesting a real task metric, LLM-guided search, fully-autonomous autoresearch, resuming, switching to ASHA with WandB, and generating a config from a goal description: see `references/examples.md`.
