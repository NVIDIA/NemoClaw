# Exploration Ideas

Use this file to turn symptoms into concrete hypotheses.

## First Read The Bottleneck

- Low accuracy but stable training usually points to prompt, reward, data, or generation settings.
- Unstable loss, NaNs, or erratic rewards usually point to precision, optimizer, sequence length, or backend issues.
- Low GPU utilization or long idle phases usually point to batching, backend, colocated versus non-colocated execution, or async design.
- Good train-side metrics but weak validation usually point to prompt mismatch, reward misspecification, or validation/data issues.

## Prompt And Rollout Format

Look here when the model seems to misunderstand the task or the evaluator prefers strict structure.

Try:
- removing boilerplate so more tokens are available for task content
- enforcing a stricter answer schema with explicit delimiters or section markers
- comparing terse prompts against explicit reasoning scaffolds
- aligning stop tokens and response markers with the expected output format
- pairing prompt edits with `max_new_tokens` and sequence length so formatting gains are not confused with context-budget gains

Watch:
- answer-format drift
- truncated completions
- reward variance across equivalent prompts
- improvements that vanish when prompt length changes again

## Batch, Sequence, And Precision

Look here when runs are stable but slow, memory-bound, or noisy.

Try:
- raising microbatch size until memory or instability becomes the limiter
- trading gradient accumulation against rollout batch size
- changing `max_total_sequence_length`, prompt length, and `max_new_tokens` together instead of in isolation
- testing sequence packing when padding waste is high
- comparing bf16 and fp16, especially when fp16 shows overflow or reward instability

Watch:
- tokens per second
- peak memory
- reward variance
- whether larger batches reduce useful on-policy freshness

## Synchronous Training

Use synchronous training when GPU count is modest and strict step-to-step freshness matters most.

Try:
- modest increases in per-device batch size
- tensor, pipeline, and context parallel changes only when the model size justifies the overhead
- retuning learning rate and warmup after changing batch layout
- backend comparisons across Megatron, DTensor, and automodel when the recipe supports them

Favor it when:
- one to four GPUs
- stable collective communication
- the main bottleneck is learner quality rather than actor throughput

## Asynchronous Training

Use async ideas when throughput, not optimizer quality, is the main bottleneck.

Try:
- splitting actor and learner work when generation stalls the trainer
- reserving some GPUs for rollouts and the rest for updates
- overlapping sampling and optimization when one side is idle
- testing `max_trajectory_age_steps` and related freshness controls if stale data is hurting quality

Watch:
- whether generation waits on optimization or vice versa
- whether throughput gains are offset by staler policy data
- whether the recipe already disables features that your async plan depends on

## Backend And Correctness

Look here early because correctness fixes can dominate any tuning win.

Try:
- fixing shared compatibility layers instead of recipe-only workarounds
- comparing backend-specific code paths when one backend underperforms unexpectedly
- checking generation backends, attention implementations, and logprob paths when metrics look suspicious

Watch:
- mismatched train versus generation behavior
- backend-specific crashes
- silent metric regressions after switching frameworks

## Reward And Data

Look here when completions seem reasonable but the metric does not move.

Try:
- reward scaling, clipping, or shaping adjustments
- validation split changes when the current signal is too noisy
- dataset mix changes when the recipe may be underfeeding the target behavior
- prompt-template changes that better match the reward model or evaluator

Watch:
- reward saturation
- zero-variance rewards
- improvements in train reward that do not transfer to validation

## Resource Heuristics

Use the available hardware to prune the search space.

- On 1 GPU, prioritize prompt, reward, precision, optimizer, and sequence layout.
- On 2 to 4 GPUs, compare simple synchronous scaling against modest parallelism.
- On 8 or more GPUs, explicitly test whether actor-learner partitioning beats strict lockstep execution.

## Crash Triage

Use failures to narrow the search space instead of repeating them blindly.

- If the crash is a typo, missing import, or obvious shape mismatch introduced by the current experiment, fix it and rerun.
- If the crash is an OOM, first try reducing the most recent memory-expanding change before abandoning the whole axis.
- If the crash comes from backend incompatibility, prefer fixing the shared compatibility layer instead of adding a one-off recipe workaround.
- If the idea keeps failing after a few sensible fixes, log it as `crash` and move on.

## Hypothesis Templates

Turn these into commit-scoped experiments:

- `Prompt: replace verbose instructions with a compact answer schema and stricter delimiters.`
- `Batching: raise microbatch size and lower grad accumulation to improve throughput at similar memory.`
- `Precision: switch fp16 to bf16 before changing model scale or rollout count.`
- `Backend: compare DTensor, Megatron, or automodel to separate tuning effects from framework effects.`
- `Async: split actor and learner resources if rollout latency is leaving GPUs idle.`
- `Reward: retune scaling or clipping when completions look better than the score suggests.`
