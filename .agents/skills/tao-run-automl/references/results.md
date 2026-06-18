# Interpreting AutoML Results

Step 5 of the workflow: read the result dict, report to the user, and triage when all recs fail.

## Result dict

The result is a plain dict:

```python
{
    "best": {
        "rec_id": 4,
        "specs": {"<param_name>": "<value>", "...": "..."},
        "metric_value": 0.7077,
    },
    "progress": {
        "completed": 8, "total": 8,
        "best_metric": 0.7077, "best_rec_id": 4,
        "algorithm": "bayesian",
    },
    "history": [
        {"rec_id": 0, "metric": 0.6308, "status": "success"},
        {"rec_id": 1, "metric": 0.7077, "status": "success"},
        ...
    ],
}
```

Metric values in `best` and `history` are always in the original scale the user provided — direction inversion (if any) is undone before the dict is returned.

## How to report to the user

1. **Best config** — show the winning hyperparameters and metric value.
2. **Comparison table** — rank all recs by metric, highlight the best.
3. **Insights** — call out what the optimizer learned from the requested parameters and metric.
4. **WandB link** — if tracking was enabled, provide the dashboard URL.
5. **Next steps** — suggest:
   - More recs (re-run with `resume=True` + higher `automl_max_recommendations`).
   - Train longer with the best config using `sdk.create_job(specs=result["best"]["specs"])`.
   - Run a downstream evaluation on the best checkpoint.
   - Run the model skill's recommended export/deploy workflow for the best model.

## If all recs failed

Check common issues:
- **Dataset path wrong** — verify the URI points to the layout required by the model skill.
- **Metric never appears** — verify the model skill's required metric-related overrides and custom extractor are present.
- **Checkpoint or eval artifact missing** — verify the model skill's checkpoint/export/eval requirements.
- **Model or data download timeout** — inspect backend logs and model-skill error patterns.
- **OOM** — reduce the model-specific batch, resolution, sequence length, or memory-heavy knobs recommended by the model skill.
- **Cached data corruption** — inspect the model skill's dataset/cache error patterns and clear only the affected cache path if documented.
- **LLM endpoint unreachable** (llm/hybrid/autoresearch only) — the brain falls back to random sampling. Check `AUTOML_LLM_ENDPOINT` and `AUTOML_LLM_API_KEY`. Verify with: `curl -s $AUTOML_LLM_ENDPOINT/models -H "Authorization: Bearer $AUTOML_LLM_API_KEY"`.
