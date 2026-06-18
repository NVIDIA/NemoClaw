# Context packs

Per-step extracts of upstream library documentation. Load these only after the
bundled catalog/run/artifact references have selected a step and an action
needs real library API detail.

## Lookup

[index.toml](index.toml) maps `(step_id, intent)` → pack file. The Act phase
reads this once and dispatches packs to per-stage sub-agents.

## Provenance

These packs are not the step catalog. For routing and normal execution, read:

- `../CATALOG.md`
- `../ARTIFACTS.md`
- `../COMMANDS.md`
- `../PATTERNS.md`
- `../HARDWARE.md`

Each `*.txt` file is a snapshot of upstream docs + selected source files from
one of:

| Pack file | Upstream | Env var (sanitized) |
|---|---|---|
| `mbridge-*.txt` | NVIDIA-NeMo/Megatron-Bridge | `$MBRIDGE_ROOT` |
| `automodel-*.txt` | NVIDIA-NeMo/Automodel | `$AUTOMODEL_ROOT` |
| `curator-*.txt` | NVIDIA-NeMo/Curator | `$CURATOR_ROOT` |
| `eval-*.txt` | NVIDIA-NeMo/Evaluator | `$EVALUATOR_ROOT` |
| `checkpoint-conversion.txt` | NVIDIA-NeMo/Megatron-Bridge / HF PEFT | `$MBRIDGE_ROOT`, `$HF_HOME` |
| `nemo-rl-alignment.txt` | NVIDIA-NeMo/RL | (linked via URL) |
| `curator-translation-faith.txt` | NVIDIA-NeMo/Curator | `$CURATOR_ROOT` |
| `modelopt-optimization.txt` | NVIDIA Model Optimizer | (linked via URL) |
| `data-designer-sdg.txt` | NVIDIA Data Designer | (linked via URL) |
| `nemotron-data-prep.txt` | NVIDIA-NeMo/Nemotron (this repo) | `$NEMOTRON_ROOT` |

These packs are curated summaries for agent grounding. They are intentionally
short and should point agents back to bundled references first, then to the
repo step manifest, config, runner, and active profile TOML for live verification.
