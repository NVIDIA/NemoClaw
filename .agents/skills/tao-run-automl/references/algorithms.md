# AutoML Algorithm Guide

Step 2 of the workflow: select an algorithm. Present the algorithm guide only in customization mode or when the user names an algorithm.

## Classical Algorithms

These require no external services — they use statistical/mathematical methods to pick hyperparameters.

| Algorithm | Use when | Typical budget | How it works |
|---|---|---|---|
| `bayesian` | **Default choice.** Small budgets, few parameters. | 5–20 recs | Builds a Gaussian Process model of metric vs. hyperparameters. Sequential — waits for each result before proposing the next, so it learns fast but can't parallelize. |
| `bfbo` | Alternative to bayesian with different acquisition function. | 5–20 recs | UCB-based Bayesian optimization with local penalization. Good when bayesian gets stuck. |
| `hyperband` | Large search spaces, many parameters. | 20–50+ recs | Trains many configs cheaply for a few epochs, keeps the best, trains longer. Requires `automl_max_epochs` and `automl_reduction_factor`. |
| `hyperband_es` | Hyperband + early stopping. | 20–50+ recs | Like hyperband but adds early-stop thresholds to halt clearly bad runs sooner. |
| `asha` | Async variant of hyperband, supports parallel execution. | 10–30 recs | Same successive-halving idea as hyperband, but trials run concurrently. Best when you have many GPUs. Uses `automl_max_concurrent`. |
| `bohb` | Best of both — Bayesian intelligence + Hyperband efficiency. | 15–40 recs | Combines KDE-based model (like Bayesian) with Hyperband's multi-fidelity scheduling. Good all-rounder for medium budgets. |
| `dehb` | Evolutionary + multi-fidelity. | 15–40 recs | Differential evolution mutations + hyperband scheduling. Good for complex search spaces with many interacting parameters. |
| `pbt` | Dynamic schedules — mutates hyperparameters during training. | population_size × generations | Population-Based Training. Starts N configs in parallel, periodically copies weights from winners and perturbs their hyperparameters. Best for long runs where hyperparameters should change over time (e.g. learning rate schedules). |

## LLM/Agentic Algorithms (NEW)

These use a large language model to reason about hyperparameter choices. They require an LLM endpoint (NVIDIA NIM, OpenAI, vLLM, Ollama, etc.) and the `openai` Python package.

| Algorithm | Use when | Typical budget | How it works |
|---|---|---|---|
| `llm` | Domain knowledge matters more than statistical rigor. | 5–20 recs | An LLM proposes hyperparameter configs based on the search space schema, experiment history, and its training knowledge. Falls back to random sampling on LLM failure. Sequential like bayesian. |
| `hybrid` | You want the LLM to orchestrate multi-phase optimization. | 10–50 recs | An LLM strategist plans optimization phases over model-skill parameters. Each phase uses a classical sub-algorithm. Stops when the strategist detects diminishing returns. |
| `autoresearch` | Fully autonomous agent loop. | 10–50 recs | The most powerful mode. Combines: (1) RAP knowledge retrieval about the network, (2) LLM-proposed spec modifications, (3) training-free pre-screening of candidates, (4) multi-stage verification (pre-launch + post-result), (5) keep/discard reasoning. Automatically stops on budget exhaustion or consecutive failures. |

**Default to `bayesian` unless** the user specifically asks for something else, has a large GPU budget, or needs early-stopping on cheap intermediate metrics (ASHA / hyperband).

**Use `llm` / `hybrid` / `autoresearch` when** the user wants LLM-guided search, has an API key for NVIDIA NIM or OpenAI, and wants richer reasoning about why certain hyperparameters are chosen.

**Caveat on ASHA with expensive checkpoints:** ASHA's whole point is running many configs cheaply for early rungs, then promoting survivors. If the model skill warns that checkpoints, validation, or startup cost dominate short trials, prefer the model skill's recommended algorithm instead of assuming ASHA will be cheaper.

## Quick Reference: Algorithm Decision Tree

```
Is your budget tiny (≤10 recs)?
  YES → bayesian
  NO  ↓

Do you have an LLM API key and want AI-guided search?
  YES → Do you want full autonomy? → autoresearch
        Just LLM proposals?        → llm
        LLM orchestrating phases?  → hybrid
  NO  ↓

Do you need parallel execution?
  YES → asha (or bohb for smarter sampling)
  NO  ↓

Is your search space large (10+ parameters)?
  YES → hyperband or dehb
  NO  ↓

Do hyperparameters need to change during training (schedules)?
  YES → pbt
  NO  → bayesian (safe default)
```
