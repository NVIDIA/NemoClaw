# Remote Execution

Load this reference when the user mentions clusters, Slurm, `env.toml`, `--run`, `--batch`, remote logs, GPU placement, or session-safe long-running jobs.

## Profile Checks

- Inspect the repo root `env.toml` before composing remote commands.
- Confirm the requested profile exists and matches the intended executor.
- Keep secrets in the remote environment; never ask users to paste key values.
- Start with the same local help or dry-run command before adding `--run` or `--batch`.

## Modes

| Mode | Use When | Pattern |
| --- | --- | --- |
| Local dry-run | Validate config rendering before scheduling | `uv run nemotron <family> <stage> -c default -d ...` |
| Remote run | User wants an interactive remote execution path | `uv run nemotron <family> <stage> -c default --run <profile> ...` |
| Remote batch | User wants a scheduled detached job | `uv run nemotron <family> <stage> -c default --batch <profile> ...` |

## Operating Pattern

1. Render the config locally with `-d`.
2. Scope GPUs with `CUDA_VISIBLE_DEVICES=<ids>` when the user gives GPU IDs.
3. Add dotlist overrides only after confirming the stage contract inputs and outputs.
4. For multi-stage `rerank run --run` or `rerank run --batch`, verify the profile provides `remote_job_dir` or `env_vars.NEMO_RUN_DIR` so stage outputs share one run directory.
5. Stop remote pipelines before `deploy`; deploy is local-only. For rerank, avoid `--stage` on `rerank run` and use the single-stage command with `--dry-run` instead.
6. Record the command, profile, output directory, expected log path, and next poll time.
7. Poll at human-scale intervals: roughly 60 seconds for pilots and 120-300 seconds for larger jobs.
8. If the remote job fails before the recipe starts, inspect environment, mount paths, image, and scheduler logs before changing recipe configs.
