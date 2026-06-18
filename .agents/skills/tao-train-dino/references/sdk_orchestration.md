# DINO SDK Orchestration Internals

The following details are only relevant when running DINO via the TAO SDK
(`script_runner` orchestration, S3 I/O wrapping, AutoML). Skills consumed by
the SDK read `skill_info.yaml` for these mappings. Skip this
content if running locally with `docker run`.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Internal Details

### Spec templates

DINO ships without `references/spec_template_train.yaml` or
`references/spec_template_evaluate.yaml`. To use SDK orchestration, generate
them from upstream:

- `spec_template_train.yaml` ← `tao-pytorch/nvidia_tao_pytorch/cv/dino/experiment_specs/train.yaml` (replace `"???"` placeholders with empty strings).
- `spec_template_evaluate.yaml` ← `tao-pytorch/nvidia_tao_pytorch/cv/dino/experiment_specs/evaluate.yaml` plus the shared `evaluate.checkpoint` field expected by `initialize_evaluation_experiment()`.

### Data Sources Gap

DINO's `config.json` has `"data_sources": {}` (empty). The runner's `_apply_data_sources()` only handles flat spec keys (like cosmos-rl's `custom.train_dataset.annotation_path`), but DINO's data sources are **arrays of objects** (`dataset.train_data_sources[{image_dir, json_file}]`). The tao-core microservices config (`tao-core/nvidia_tao_core/microservices/handlers/network_configs/dino.config.json`) has the full mapping using a `mapping` sub-structure, but the runner doesn't support that format.

**Consequence:** The runner cannot auto-resolve data URIs for DINO. Data paths MUST be set manually via `spec_overrides` (see `spec_overrides.md`). The skill's `config.json` instead declares `inputs` in the train action with `[0]`-indexed spec keys so the SDK's script_runner downloads S3 data at runtime:

```json
"inputs": {
    "dataset.train_data_sources[0].image_dir": {"type": "file"},
    "dataset.train_data_sources[0].json_file": {"type": "file"},
    "dataset.val_data_sources[0].image_dir": {"type": "file"},
    "dataset.val_data_sources[0].json_file": {"type": "file"}
}
```

The skill also declares evaluate inputs so generated eval runners do not need
to patch `script_runner` by hand:

```json
"inputs": {
    "evaluate.checkpoint": {"type": "file"},
    "dataset.test_data_sources.image_dir": {"type": "file"},
    "dataset.test_data_sources.json_file": {"type": "file"}
}
```

The DINO model documentation is the source of truth for DINO checkpoint inference:

```text
checkpoint format: pth
evaluate.checkpoint: parent_model
```

All model-specific metadata (dataset type, formats, metrics, required datasets) is documented in the **Training Requirements** section of the skill.

**TODO:** Extend the runner's `_apply_data_sources()` to handle the `mapping` sub-structure from tao-core so DINO can use auto-resolved data sources like cosmos-rl does.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in the DINO model documentation, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `dino.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| distill | `distill.pretrained_teacher_model_path` | `parent_model` | model file inferred from the parent job results folder |
| distill | `encryption_key` | `key` | encryption key |
| distill | `results_dir` | `output_dir` | current job results directory |
| evaluate | `encryption_key` | `key` | encryption key |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `evaluate.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `encryption_key` | `key` | encryption key |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `results_dir` | `output_dir` | current job results directory |
| gen_trt_engine | `encryption_key` | `key` | encryption key |
| gen_trt_engine | `gen_trt_engine.onnx_file` | `parent_model` | model file inferred from the parent job results folder |
| gen_trt_engine | `gen_trt_engine.tensorrt.calibration.cal_cache_file` | `create_cal_cache` | calibration cache path |
| gen_trt_engine | `gen_trt_engine.trt_engine` | `create_engine_file` | output TensorRT engine path |
| gen_trt_engine | `results_dir` | `output_dir` | current job results directory |
| inference | `encryption_key` | `key` | encryption key |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `inference.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| inference | `results_dir` | `output_dir` | current job results directory |
| quantize | `encryption_key` | `key` | encryption key |
| quantize | `quantize.model_path` | `parent_model` | model file inferred from the parent job results folder |
| quantize | `results_dir` | `output_dir` | current job results directory |
| train | `encryption_key` | `key` | encryption key |
| train | `model.pretrained_backbone_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.
