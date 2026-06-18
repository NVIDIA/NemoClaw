# AutoML Intake and Required Inputs

Step 1 detail: the field tables, quick-start defaults, launch-intake prompting, preflight verification, the customization gate, the schema-reading requirement, and the quick-start runner shape. The MANDATORY policy rules that gate every run are summarized in the workflow's Step 1 and detailed in `references/mandatory-rules.md`.

## Required fields for a default run

| Field | Required | Example | How to get it |
|---|---|---|---|
| `network_arch` | Yes | `"<network_arch>"` | User states the model |
| `platform` | Yes | `"lepton"`, `"slurm"`, `"local-docker"`, `"kubernetes"` | After the user confirms they want AutoML, run `scripts/list_tao_platforms.py --format text` and ask them to choose from that output. |
| `train_dataset_uri` or direct train spec paths | Yes | `"s3://bucket/data/subset"`, `"/lustre/fsw/tao_datasets/<model>/train"`, or `custom.train_dataset.annotation_path=/...` | User provides a root URI/path, exact spec-key paths, or the model skill declares a default profile for this exact network/use case. |
| `eval_dataset_uri` or direct eval spec paths | Model-dependent | `"s3://bucket/data/eval"`, `"/lustre/fsw/tao_datasets/<model>/eval"`, or `custom.val_dataset.media_path=/...` | Ask only if the model skill's Per-Action Dataset Requirements require an eval/validation source and no default profile supplies it. |
| `image` | Yes | `"nvcr.io/..."` | Resolve the default with `scripts/resolve_tao_image.py --model <network_arch> --action train`, show it to the user, and require confirmation or `image=<override>` before creating the AutoML runner. |
| `metric` | No | `"<metric_name>"` | Use the model skill recommendation or ask if unclear. Do not choose model-specific metrics from this AutoML skill. |
| `direction` | No | `"minimize"` or `"maximize"` | **Only needed if your metric name doesn't contain `"loss"` AND you want to minimize, or contains `"loss"` AND you want to maximize.** Otherwise the implicit "contains 'loss' → minimize, else maximize" rule applies. |
| `skill_dir` | Yes | `"<bank-root>/models/tao-train-dino"` | Absolute path to the model directory in the skill bank. Combine the user's `network_arch` with the bank root the agent loaded the workflow from. Passed explicitly to `AutoMLRunner(skill_dir=...)` — no env-var fallback. |
| `long_running_enabled` | Yes | `true` | Ask during launch intake. If enabled, keep the agent attached and emit status until completion. Default: enabled. |
| `status_interval_minutes` | Yes | `5` | Ask during launch intake. Default: 5 minutes. |
| required credentials | Platform/model-dependent | `SLURM_USER`, `SLURM_HOSTNAME`, `SSH_KEY_PATH` or `SSH_AUTH_SOCK`, `HF_TOKEN` | First filter platform credentials with `scripts/list_tao_platforms.py --platform <platform>`, satisfy required credential groups, then add selected-model credentials. Do not ask for unrelated platform credentials. |
| compute shape | Model-dependent | `num_gpus=4`, `num_nodes=1` | Ask only for model-required hardware fields that are not provided by the platform/default profile. |
| `llm_endpoint` | **Yes** (for `llm`/`hybrid`/`autoresearch`) | `"https://inference-api.nvidia.com"` | **MUST prompt.** The code default `https://integrate.api.nvidia.com/v1` returns 404. Always ask for and pass explicitly. |
| `llm_model` | **Yes** (for `llm`/`hybrid`/`autoresearch`) | `"gcp/google/gemini-3.1-pro-preview"` | **MUST prompt.** Ask which model to use. Default: `meta/llama-3.1-70b-instruct` via NIM. |
| `llm_api_key` | **Yes** (for `llm`/`hybrid`/`autoresearch`) | `"nvapi-..."` or `"sk-..."` | **MUST prompt** if `NVIDIA_API_KEY` / `AUTOML_LLM_API_KEY` env vars are not set. |

## Quick-start defaults (use without asking)

| Field | Default |
|---|---|
| `algorithm` | `bayesian`, unless the user/model default profile explicitly selects another algorithm |
| `automl_max_recommendations` | model/workflow default if declared, otherwise `10` |
| `automl_hyperparameters` | `None` so AutoML uses dataclass-schema params with `automl_enabled=true` |
| `custom_param_ranges` | `None` so ranges/options/defaults come from the generated dataclass schema |
| `long_running_enabled` | `true` |
| `status_interval_minutes` | `5` |

If any required field is missing, ask the user. Do NOT guess dataset paths, skill bank paths, credentials, or hardware that the model skill marks as required.

## Friendly launch-intake prompting

When asking for missing AutoML launch inputs, use a first-time-user friendly prompt. Do not say only "train dataset root" / "eval dataset root", and do not say "attached monitoring every 5 minutes" without explaining it. Include:

- platform choices;
- root-mode dataset examples for the selected platform;
- direct spec-parameter mode as an equal option;
- model-required spec keys from the model skill's Per-Action Dataset Requirements table;
- resolved train container image and the option to override it with `image=<override>`;
- monitoring meaning and cadence choices.

## Preflight verification before generating a script

Before generating an AutoML script, verify platform access and dataset visibility using the shared launch preflight. For SLURM, that means passwordless SSH to at least one login host and remote `test -e` checks for each required annotation/media path. If preflight fails, stop with remediation steps instead of creating a runner that will immediately fail.

Also verify container image confirmation using the shared launch preflight. AutoML launches real train jobs for each recommendation, so the confirmed train image must be passed into `AutoMLRunner.run(..., image=chosen_image, ...)` or into the SDK adapter's `create_job(..., image=chosen_image, ...)`. Do not rely on an implicit default after the user has chosen a platform and dataset.

Also run any model-specific annotation content checks documented by the model skill. Missing required annotation fields are a preflight failure, not an AutoML recommendation failure.

## Customization gate

After the required quick-start fields are resolved, you may briefly offer customization. If the user declines or does not ask for it, proceed with the defaults above. If the user chooses customization, then present the additional options below.

Customization-only fields:

| Field | Example | Notes |
|---|---|---|
| `algorithm` | `bayesian`, `asha`, `hyperband`, `bohb`, `llm`, `hybrid`, `autoresearch` | Present the algorithm guide only in customization mode or when the user names an algorithm. See `references/algorithms.md`. |
| `max_recommendations` | `5`, `10`, `20` | Explain that each recommendation is a real training job. |
| `long_running_enabled` | `false` | Only use false when the user explicitly does not want the agent to keep monitoring. |
| `status_interval_minutes` | `5`, `10`, `15` | Already asked during launch intake; customize only if the user wants a different cadence. |
| `automl_hyperparameters` | `["train.optm_lr", "train.epoch"]` | List choices from the generated schema JSON, not from hand-written guesses. |
| `custom_param_ranges` | `{"train.optm_lr": {"valid_min": 1e-6, "valid_max": 1e-4}}` | Validate against schema type/range/options before using. See `references/custom-param-ranges.md`. |
| `llm_endpoint`, `llm_model`, `llm_api_key` | `https://inference-api.nvidia.com`, `gcp/google/gemini-3.1-pro-preview`, `nvapi-...` | Required only when the selected algorithm is `llm`, `hybrid`, or `autoresearch`. Resolve from env/secret files first where allowed, then prompt. |

## Read the generated dataclass schema before configuring AutoML

For the selected model/action, read:

- `${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/models/<network>/schemas/train.schema.json`
- `${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/models/<network>/schemas/manifest.json`

AutoML is enabled by the model skill, but it can run only when `schemas/train.schema.json` is packaged with the plugin and valid for the selected model. Do not fall back to hand-written model notes, old runner scripts, or a local `~/tao-core` checkout for AutoML parameter metadata. If the train schema is missing, stop and report that AutoML is enabled for that model but not runnable until the schema is generated and shipped in the skill bank.

Use the schema JSON as the source of truth for `automl_default_parameters`, `automl_disabled_parameters`, per-parameter defaults, ranges, enums, `option_weights`, `math_cond`, `depends_on`, `parent_param`, and `popular`.

When `automl_hyperparameters=None`, the runner automatically discovers all params marked `automl_enabled=True` in the network's generated schema. Each network has its own set; never hardcode them in this workflow skill.

## Quick-start runner shape

```python
# network_arch is NOT a runner.run() arg anymore; it's encoded in
# skill_dir which was passed to AutoMLRunner(skill_dir=...) at construction.
result = runner.run(
    train_dataset_uri=TRAIN_DATASET_URI,
    automl_settings={
        "algorithm": "bayesian",
        "metric": metric,
        "automl_max_recommendations": 10,
    },
    automl_hyperparameters=None,  # use schema params marked automl_enabled=true
    custom_param_ranges=None,     # use schema ranges/options/defaults
    spec_overrides={...},         # from model skill + dataset requirements
    workspace_path=f"./automl/{TIMESTAMP}",
)
```

Full runner shapes, customization additions, the LLM-powered example, and the programmatic `AutoML` API: see `references/automl-settings.md` (and `references/custom-param-ranges.md` for search-space constraints).

## Best-practice on metric choice

- Training loss is cheap, but can overfit on small fine-tuning datasets. Prefer the model skill's recommended validation or task metric when available.
- If the model skill recommends a validation proxy, also apply the model skill's required validation-related `spec_overrides` so the metric is actually emitted.
- A real task metric via `eval_fn` is often the most honest but adds per-rec cost. Use it when the model skill says log-based metrics are insufficient or the user explicitly wants downstream evaluation.
