# Example Conversations

Representative agent/user exchanges for common AutoML requests.

## User: "Optimize `<network_arch>` training on my dataset"

```
Agent: I'll read the model skill for `<network_arch>` first, then generate a fresh timestamped runner using its required datasets, spec overrides, metric, and recommended search space. I need:
1. The dataset URI or URIs required by that model skill
2. How many trials? (default: 10)

User: s3://bucket/data/train, 10 recs

Agent: Running a fresh job with a new runner, log, state file, and workspace. The model-specific metric and overrides come from `<network>.md`.
[executes runner.run(...)]
```

## User: "I want the real task metric, not the default proxy"

```
Agent: For a real task metric, I'll use the eval_fn hook described by the model skill. This adds per-rec cost, so I’ll adjust the budget if needed.
[executes runner.run(metric=task_metric, direction=direction, eval_fn=model_specific_eval, ...)]
```

## User: "Use the LLM to figure out the best hyperparameters"

```
Agent: I'll use the LLM algorithm — it reasons about your network architecture and learns from each experiment.
I need three things for the LLM brain:
1. LLM endpoint URL (default: https://inference-api.nvidia.com)
2. LLM model name (default: meta/llama-3.1-70b-instruct, or e.g. gcp/google/gemini-3.1-pro-preview)
3. API key for the endpoint (or set NVIDIA_API_KEY env var)

User: endpoint "https://inference-api.nvidia.com", model "gcp/google/gemini-3.1-pro-preview", key "sk-abc123"

Agent: Running LLM-guided search with 10 recs. The LLM will explain its reasoning for each config choice in the logs.
[executes runner.run(automl_settings={
    "algorithm": "llm",
    "llm_endpoint": "https://inference-api.nvidia.com",
    "llm_model": "gcp/google/gemini-3.1-pro-preview",
    "llm_api_key": "sk-abc123",
    ...
})]
```

## User: "Run a fully autonomous search — let the AI figure everything out"

```
Agent: I'll use the autoresearch algorithm. It will:
1. Retrieve tuning knowledge for your network
2. Propose modifications, pre-screen them, verify before launch
3. Make keep/discard decisions with reasoning after each experiment
4. Automatically stop when it detects diminishing returns

I'll cap it at 30 experiments. I need:
- Dataset URI
- LLM endpoint (default: https://inference-api.nvidia.com)
- LLM model (default: meta/llama-3.1-70b-instruct)
- LLM API key (or set NVIDIA_API_KEY env var)

User: dataset s3://bucket/data, endpoint https://inference-api.nvidia.com, model gcp/google/gemini-3.1-pro-preview, key sk-abc123

[executes runner.run(automl_settings={
    "algorithm": "autoresearch", "automl_max_experiments": 30,
    "llm_endpoint": "https://inference-api.nvidia.com",
    "llm_model": "gcp/google/gemini-3.1-pro-preview",
    "llm_api_key": "sk-abc123",
    ...
})]
```

## User: "Resume the experiment from yesterday"

```
Agent: Resuming. The runner will poll any jobs that were in flight when we stopped, report their results, then continue.
[executes runner.run(..., workspace_path="./my_experiment", resume=True)]
```

## User: "Switch to ASHA with 30 trials and track in WandB"

```
Agent: Switching to ASHA — parallel + early-stopping. I’ll first check the model skill for any warning that short trials are dominated by startup, validation, or checkpoint cost, then generate a fresh runner with WandB tracking.
[executes runner.run(
    automl_settings={"algorithm": "asha", "automl_max_epochs": 9, ...},
    wandb_config={"enabled": True, "project": "tao-hpo"},
)]
```

## User: "I don't know what parameters to tune for `<network_arch>`"

```
Agent: I can generate a configuration from your goal description. What are you trying to achieve?

User: Maximize my task metric on a small custom dataset with 1 GPU.

Agent: Based on your constraints, I recommend:
- Algorithm: bayesian (sample-efficient for small budgets)
- Parameters: from the model skill's AutoML / HPO Notes and the generated schema
- Budget: 12 recs
- Ranges: from the model skill and user constraints
[uses NLConfigGenerator, then executes runner.run with the generated config]
```
