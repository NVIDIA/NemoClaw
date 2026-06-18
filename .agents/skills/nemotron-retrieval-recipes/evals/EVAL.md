# Evaluation Guidance

This skill follows a functional skill evaluation approach: define realistic tasks, run the chosen agent harness with and without the skill, compare outcomes, and report uplift.

## Evaluation Goals

The evaluation is functional: it checks whether agents use the skill when public Nemotron retrieval recipe expertise is needed, avoid it for unrelated tasks, and produce better task outcomes with the skill than without it. Because these recipes are long-running, wall-clock recipe completion is not the main success signal. The useful lift is whether the skill helps the agent route to the right recipe family, ground itself in the current checkout, choose safe dry-runs before expensive stages, preserve secrets, interpret metrics correctly, and hand off long-running execution with clear run reports.

## Dataset Rules

- Keep prompts realistic. Do not name the skill in user prompts.
- Include positive cases for embedding planning, reranker selection, deployment debugging, stale artifact diagnosis, secret-safe setup, prerequisite gating, remote execution, long-running job boundaries, docs-to-checkout reconciliation, metric interpretation, stage readiness, and export/deploy boundary debugging.
- Include negative cases where the skill should not activate, including unrelated factual questions and generic vector database advice.
- Keep `expected_skill`, `ground_truth`, and ordered `expected_behavior` entries explicit enough for deterministic and judge-based grading.
- Do not commit generated `evals/results/` output; commit only reusable fixtures and summary reports.

## Usefulness Rubric

Score agent usefulness above raw runtime. Strong with-skill trajectories should:

- activate on public Nemotron `embed`/`rerank` recipe tasks and stay inactive for generic retrieval or vector database advice,
- inspect or cite the current repo surface before relying on stale docs or memory,
- choose `embed` vs `rerank` from the retrieval failure mode,
- recommend help/dry-run checks before API, GPU, Docker, Slurm, NIM, or other long-running work,
- handle secrets through environment configuration without asking users to paste values,
- separate preview commands, execution commands, polling cadence, and compact run reports.

## Required Checks

Before publication, run the configured skill evaluation harness in the configured evaluation environment:

- validate the skill and eval dataset structure,
- run static skill-quality checks,
- verify documented command examples with read-only `uv run --no-sync ... --help` and `-d` dry-runs when the checkout has the recipe CLI installed,
- run live with-skill and without-skill evaluation,
- cover both Codex and Claude Code, or document why an agent was skipped.

The live evaluation sends skill and eval prompts to the configured model providers. Get explicit approval before running it in an environment where workspace content is sensitive.

## Command Freshness Checklist

Use the current checkout rather than memory. Run the smallest relevant subset of these commands when recipe CLI drift is a concern:

```bash
uv run --no-sync nemotron embed --help
uv run --no-sync nemotron embed run -c default -d --from sdg --to prep
uv run --no-sync nemotron embed run -c default -d --from prep --to eval
uv run --no-sync nemotron rerank --help
uv run --no-sync nemotron rerank run -c default -d --from prep --to eval
uv run --no-sync nemotron rerank eval -c default -d eval_nim=true eval_base=false
```

## Reporting

Review the CI-generated `BENCHMARK.md` before merge. Do not hand-maintain a committed benchmark report for this skill unless the repository process changes.

The generated benchmark should include:

- agent harness and model versions, or public-safe aliases when model route names should not be published,
- metric names,
- test dataset size,
- with-skill score, without-skill score, and uplift,
- task completion and wall-clock/token data for the agent harness, making clear that this is agent-evaluation cost rather than expected recipe training runtime,
- limitations or skipped agents.

Treat any remaining generated findings as public-facing. Tier 1 high/critical findings must be fixed before merge unless they are confirmed false positives; lower-tier findings should still be reviewed and either fixed, accepted as non-blocking risk, or identified as false positives or run-to-run variance.
