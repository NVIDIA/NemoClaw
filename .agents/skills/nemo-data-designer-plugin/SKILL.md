---

name: nemo-data-designer-plugin
description: Use when the user wants to create a dataset, generate synthetic data, or build a data generation pipeline.
argument-hint: [describe the dataset you want to generate]
license: Apache-2.0
metadata:
  owner: nemo-platform
---

# Before You Start

Do not explore the workspace first. The workflow's Learn step gives you everything you need.

# Goal

Build a synthetic dataset using the Data Designer library that matches this description:

$ARGUMENTS

# Workflow

Use **Autopilot** mode if the user implies they don't want to answer questions — e.g., they say something like "be opinionated", "you decide", "make reasonable assumptions", "just build it", "surprise me", etc. Otherwise, use **Interactive** mode (default).

Read **only** the workflow file that matches the selected mode, then follow it:

- **Interactive** → read `workflows/interactive.md`
- **Autopilot** → read `workflows/autopilot.md`

# Rules

- Keep all columns in the output by default. The only exceptions for dropping a column are: (1) the user explicitly asks, or (2) it is a helper column that exists solely to derive other columns (e.g., a sampled person object used to extract name, city, etc.). When in doubt, keep the column.
- Do not suggest or ask about seed datasets. Only use one when the user explicitly provides seed data or asks to build from existing records. When using a seed, read `references/seed-datasets.md`.
- When the dataset requires person data (names, demographics, addresses), read `references/person-sampling.md`.
- If a dataset script that matches the dataset description already exists, ask the user whether to edit it or create a new one.
- For commands and context specific to this NeMo Platform plugin (e.g., sourcing model configs from IGW providers or in-script `ModelConfig`s, installing or publishing Nemotron Personas locales, platform-side resource pointers), read `references/nemo-platform-plugin-additions.md`.

# Usage Tips and Common Pitfalls

- **Sampler and validation columns need both a type and params.** E.g., `sampler_type="category"` with `params=dd.CategorySamplerParams(...)`.
- **Jinja2 templates** in `prompt`, `system_prompt`, and `expr` fields: reference columns with `{{ column_name }}`, nested fields with `{{ column_name.field }}`.
- `**SamplerColumnConfig`:** Takes `params`, not `sampler_params`.
- **LLM judge score access:** `LLMJudgeColumnConfig` produces a nested dict where each score name maps to `{reasoning: str, score: int}`. To get the numeric score, use the `.score` attribute. For example, for a judge column named `quality` with a score named `correctness`, use `{{ quality.correctness.score }}`. Using `{{ quality.correctness }}` returns the full dict, not the numeric score.

# Troubleshooting

- `**nemo data-designer` CLI not found:** Tell the user that `nemo data-designer` is not installed in this environment (requires Python >= 3.11). Ask if they would like you to create a virtual environment and install it, or if they prefer to do it themselves. Do not install anything without the user's permission.
- **Network errors during preview:** A sandbox environment may be blocking outbound requests. Ask the user for permission to retry the command with the sandbox disabled. Only as a last resort, if retrying outside the sandbox also fails, tell the user to run the command themselves.

# Output Template

Write a Python file to the current directory with a `load_config_builder()` function returning a `DataDesignerConfigBuilder`. Name the file descriptively (e.g., `customer_reviews.py`). Use PEP 723 inline metadata for dependencies.

```python
# /// script
# dependencies = [
#   "data-designer", # always required
#   "pydantic", # only if this script imports from pydantic
#   # add additional dependencies here
# ]
# ///
import data_designer.config as dd
from pydantic import BaseModel, Field


# Use Pydantic models when the output needs to conform to a specific schema
class MyStructuredOutput(BaseModel):
    field_one: str = Field(description="...")
    field_two: int = Field(description="...")


# Use custom generators when built-in column types aren't enough
@dd.custom_column_generator(
    required_columns=["col_a"],
    side_effect_columns=["extra_col"],
)
def generator_function(row: dict) -> dict:
    # add custom logic here that depends on "col_a" and update row in place
    row["name_in_custom_column_config"] = "custom value"
    row["extra_col"] = "extra value"
    return row


def load_config_builder() -> dd.DataDesignerConfigBuilder:
    config_builder = dd.DataDesignerConfigBuilder(
        # Declaring model configs programmatically here is the portable path:
        # it works for both local `run` and cluster `submit`, while the local
        # YAML registry alternative only works for `run`. The provider below
        # is a common default created during `nemo setup` — confirm it (or
        # discover others) with `nemo inference providers list`. See
        # references/nemo-platform-plugin-additions.md for the local-YAML alternative.
        model_configs=[
            dd.ModelConfig(
                alias="text",
                model="...",
                provider="default/nvidia-build",
                inference_parameters=dd.ChatCompletionInferenceParams(),
            ),
        ],
    )

    # Seed dataset (only if the user explicitly mentions a seed dataset path)
    # config_builder.with_seed_dataset(dd.LocalFileSeedSource(path="path/to/seed.parquet"))

    # config_builder.add_column(...)
    # config_builder.add_processor(...)

    return config_builder
```

Only include Pydantic models, custom generators, seed datasets, and extra dependencies when the task requires them. Prefer including `model_configs` when the dataset uses LLM columns — declaring it in the script keeps the config portable between local `run` and cluster `submit`, while the local YAML registry alternative only works for `run`.
