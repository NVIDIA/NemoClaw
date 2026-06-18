# Experiment Log Template

Use this as the model for an untracked TSV such as `reports/auto_research_results.tsv`.

```tsv
index	branch	parent_commit	commit	recipe	metric_name	metric_value	memory_gb	elapsed_min	launcher	job_id	command	log_path	status	description
1	autoresearch/2026-03-24-dapo-qwen2p5/baseline	abc0000	abc1234	examples/configs/recipes/llm/dapo-qwen2.5-0.5b-b512-p512-g16-fp16.yaml	val_accuracy	0.000000	0.0	12.4	slurm	1980204	uv run ./examples/run_grpo.py --config examples/configs/recipes/llm/dapo-qwen2.5-0.5b-b512-p512-g16-fp16.yaml	reports/auto_research/2026-03-24-dapo-qwen2p5/baseline/run.log	crash	baseline failed before training
2	autoresearch/2026-03-24-dapo-qwen2p5/prompt-compact-schema	abc1234	def5678	examples/configs/recipes/llm/dapo-qwen2.5-0.5b-b512-p512-g16-fp16.yaml	val_accuracy	0.742100	43.9	58.7	slurm	1981205	uv run ./examples/run_grpo.py --config examples/configs/recipes/llm/dapo-qwen2.5-0.5b-b512-p512-g16-fp16.yaml	reports/auto_research/2026-03-24-dapo-qwen2p5/prompt-compact-schema/run.log	keep	compact answer schema
3	autoresearch/2026-03-24-dapo-qwen2p5/rollout-batch-up	abc1234	fedcba9	examples/configs/recipes/llm/dapo-qwen2.5-0.5b-b512-p512-g16-fp16.yaml	val_accuracy	0.751200	44.1	59.8	slurm	1982206	uv run ./examples/run_grpo.py --config examples/configs/recipes/llm/dapo-qwen2.5-0.5b-b512-p512-g16-fp16.yaml	reports/auto_research/2026-03-24-dapo-qwen2p5/rollout-batch-up/run.log	discard	raise rollout batch size without prompt changes
```

Suggested interpretation:
- `index` is the attempted experiment count; use it for rules like `do 50 experiments`
- `parent_commit` records the comparison base; use it to tell clean A/B tests from follow-ups
- `metric_name` and `metric_value` should come from the recipe's authoritative validation or task metric
- `elapsed_min` is the wall-clock duration of the run; sum it or compare it against the remaining budget when the user gives time limits
- `memory_gb` is an auxiliary resource signal, not the target metric
- `launcher` should identify where the run happened, such as `local`, `slurm`, or `nrl-k8s`
- `job_id` should hold the Slurm job id, Ray/Kubernetes submission id, or `none`
- `command` should be the exact training command or the submitted script path
- `log_path` should point to the durable run log or run directory
- use `0.000000` and `0.0` for crash rows if no valid metric was produced
- keep the description short and hypothesis-focused
- `branch` should use the shared experiment prefix so all hypotheses stay grouped

Status values:
- `keep`
- `discard`
- `crash`
