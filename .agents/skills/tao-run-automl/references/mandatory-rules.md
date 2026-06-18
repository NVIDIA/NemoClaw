# Mandatory AutoML Rules

These rules gate every AutoML run. They are non-negotiable and apply during Step 1 before any script is generated.

## MANDATORY prompting for LLM-based algorithms (`llm`, `hybrid`, `autoresearch`)

When the user requests or customizes into an LLM-powered algorithm, resolve ALL THREE of the following before generating the script. Do not ask for these on default `bayesian` quick-start runs.

1. **`llm_endpoint`** — user input -> `AUTOML_LLM_ENDPOINT` -> `https://inference-api.nvidia.com`
2. **`llm_model`** — user input -> `AUTOML_LLM_MODEL` -> `gcp/google/gemini-3.1-pro-preview`
3. **`llm_api_key`** — `AUTOML_LLM_API_KEY` -> `NVIDIA_API_KEY` -> declared local secret file when allowed -> prompt the user

If the runner does not receive valid LLM settings, the LLM brain may silently fall back to random sampling — wasting GPU budget on random configs instead of intelligent ones. There is no error message; the only clue is "LLM call failed... Falling back to random" in the logs.

## MANDATORY: Read the model skill before generating the script

AutoML runs training. Before generating any AutoML script, read `<bank-root>/models/<network>/SKILL.md` (where `<bank-root>` is wherever the agent loaded the workflow from). The model skill contains all model-specific knowledge:

- **Training Requirements** — dataset type, formats, monitoring metric, required dataset URIs to prompt for, required user prompts (data format, num_classes, etc.), and mandatory `spec_overrides`. Prompt the user for every required field. Apply mandatory spec_overrides exactly.
- **Per-Action Dataset Requirements** — table mapping each action to its spec keys, data source, expected files, and whether the field is a list. Use this table to construct the correct data source `spec_overrides` for the requested action. If the model's Typical Spec Overrides mark data sources as "mandatory", construct them from this table and the user's dataset URIs.
- **Typical Spec Overrides** — per-action override suggestions (train, evaluate, export, inference, etc.) extracted from SDK notebooks. Use these as the starting point for `spec_overrides` and suggest them to the user. When overrides are marked "mandatory data sources", they MUST be included — the runner cannot auto-resolve them. Merge with any other mandatory overrides from Training Requirements.
- **AutoML / HPO Notes** — metric, direction, model-specific constraints, and any guidance that narrows or overrides the generated schema. Hyperparameter names/ranges/defaults come first from `schemas/train.schema.json`.
- **Error Patterns** — common training failure modes that apply to AutoML recs too.

Do NOT hardcode model-specific knowledge in the AutoML script without reading the model skill first. Each network has different requirements.

## MANDATORY: No model-specific constants in this AutoML skill

The AutoML skill must not define model-specific hyperparameter names, ranges, defaults, metric names, dataset layouts, archive names, class-count rules, spec override keys, container images, checkpoint quirks, or custom metric regexes. Hyperparameter metadata belongs in `<bank-root>/models/<network>/schemas/train.schema.json`; model-specific runtime guidance belongs in the model skill's **Training Requirements**, **Typical Spec Overrides**, **AutoML / HPO Notes**, and **Error Patterns** sections. This skill may describe how to read and apply those sources, but not the concrete per-model values.

## MANDATORY: Timestamped workspace folders

ALWAYS generate `workspace_path` with a timestamp suffix. Running the same script twice without a timestamp overwrites the previous experiment. Pattern:

```python
from datetime import datetime
TIMESTAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
workspace_path = f"./experiment_name/{TIMESTAMP}"
```

Do NOT use a flat path like `workspace_path="./my_experiment"`. The user should never have to manually delete old workspace folders.

## MANDATORY: Fresh runner per new AutoML request, after preflight passes

Every new user request to run AutoML MUST create a new runner script and launch a new AutoML job, even if an older runner script for the same network/algorithm already exists. This freshness rule starts only after platform and dataset preflight passes. Existing runner files and logs may be read only as references for dataset URIs, credentials patterns, and proven fixes; do not reuse them as the execution target for a new request.

Use a unique timestamp in the new runner filename, log filename, PID filename, SDK `state_file`, and `workspace_path`. Derive path components from the requested `network_arch` and `algorithm`; do not hardcode any model or algorithm name unless it is the actual requested value.

```python
import re

def slug(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value)).strip("_").lower()

TIMESTAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
RUN_NAME = f"{slug(network_arch)}_{slug(algorithm)}"
runner_path = f"automl_runs/run_{RUN_NAME}_{TIMESTAMP}.py"
log_path = f"automl_runs/{RUN_NAME}_{TIMESTAMP}.log"
pid_path = f"automl_runs/{RUN_NAME}_{TIMESTAMP}.pid"
state_file = f"tao_session_state_{RUN_NAME}_{TIMESTAMP}.json"
workspace_path = f"./automl_runs/{RUN_NAME}/{TIMESTAMP}"
```

Only resume an existing runner/workspace when the user explicitly asks to resume, continue, recover, or inspect an existing experiment. If the user says "run automl" or asks for a new AutoML run, treat it as a fresh job.
