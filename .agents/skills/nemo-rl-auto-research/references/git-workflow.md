# Git Workflow

Use git as a durable experiment journal.

## Prefix

Use one shared prefix for the whole campaign.

Examples:
- `autoresearch/2026-03-24-dapo-qwen2p5`
- `autoresearch/2026-03-24-dapo-qwen2p5-gpu0`

## Branch Layout

Use one branch per experiment under the shared prefix.

Examples:
- `autoresearch/2026-03-24-dapo-qwen2p5/baseline`
- `autoresearch/2026-03-24-dapo-qwen2p5/prompt-compact-schema`
- `autoresearch/2026-03-24-dapo-qwen2p5/bf16-retune-batch`
- `autoresearch/2026-03-24-dapo-qwen2p5/async-actor-learner-split`

Create each branch from a deliberate parent commit:

```bash
git checkout -b autoresearch/2026-03-24-dapo-qwen2p5/prompt-compact-schema <base-commit>
```

Prefer targeted staging and one hypothesis-focused commit before the run:

```bash
git add path/to/file1 path/to/file2
git commit -s -m "prompt: compact answer schema"
```

## Per-Experiment Rhythm

1. Pick a parent commit.
2. Create a branch for one hypothesis.
3. Apply one idea.
4. Commit it.
5. Run the experiment.
6. Log the result.
7. Keep the branch whether the result is good, bad, or crashing.

Example commit messages:
- `recipe: increase rollout batch size`
- `prompt: compact reasoning template`
- `backend: switch generation path to dtensor`
- `stability: lower fp16 risk with bf16`

## Keep Or Discard

Mark the branch `keep` when:
- the metric improves
- the metric is flat but the code or config becomes meaningfully simpler
- the experiment unlocks a stronger follow-up that depends on the change

Mark the branch `discard` when:
- the metric regresses
- the run is unstable without a compelling upside
- the idea adds complexity with no clear benefit
- the crash indicates the underlying hypothesis is poor rather than a trivial bug

Mark the branch `crash` when no valid metric was produced.

Do not delete experiment branches unless the user explicitly asks for cleanup.

## Dirty Worktree

Before changing branches, inspect the worktree and distinguish user work from experiment work.

- Do not run `git stash`, `git reset`, or checkout commands that overwrite user changes unless the user explicitly asks.
- If unrelated dirty files exist, leave them alone and stage only the files for the current hypothesis.
- If dirty files overlap the experiment files, prefer a separate `git worktree` from the intended parent commit, or ask before touching them.
- If generated files or logs appear during runs, keep them untracked unless the user wants them versioned.

## Baseline

If no baseline exists for the shared prefix, create one first:

```bash
git checkout -b autoresearch/2026-03-24-dapo-qwen2p5/baseline <base-commit>
git commit -s --allow-empty -m "baseline: record starting point"
```

Run the unmodified recipe from this branch and record it as the first attempted row in the ledger. Use the baseline commit as the parent for clean A/B experiments.

## Parent Choice

Choose the parent commit deliberately:
- branch from the best known experiment when you want to build on a proven gain
- branch from baseline when you want a clean A/B comparison
- branch from another discarded experiment only when you intentionally want to continue that exact line of inquiry

Helpful commands:

```bash
git branch --show-current
git status --short
git log --oneline -n 10
git branch --list 'autoresearch/*'
```

## Result Ledger

Keep the ledger outside committed history unless the user explicitly wants it versioned. Prefer `reports/auto_research_results.tsv`.

Put logs and submitted scripts under a stable per-experiment path such as `reports/auto_research/<campaign>/<experiment>/`. Record that path in the ledger so a result can be audited without guessing which branch produced which log.

When the user gives count or time budgets, make those budgets visible in the ledger or working notes so you can check them before and after every run.
