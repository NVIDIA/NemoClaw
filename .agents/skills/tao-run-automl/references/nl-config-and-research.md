# LLM/Agentic Features Deep Dive

Natural language configuration, the LLM analyzer, the autoresearch agent components, and multi-phase research programs.

## Natural Language Configuration

Don't know which algorithm or parameters to use? The `NLConfigGenerator` translates plain English into a valid AutoML configuration:

```python
from tao_automl.brain.nl_config import NLConfigGenerator

generator = NLConfigGenerator()   # uses NVIDIA NIM by default
config = generator.generate_config(
    user_prompt=user_goal,
    network=network_arch,
    available_parameters=param_records,  # from generate_hyperparams_to_search()
    hardware_info=hardware_info,
)
# config = {
#   "automl_algorithm": "bayesian",
#   "automl_hyperparameters": ["<param_from_model_schema>", ...],
#   "algorithm_specific_params": {"automl_max_recommendations": 15},
#   "metric": "<metric_from_model_skill_or_user_request>",
#   "reasoning": "..."
# }
```

## LLM Analyzer (works with ANY algorithm)

The `LLMAnalyzer` can be used alongside any classical algorithm to provide periodic analysis of experiment results:

```python
from tao_automl.brain.llm_analyzer import LLMAnalyzer

analyzer = LLMAnalyzer(analysis_interval=5, narrow_ranges=True)

# After every 5 completed experiments, call:
analysis = analyzer.analyze(
    experiments=experiment_history,
    parameters=param_records,
    network=network_arch,
    metric_name=metric,
    metric_direction=direction,
    best_metric=best_metric,
)
# analysis = {
#   "patterns": ["..."],
#   "convergence_assessment": "improving",
#   "recommendations": ["..."],
#   "suggested_ranges": {"<param_name>": {"min": ..., "max": ...}},
# }
```

When `narrow_ranges=True`, the analyzer suggests tighter search bounds based on observed patterns. These can be applied to dynamically focus the search.

## Autoresearch Agent Components

The `autoresearch` algorithm integrates five AutoML-Agent concepts:

| Component | What it does | When it runs |
|---|---|---|
| **KnowledgeRetriever** (RAP) | Retrieves built-in tuning knowledge for the requested network and optionally web-searched papers/benchmarks | Once at initialization |
| **SpecPrescreener** | LLM predicts which of N candidate configs are worth running, WITHOUT training. Saves GPU budget by filtering unlikely-to-improve configs. | Before each trial — proposes 3 candidates, pre-screens to pick the best 1 |
| **MultiStageVerifier** | Pre-launch: validates proposed changes won't crash/OOM. Post-result: checks metrics are plausible (not NaN, not anomalous). | Before launch + after result |
| **ExperimentTracker** | Tracks full history with keep/discard decisions and reasoning | After each result |
| **LLMAnalyzer** | Periodic pattern detection, convergence assessment, and optional range narrowing | Every N completed experiments |

## Research Programs

For complex multi-phase optimization, define a research program:

```python
from tao_automl.brain.research_program import ResearchProgram, ResearchPhase

program = ResearchProgram(
    objective=objective,
    network=network_arch,
    phases=[
        ResearchPhase(
            name="Phase 1",
            algorithm="bayesian",
            parameters=["<param_from_model_schema>", "..."],
            trials=8,
        ),
        ResearchPhase(
            name="Phase 2",
            algorithm="asha",
            parameters=["<another_param_from_model_schema>", "..."],
            trials=15,
            carry_forward="best",   # best values carry into this phase
        ),
    ],
)

# Validate before running
issues = program.validate(
    available_parameters=available_parameters,
    available_algorithms=["bayesian", "asha"],
)
```
