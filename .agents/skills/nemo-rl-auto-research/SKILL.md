---
name: nemo-rl-auto-research
license: Apache-2.0
description: "Autonomous NeMo-RL research agent workflow for directed hypothesis testing and open-ended discovery. Guides agents through the full experiment lifecycle: understanding recipes and environments, wiring RL or NeMo-gym runs, launching reproducible baselines and iterations, analyzing results, preserving human oversight, and using git plus TSV logs as the research ledger. Do NOT use for: bug fixes, code review, documentation, refactoring, dependency updates, or single-file changes."
when_to_use: auto research; run experiments; test these hypotheses; find a better recipe; improve accuracy; long-running NeMo-RL or NeMo-gym research campaigns; autonomous discovery; directed execution.
---

# Auto Research

Run iterative NeMo-RL experiments in this repository against the user's stated objective, such as accuracy, reward, throughput, latency, stability, or another recipe-specific metric, with git as the research ledger.

Treat dependencies as ready, but choose the runtime deliberately. Use the recipe's authoritative metric as the source of truth. Keep changes small, reproducible, and simple. Preserve unrelated user work.

**Safety:** This skill creates git branches, writes files to disk, and executes shell commands including training jobs that may consume GPU resources. Always confirm the campaign plan with the user before creating branches or launching jobs. Do not execute destructive git operations (reset, force-push) or launch compute-intensive jobs without explicit user approval.

Use the `nemo-rl-session-memory` skill for every auto-research campaign. Start or resume a session record before branching, then checkpoint after forming the plan, before and after meaningful edits or long-running launches, when the user changes direction, and before handoff or final summary.

After context compaction, handoff, disconnect, or a long gap, reload this skill and any companion skills already in use, read the latest `nemo-rl-session-memory` handoff, and restate the overall objective, stop rules, current branch, and latest result before continuing. Treat follow-up steering as additive unless the user explicitly changes the main objective.

## Workflow

1. Inspect the current git state and identify unrelated user changes before branching.
2. Use a shared branch prefix. Prefer a user-provided one; otherwise create a suggestive default such as `autoresearch/2026-03-24-dapo-qwen2p5`.
3. Read the target recipe, its parents, and the relevant code paths in `examples/run_grpo.py`, `nemo_rl/models/`, `nemo_rl/algorithms/`, `nemo_rl/environments/`, and `docs/`. For NeMo-gym recipes, also inspect `examples/nemo_gym/` entrypoints, configs, and launch scripts.
4. Translate any user stop rule into explicit values you can monitor, such as the requested number of experiments as `target_experiment_count`, `campaign_deadline`, `per_experiment_timeout`, or `target_metric`.
5. Verify required data, checkpoints, runtime inputs, and the launcher.
6. Create an untracked TSV log and per-experiment log directory.
7. Run a baseline first on `<prefix>/baseline` if none exists.

For GPU, CPU-heavy, distributed, or long-running work, choose the execution environment deliberately. Run locally when the current machine has suitable GPUs and capacity; otherwise follow the user's requested environment, use `launch-nemo-rl` for nrl-k8s/Kubernetes, use the environment's native launcher for Slurm, or clarify with the user before launching. Use CPU-only local runs only for light inspection, dry runs, and short non-GPU checks.

If the user mentions Brev, or if `/home/ubuntu/RL` exists and `/ephemeral` is available as a volume, treat the machine as a Brev instance and use `nemo-rl-brev-etiquette` before creating experiment directories, caches, logs, checkpoints, or authenticated runtime state.

## Branching

- Put every experiment on its own branch under the shared prefix.
- Keep every branch, even for failed or weak ideas.
- Put at least one commit on each branch for the hypothesis.
- Add follow-up fix commits on the same branch when a rerun is justified.
- Never stash, reset, or overwrite unrelated user changes silently. If dirty files overlap the experiment, use a separate worktree or ask before proceeding.

See `references/git-workflow.md` for the exact pattern.

## Loop

1. Pick one concrete hypothesis.
2. Create a branch such as `autoresearch/2026-03-24-dapo-qwen2p5/prompt-compact-schema`.
3. Edit the smallest set of files needed.
4. Commit the hypothesis.
5. Before launching the run, check the monitored stop conditions. Do not stop early unless one is already clearly met.
6. Identify the authoritative metric source from the recipe or logging code, then run with a unique log path:

```bash
LOG_DIR=reports/auto_research/<campaign>/<experiment>
mkdir -p "$LOG_DIR"
uv run <entrypoint> > "$LOG_DIR/run.log" 2>&1
```

7. If the user gave a per-experiment wall-clock limit, enforce it explicitly. Prefer a recipe-level timeout when one already exists; otherwise wrap the command with an external timeout. If both exist, honor the tighter limit.
8. Extract the primary metric with a command appropriate for the actual log format. If extraction is empty, inspect the last log lines and the recipe's logging path before marking the run.
9. Record index, branch, parent commit, commit, recipe, metric name, metric value, memory (GB), elapsed time (minutes), launcher, job id, command, log path, status, and description in the TSV, along with enough timing or count information to evaluate the stop rule.
10. Periodically print user-facing progress updates during the campaign. Include the current branch, latest known result, attempted experiment count, remaining experiment count if applicable, remaining campaign time if applicable, and whether any stop condition has been met yet.
11. Re-check the monitored stop conditions after the experiment completes and state the result explicitly, for example `stop condition not yet met: 17/24 attempted, 6h12m remaining` or `stop condition met: 24/24 attempted`.
12. Mark the result as `keep`, `discard`, or `crash`, then move to the next branch unless a user-specified stop condition has been clearly met.

For count-based stop rules, count attempted ideas, not only successful or fully completed runs.

For campaign time budgets, convert the user limit into an absolute deadline at the start of the campaign and keep checking remaining time.

For per-experiment budgets, enforce a timeout on every run and treat overruns as failures.

Examples:
- `do 50 experiments`: stop only after 50 attempted experiment rows exist in the TSV
- `10h total, 1h each`: enforce a 1 hour limit per run and stop when the 10 hour campaign budget is reached, or when there is not enough remaining budget to start another 1 hour run
- `50 experiments or 10h total, 1h each`: monitor all three values, never exceed the per-run cap, and stop only when one campaign-level stop trigger is clearly reached

## Priorities

Prefer ideas with high expected objective gain and low complexity cost:
- correctness and backend compatibility
- prompt and rollout formatting
- batch, sequence, and precision layout
- optimizer and scheduler tuning
- reward shaping, clipping, or scaling
- dataset mix or validation changes
- synchronous versus asynchronous execution based on hardware

All else equal, prefer simpler wins and avoid brittle hardware-specific hacks.

## Avoid

- Do not conclude a training idea failed from an underpowered smoke run. If a run uses tiny batch sizes, very few optimizer steps, or otherwise non-representative settings, treat it as plumbing validation only; scale to a meaningful batch size and train long enough to test the hypothesis before marking it `discard`.
- Do not repeatedly pay batch-scheduler setup costs for tight edit-run-debug loops. If Slurm batch jobs have a large startup tax and failures require quick iteration, use the documented interactive Slurm pattern or ask the user before resubmitting more batch jobs.
- Do not let context compaction or follow-up steering questions erase the original campaign goal. Refresh `nemo-rl-session-memory`, reload active skills, and preserve the main objective unless the user explicitly changes it.

## Stop

If the user gives explicit stopping conditions, they override the generic rule. Do not stop because the search feels sufficient; stop only when the requested count, deadline, budget, or target condition has been clearly met.

During the campaign, explicitly inform the user whether the stop condition has been met. If not, report the remaining count, remaining time, or other remaining threshold in concrete terms.

If the user does not give explicit stopping conditions, run the baseline plus up to three low-risk experiments, then summarize the best result and ask before continuing.

## References

- `references/git-workflow.md` for branch, dirty-worktree, parent-commit, and baseline rules.
- `references/exploration-ideas.md` for turning symptoms into concrete hypotheses.
- `references/experiment-log-template.md` for the TSV schema and reproducibility fields.
