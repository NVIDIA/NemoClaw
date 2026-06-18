# Stage implementation brief

**Loaded by:** each per-stage sub-agent spawned by the main agent during the
Act phase of `/nemotron-customize`.

You generate **one stage**. The main agent gives you:

- The step id (e.g. `sft/megatron_bridge`).
- Customer requirements from the approved plan (model, hardware, params).
- Which context pack to load from [../context/index.toml](../context/index.toml).
- The output path (e.g. `<project_name>/stages/<NN>_<name>/`).

Your job: read the context pack, adapt the step.py pattern to the customer's
config, write the stage files. Thin. Runnable. Agent-legible.

---

## Deliverables

```
<output-path>/
├── run.py                  # entry point (≤60 lines)
├── __init__.py             # re-export only: `from .run import run_<stage_name>`
└── config/
    ├── default.yaml        # production config
    └── tiny.yaml           # smoke test, or the step's checked-in smoke config name
```

Don't create shared project files — the main agent owns those (see
[PROJECT.md](PROJECT.md)).

---

## Implementation rules (R1–R5)

These prevent the #1 quality problem: stages that reimplement library code
instead of wrapping it.

### R1. Wrap, don't reimplement

Each stage is a **thin wrapper (≤60 lines)** around the library's public API.
Never reimplement logic that already exists in the library.

```python
# ✅ CORRECT — prep stage
from nemotron.data_prep.api import run_sft_pipeline

def run_prep(data_root, config, dry_run, **kwargs):
    cfg = load_config(config)
    if dry_run:
        print(f"Would pack {data_root}/translated → {data_root}/prepared")
        return
    run_sft_pipeline(
        blend_path=data_root / "translated",
        output_dir=data_root / "prepared",
        tokenizer=cfg["tokenizer"],
        pack_size=cfg["pack_size"],
    )
```

```python
# ❌ WRONG — reimplements packing algorithm, chat templates, shard writing...
def tokenize_and_pack(input_path, ...):
    ...  # 400 lines of library logic
```

If a library lacks a clean public API, write the minimal shim and add a
`# UPSTREAM: need public API for X` comment. Don't write a full
reimplementation.

The reference implementation for SFT data prep lives in
[src/nemotron/recipes/nano3/stage1_sft/data_prep.py](../../../../src/nemotron/recipes/nano3/stage1_sft/data_prep.py).
Use it as your shape model — same `# /// script [tool.runspec] ///` header
pattern, same thin-wrapper-around-library-API approach.

### R2. Named modules, not `__init__.py`

Implementation lives in `run.py`. `__init__.py` is re-exports only:

```python
# stages/sft/__init__.py
from .run import run_sft

__all__ = ["run_sft"]
```

Keeps grep results unambiguous and `git blame` useful.

### R3. No path archaeology

Never locate dependencies via parent traversal (`Path(__file__).parent.parent...`).
In order of preference:

1. `importlib.resources` / `pkg_resources`.
2. Environment variable (`$MEGATRON_BRIDGE_ROOT`, `$AUTOMODEL_ROOT`).
3. `shutil.which()` for CLI tools.
4. Explicit config parameter with a documented default.

### R4. Config is the single source of truth

Model-specific values (TP, PP, learning rate, batch size, seq_length) belong
in `config/*.yaml`, not as magic numbers in Python. Stage code is
model-agnostic; the config makes it model-specific.

```python
# ✅ CORRECT
cfg = load_config(config_name)
recipe.train.lr = cfg["learning_rate"]
```

```python
# ❌ WRONG
LEARNING_RATE = 2e-5    # hardcoded
recipe.train.lr = LEARNING_RATE
```

### R5. Two-tier config surface in YAML

Tuning knobs at the top, architecture knobs below. **4–6 tuning knobs visible**;
everything else stays in recipe defaults.

```yaml
# === Tuning knobs (change these first) ===
learning_rate: 2.0e-5
max_steps: 1000
lora_rank: 16

# === Architecture (change if you know why) ===
micro_batch_size: 1
global_batch_size: 8
sequence_parallel: true
```

---

## Code-quality standards

### File size

- **`run.py` ≤60 lines.** If longer, you're reimplementing — refactor.
- **`config/*.yaml` ≤30 lines.** Just the knobs.

### Naming

- Directories: lowercase + underscores (`stages/sft/`, not `stages/SFT/`).
- Public entry: `run_<stage_name>()`.
- Configs: `default.yaml` and the step's checked-in smoke config name. Most
  stages use `tiny.yaml`; eval/model_eval uses `tiny_chat.yaml`.

### Style

- Type hints on every public signature.
- Docstring on every `run_*()`: what it does, what it reads, what it produces.
- No bare `except:`.
- No `print()` for logging — use `logging.getLogger(__name__)`. Exception:
  `print()` is fine inside the dry-run branch (it's user-facing output).
- No commented-out code.
- No `TODO` without a tracking reference.

### What an agent must be able to do in one read

1. Read `run.py` (≤60 lines), understand it completely.
2. See which library function it calls.
3. See which config values it passes.
4. Change a config value or swap the library call.
5. All in one file, no cross-references needed.

---

## Stage behavior rules

1. **Load and use the context pack.** It's the authoritative reference for the
   library's API — read it, adapt, don't copy verbatim.
2. **Valid imports only.** Every import must reference a real module from the
   step's reference code (`steps/<cat>/<step>/step.py` or one of
   [steps/_runners/](../../../../src/nemotron/steps/_runners/)).
3. **No placeholders, hardcoded paths, or tmpdir.** Every path is a CLI arg
   or DATA_ROOT-relative. Runtime-generated orchestrator configs (e.g. nemo-run
   launch files) go to `$DATA_ROOT/<stage>/configs/`. Don't confuse those with
   the checked-in `config/default.yaml` — that's a static project file.
4. **Dry-run is default.** Stage signature: `dry_run: bool = True`. Actual
   work only fires when caller passes `dry_run=False`.
5. **W&B off by default.** Accept `wandb_project: str | None = None`. Only
   enable tracking when set.
6. **nemo-run inside the stage, not across stages.** Use
   `run.LocalExecutor` / `run.SlurmExecutor` inside `run_<stage>()`. No
   `run.Pipeline` composition — the CLI calls stage functions directly.

---

## Example: prep stage

Data-prep stages call library Python APIs directly:

```python
# stages/02_prep/run.py
from __future__ import annotations

import logging
from pathlib import Path

from nemotron.data_prep.api import run_sft_pipeline

log = logging.getLogger(__name__)


def run_prep(
    data: Path,
    output: Path,
    tokenizer: str = "nvidia/NVIDIA-Nemotron-Nano-9B-v2",
    pack_size: int = 4096,
    dry_run: bool = True,
    wandb_project: str | None = None,  # accepted for CLI uniformity; prep doesn't track
) -> None:
    """Pack training JSONL into Megatron-Bridge Parquet shards.

    Reads JSONL from ``data``, writes packed Parquet + splits manifest to ``output``.
    """
    del wandb_project  # prep does not emit W&B metrics
    if dry_run:
        print(
            f"Would pack {data} → {output} "
            f"(tokenizer={tokenizer}, pack_size={pack_size})"
        )
        return
    run_sft_pipeline(
        blend_path=data,
        output_dir=output,
        tokenizer=tokenizer,
        pack_size=pack_size,
    )
    log.info("Prep complete: %s", output)
```

Keep `tokenizer` and `pack_size` aligned with the downstream training stage —
see [../PATTERNS.md](../PATTERNS.md) first, then fall back to the live pattern
files only if their full bodies are needed.

---

## Example: training stage

Multi-GPU training needs a process launcher (torchrun) and lives behind
nemo-run's `Experiment` + `Script` abstraction. **Don't invent the nemo-run
API from memory.** The authoritative reference is the in-repo runner:

- [src/nemotron/steps/_runners/megatron_bridge.py](../../../../src/nemotron/steps/_runners/megatron_bridge.py) — used by sft/peft/pretrain Megatron-Bridge steps.
- [src/nemotron/steps/_runners/automodel.py](../../../../src/nemotron/steps/_runners/automodel.py) — used by AutoModel steps.
- [src/nemotron/steps/_runners/nemo_rl.py](../../../../src/nemotron/steps/_runners/nemo_rl.py) — used by all NeMo-RL alignment steps.

Mirror the runner's call shape; don't import recipe modules directly. Use
`nemotron.kit.recipe_loader.import_recipe_function` with a string target —
the live [src/nemotron/steps/sft/megatron_bridge/step.py](../../../../src/nemotron/steps/sft/megatron_bridge/step.py)
shows the exact pattern.

W&B for training is **not** configured through a nemo-run tracker. It's driven
by env vars and the patches in `nemotron.kit.wandb_kit` that the recipe script
loads. At the stage wrapper, set `WANDB_PROJECT` in the executor's env dict
when `wandb_project` is provided — don't call any tracker API.

---

## Handoff back

When finished, report to the main agent:

- Files written (paths).
- Config knobs exposed in `default.yaml` (top-block only).
- Any `# UPSTREAM:` comments added (library gap notes).
- Strategies followed (which `[[strategies]]` from `step.toml` you fired).
- Any deviations from the plan that the main agent should cross-check during Verify.
