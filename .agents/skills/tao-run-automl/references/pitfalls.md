# Common Pitfalls

Failure modes that recur across AutoML runs and how to avoid each one.

1. **`skill_dir` not passed (or wrong path).** `AutoMLRunner(skill_dir=...)` requires an absolute path to a model directory inside the skill bank. The runner raises `FileNotFoundError: skill_info.yaml not found at <skill_dir>/references/skill_info.yaml` if the path is wrong. Use the same bank root the agent loaded the workflow from; combine with `skills/models/<network>/`.
2. **Wrong LLM endpoint (404).** The code hardcodes `https://integrate.api.nvidia.com/v1` as the default, which returns 404. The correct endpoint is `https://inference-api.nvidia.com`. ALWAYS pass `llm_endpoint` explicitly in `automl_settings`. The LLM brain silently falls back to random sampling on 404, so you won't see a crash — just useless random configs.
3. **Model-specific training failures (data format, missing datasets, invalid params).** Each network has unique training requirements. ALWAYS read `<bank-root>/models/<network>/SKILL.md` — the "Training Requirements" and "Error Patterns" sections document model-specific failure modes that apply to AutoML recs too.
4. **Workspace path collisions.** Running the same script twice overwrites the previous experiment. Always include a timestamp: `workspace_path=f"./automl_workspace/{TIMESTAMP}"` where `TIMESTAMP = datetime.now().strftime("%Y%m%d_%H%M%S")`.
5. **Using a weak proxy metric.** The brain can optimize a metric that does not reflect real task quality. Use the metric recommended by the model skill or provide `eval_fn`.
6. **Implicit direction trap.** If the metric name does not imply the desired direction, set `direction` explicitly.
7. **Spec-override typos.** `save_freq_in_epochs` (plural) used to silently do nothing; now raises `ValueError` with suggestion. If you see that error, it's the fix working.
8. **Orchestrator dies mid-sweep.** Relaunch with the same `workspace_path` and `resume=True`. In-flight jobs are recovered from `active_jobs.json`.
9. **Rec never reports a metric.** Check the model skill's metric-emission requirements and custom extractor guidance.
10. **Parallel Bayesian arms.** Bayesian is inherently sequential. If you want parallelism, use `asha`. If you use multiple `AutoMLRunner` instances, give each its own `<SDK>(state_file=...)` (e.g., `LeptonSDK(state_file=...)`, `KubernetesSDK(state_file=...)`) to avoid SQLite write races on the SDK's job store.
11. **LLM brain returning random configs.** If every LLM recommendation looks random, the LLM endpoint is probably failing silently. Check the logs for "LLM call failed" warnings. Verify your API key and endpoint are correct. Common cause: using the wrong endpoint URL (see pitfall #2).
12. **`openai` package not installed.** The `llm`, `hybrid`, and `autoresearch` algorithms require the `openai` Python package. Install with `pip install openai` or reinstall tao-run-automl with the `[llm]` extra (see Preflight for the `git+https://...` direct-URL form).
13. **WandB not logging.** Ensure `wandb_config={"enabled": True}` is passed and either `api_key` is in the config or `WANDB_API_KEY` is set in the environment. Check logs for "WandB initialized" confirmation.
14. **`No default train specs found` for a network.** The skill bank model directory is missing `references/spec_template_train.yaml`, or the packaged AutoML support check is missing `schemas/train.schema.json`. Generate both during skill-bank maintenance and ship them with the plugin; do not expect `~/tao-core` to exist on the runtime machine.
15. **`conda run` buffers output.** When running AutoML via `conda run -n tao_sdk python script.py`, all output is buffered until completion. Use `PYTHONUNBUFFERED=1 ~/miniconda3/envs/tao_sdk/bin/python script.py` for real-time output.
