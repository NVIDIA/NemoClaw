# Project scaffold brief

**Loaded by:** the main agent during the Act phase of `/nemotron-customize`,
after plan approval.

You generate the **shared project files** that wire all stages together.
Per-stage implementations are delegated to sub-agents via [STAGE.md](STAGE.md)
— don't write stage code here.

## Deliverables

```
<project-name>/                 # kebab-case directory
├── pyproject.toml              # deps, metadata, ruff config
├── .python-version             # "3.12"
├── README.md                   # mermaid diagram, usage, stage table
├── env.toml.example            # cluster + container template
├── <project_name>/             # snake_case Python package
│   ├── __init__.py
│   ├── __main__.py             # `from .cli import app; app()`
│   ├── cli.py                  # Typer: one command per stage + `all`
│   └── stages/                 # populated by sub-agents
└── .generated/
    ├── pipeline.toml           # canonical stage graph
    ├── SKILL.md                # invocable as /<project-name>
    └── plugin.json             # agent plugin manifest
```

**Naming:**
- `<project-name>` (kebab-case) → top-level dir, skill invocation, DAG name.
- `<project_name>` (snake_case, valid Python identifier) → package name, used in `python -m <project_name>.cli`.

If deploy target ≠ local-only:
- **Airflow**: `deploy/dag.py` — imports stage functions, wires as Airflow tasks.
- **Kubeflow**: `deploy/pipeline.py` — KFP components, one per stage.

---

## Rules

### R1. Typer CLI, dry-run default

One command per stage + `all`. Dry-run is default to prevent accidental GPU launches.

```bash
python -m <project_name>.cli sft              # prints what would happen
python -m <project_name>.cli sft --run        # actually launches
python -m <project_name>.cli all --run        # all stages sequentially
```

`cli.py` ≤200 lines, no business logic — each command imports + calls a stage
function. **Never** subprocess.

```python
@app.command()
def sft(run: bool = typer.Option(False, "--run", help="Execute (default is dry-run)")):
    run_sft(..., dry_run=not run)
```

Don't use Typer's auto `--dry-run / --no-dry-run` pair. Convention is the single
opt-in `--run` flag across all generated projects.

### R2. DATA_ROOT layout, no `${art:...}` resolvers

Each stage reads from its predecessor's output directory under `$DATA_ROOT`:

```
$DATA_ROOT/
├── raw/           # user places input here
├── translated/    # stage 1 output = stage 2 input
├── prepared/      # stage 2 output = stage 3 input
├── sft/           # stage 3 output
├── eval/          # stage 4 output
└── converted/     # stage 5 output
```

The filesystem **is** the artifact graph. Document the layout in `README.md`.

The reference recipes under
[src/nemotron/recipes/](../../../../src/nemotron/recipes/) use `${art:...}` for
W&B-Artifacts lineage — that's a different system. Don't propagate it into
generated code.

### R3. Tooling is mandatory

- `.python-version`: `3.12`.
- `pyproject.toml` includes `[tool.ruff]`.
- README uses `uv sync` / `uv run` throughout.
- Every imported third-party package must appear in `pyproject.toml`.

### R4. `.generated/pipeline.toml` is canonical

```toml
[[stages]]
id = "01_translate"
step = "translate/nemo_curator"
consumes = "filtered_jsonl"
produces = "translated_jsonl"

[[stages]]
id = "02_prep"
step = "data_prep/sft_packing"
consumes = "translated_jsonl"
produces = "packed_parquet"
```

Don't duplicate as Python dicts. `cli.py` derives the registry at import time:

```python
import tomllib
from pathlib import Path
_pipeline = tomllib.loads(Path(".generated/pipeline.toml").read_bytes())
STAGES = [s["id"] for s in _pipeline["stages"]]
```

### R5. Generated skill + plugin

`.generated/SKILL.md` + `.generated/plugin.json` make the project invocable as
`/<project-name>` so the user can run, debug, and iterate via an agent client.

Keep it narrow: "what this pipeline does, how to run each stage, README
layout." **Don't duplicate `nemotron-customize` content.**

`.generated/SKILL.md` must have frontmatter:

```markdown
---
name: <project-name>
description: <one-line: what the pipeline does + which steps it composes>
---
```

### R6. `__main__.py` for zero-install runs

```python
from .cli import app
app()
```

Enables `python -m <project_name>` without `pip install`.

### R7. W&B off by default

CLI exposes `--wandb-project` per stage. First run works with just `DATA_ROOT`:

```bash
python -m <project_name>.cli sft --run                         # no tracking
python -m <project_name>.cli sft --run --wandb-project my-exp  # W&B on
```

### R8. Container images live in runspec / env.toml

Training images go in `[tool.runspec]` and `env.toml.example`. Never hardcode
in stage YAML.

### R9. Cite influencing patterns in README

One line per pattern that shaped the design:

```
This pipeline follows the eval-bookends pattern (eval before and after training).
Packing follows pack-variable-length for heterogeneous SFT data.
```

Use [../PATTERNS.md](../PATTERNS.md) first for pattern selection. Fall back to
[src/nemotron/steps/patterns/](../../../../src/nemotron/steps/patterns/) only
when a full pattern body is needed.

### R10. Deploy targets share `stages/`

CLI and deploy files import from the same `stages/` package — neither imports
the other. README documents both invocations:

```
## Run locally
python -m <project_name>.cli all                # dry-run
python -m <project_name>.cli sft --run

## Deploy to Airflow
cp deploy/dag.py $AIRFLOW_DAGS/
airflow dags trigger <project-name>
```

---

## Delegating stages

After the scaffold is written, spawn one sub-agent per stage. Each sub-agent:

1. Loads [STAGE.md](STAGE.md) (the implementation contract).
2. Loads the correct context pack from [../context/index.toml](../context/index.toml).
3. Receives from you: step id, customer requirements, output path.

**Sub-agent brief template:**

```
You are implementing stage <NN>_<name> = <step_id>.

Load:
  - references/act/STAGE.md       (implementation contract)
  - <context_pack_path>           (from references/context/index.toml lookup)

Plan requirements:
  - Model: <model>
  - Hardware: <gpus>
  - Key params: <from approved plan>

Output path (repo-relative): <project_name>/stages/<NN>_<name>/

Deliverables (exactly these, all under output path):
  - run.py
  - __init__.py
  - config/default.yaml
  - config/tiny.yaml, or the step's checked-in smoke config name such as config/tiny_chat.yaml for eval/model_eval

Report back: files written, config knobs exposed, any UPSTREAM notes,
strategies followed (for the plan's traceability log).
```

Stages can be generated in parallel — they're independent directories.

---

## Verify checklist (main agent runs after sub-agents return)

- [ ] All `.generated/pipeline.toml` stages have a corresponding `stages/<id>/`.
- [ ] Every `consumes`/`produces` chain is consistent.
- [ ] `pyproject.toml` covers every import in every stage.
- [ ] `README.md` mermaid matches actual stages.
- [ ] A smoke config exists per stage with reduced scope, using the step's checked-in naming convention.
- [ ] No `${art:...}` references leaked into generated stage configs.
