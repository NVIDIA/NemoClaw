# FastFoundationStereo Spec Param / Parent Model Inference

Model-specific inference mappings for FastFoundationStereo (FFS). Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`.

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `dataset.dataset_name` | `StereoDataset` | StereoDataset |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder (or set explicitly to bp2 ckpt path for raw deploy) |
| evaluate | `evaluate.trt_engine` | `parent_model` | TRT engine inferred from parent gen_trt_engine job |
| evaluate | `model.model_type` | `FastFoundationStereo` | FastFoundationStereo |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `dataset.dataset_name` | `StereoDataset` | StereoDataset |
| export | `export.checkpoint` | `parent_model` | model file inferred from parent train job (or bp2 path for raw deploy) |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `model.model_type` | `FastFoundationStereo` | FastFoundationStereo |
| export | `results_dir` | `output_dir` | current job results directory |
| gen_trt_engine | `dataset.dataset_name` | `StereoDataset` | StereoDataset |
| gen_trt_engine | `gen_trt_engine.onnx_file` | `parent_model` | model file inferred from parent export job |
| gen_trt_engine | `gen_trt_engine.trt_engine` | `create_engine_file` | output TRT engine path |
| gen_trt_engine | `model.model_type` | `FastFoundationStereo` | FastFoundationStereo |
| gen_trt_engine | `results_dir` | `output_dir` | current job results directory |
| inference | `dataset.dataset_name` | `StereoDataset` | StereoDataset |
| inference | `inference.checkpoint` | `parent_model` | pyt path: model file inferred from parent train job (or bp2 path for raw deploy) |
| inference | `inference.trt_engine` | `parent_model` | deploy path: TRT engine inferred from parent gen_trt_engine job |
| inference | `model.model_type` | `FastFoundationStereo` | FastFoundationStereo |
| inference | `results_dir` | `output_dir` | current job results directory |
| train | `dataset.dataset_name` | `StereoDataset` | StereoDataset |
| train | `model.model_type` | `FastFoundationStereo` | FastFoundationStereo |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.pretrained_model_path` | `ptm_if_no_resume_model` | PTM (bp2 ckpt) when no resume checkpoint exists |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train / export / AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. For raw-bp2 use cases without a parent train job, set the `<action>.checkpoint` field explicitly to the bp2 file path. Do not patch generated runner scripts to guess checkpoint paths.
