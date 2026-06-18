# Evaluation

## When to Use
- The user wants to measure RAG pipeline quality.

- User asks about accuracy, relevancy, groundedness, or recall metrics.

- The user wants to run the filesystem benchmark evaluator (`scripts/eval/evaluate_rag.py`) with `corpus/` plus `train.json`.

## Process
1. Read `docs/evaluate.md` for full evaluation methodology and setup.
2. Choose the path:
   - `Notebooks` — interactive RAGAS workflows against a running stack.
   - `CLI benchmark` — on-disk datasets and `evaluate_rag.py`; follow skill `rag-eval` (`skills/rag-eval/SKILL.md`), `scripts/eval/README.md`, and the skill’s `references/` for conversion, flags, runs, and result parsing.
3. Run evaluation against the deployed RAG pipeline.

When building a CLI eval bundle from a public benchmark, materialize `corpus/` as PDF when you can (multimodal content keeps images embedded; matches default `--file-type pdf`). If the source only provides web links or no file extension, default to PDF rather than plain text. Details: `rag-eval` → [`references/dataset-and-conversion.md`](../../../rag-eval/references/dataset-and-conversion.md) and `scripts/eval/README.md`.

## Agent-Specific Notes
- Uses RAGAS framework for all metrics
- Answer Accuracy, Context Relevancy, and Groundedness are covered in one notebook
- Recall is measured separately at top-k cutoffs (1, 3, 5, 10)
- `evaluate_rag.py` ingests `corpus/`, queries `/v1/generate`, then runs RAGAS NVIDIA metrics (`ragas.metrics`); requires `NVIDIA_API_KEY`. Install CLI deps with `uv sync --project scripts/eval` (declared under `scripts/eval/`).

## Notebooks
| Notebook | Metrics |
|----------|---------|
| `notebooks/evaluation_01_ragas.ipynb` | Answer Accuracy, Context Relevancy, Groundedness |
| `notebooks/evaluation_02_recall.ipynb` | Recall at top-k cutoffs |

## CLI benchmark (repo)
| Artifact | Role |
|----------|------|
| `scripts/eval/evaluate_rag.py` | End-to-end ingest + generate + RAGAS scoring for one or more dataset roots |
| `scripts/eval/pyproject.toml` | Dependencies for the CLI only; sync with `uv sync --project scripts/eval` |
| `scripts/eval/README.md` | Dataset contract, flags, outputs |
| `skills/rag-eval/SKILL.md` | Router: layout, `train.json`, run/triage playbook |
| `skills/rag-eval/references/dataset-and-conversion.md` | External → `corpus/` + `train.json` |
| `skills/rag-eval/references/benchmark-execution.md` | Command examples, quality flags, errors, credential hygiene |
| `skills/rag-eval/references/evaluate-rag-cli.md` | Flag-level CLI detail |
| `skills/rag-eval/references/result-analysis.md` | Parsing summaries and metrics JSON |

## Source Documentation
- `docs/evaluate.md` — full evaluation guide and metric definitions
- [RAGAS documentation](https://docs.ragas.io/en/stable/)
- [NVIDIA RAGAS metrics](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/nvidia_metrics/)
