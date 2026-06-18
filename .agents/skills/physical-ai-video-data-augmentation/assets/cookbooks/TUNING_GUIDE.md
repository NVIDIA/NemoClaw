# Shared VDA Tuning Guide

This guide centralizes common parameter behavior used across cookbook scenes.
Keep scene READMEs focused on deltas that are unique to that scenario.

## Augmentation (`workflow_config.yaml`)

- `n_augmentations`: number of augmented outputs per source video.
- Variable weights: rebalance toward underrepresented conditions; each variable
  distribution must sum to `1.0`.

## Augmentation (`augmentation/augmentation.yaml`)

- `cosmos.parameters.sigma`: larger values increase appearance drift from source.
- `cosmos.parameters.num_steps`: larger values increase quality and runtime.
- `cosmos.parameters.guidance`: larger values enforce prompt intent more strongly.
- `video_captioning.parameters.fps`: raise for fast motion, lower for static scenes.
- `video_captioning.parameters.max_tokens`: raise for visually dense scenes.
- `video_captioning.parameters.temperature`: lower for deterministic captions.
- `pipeline.retry`: retries for the full augmentation chain.
- `template_generation.parameters.retry`: retries for template extraction only.
- `template_generation.parameters.retry_policy`: strategy for retry behavior.
- `hallucination_check.threshold`: stricter checks at lower values.

## Auto-labeling (`auto_labeling/auto_labeling_config.yaml`)

- `detection_and_tracking.classes`: keep only classes relevant to the scene.
- `detection_and_tracking.threshold`: tune precision vs. recall trade-off.
- `detection_and_tracking.max_age`: track persistence through occlusion.
- `vlm_json.frame_fps`: analysis temporal granularity.
- `vlm_json.resolution`: quality vs. token cost trade-off.
- `vlm_json.max_tokens`: event-output budget.
- `vlm_json.timeout`: endpoint timeout window.
- `mcq_generation.window_metadata_extraction.{vlm_max_tokens,llm_max_tokens}`:
  MCQ extraction token budgets.
- `mcq_generation.window_metadata_extraction.window_frames`: per-window span.
- `mcq_generation.window_metadata_extraction.sampling_fps`: keep aligned with
  `vlm_json.frame_fps`.
- `super_resolution.enabled`: enable only when fine detail is needed.
