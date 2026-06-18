---
name: tao-convert-dataset-format
description: Run `tao-daft convert` to convert NVIDIA TAO DAFT datasets between supported formats. Do not use for non-DAFT data.
  Use when the user asks to convert a DAFT dataset, change DAFT format, change a TAO dataset format, or run `tao-daft convert`.
license: Apache-2.0
compatibility: Requires Python 3.10+ and the nvidia-tao-sdk package (pip install nvidia-tao-daft).
metadata:
  author: NVIDIA Corporation
  version: "1.0.0"
allowed-tools: Read Bash
tags:
- tao-daft
- dataset
- conversion
- vlm
- cosmos-reason
---

# Convert a TAO DAFT Dataset

## Quick start

```bash
tao-daft convert <source-format> <target-format> --path <input> --output <output>
```

Source and target are positional subcommands; `--path` and `--output` are flags.
Discover the supported formats and per-pair flags from the leaf `--help`
(see "CLI conventions" below).

## Preflight
```bash
python -c "import nvidia_tao_daft" 2>/dev/null || {
  echo "MISSING: tao-daft not installed. Run:"
  echo "  pip install nvidia-tao-daft"
  exit 1
}
```

## Quick Start

Discover the installed CLI surface before choosing format slugs, then run the
leaf conversion command with explicit `--path` and `--output` flags:

```bash
tao-daft --version
tao-daft convert --help
tao-daft convert <source-format> --help
tao-daft convert <source-format> <target-format> --path /path/to/daft --output /path/to/converted
```

## Purpose

Drives `tao-daft convert` to transform a DAFT dataset (or a tree of
them) between supported formats. The CLI does the real work; the
skill picks the right source/target pair and flags, then explains the
result.

Trigger on: converting a DAFT dataset, packaging DAFT QA /
summarization / temporal tasks for VLM training, producing a
`meta.json`-style training set, or the command `tao-daft convert`. Do
**not** trigger for non-DAFT → DAFT conversion (COCO, YOLO, Data
Factory JSONL) — redirect to the upstream `nvidia-tao-daft` repo's
converter skills.

If the user opens ambiguously, run a few `--help` calls first.

## Prerequisites

- `nvidia-tao-daft` installed (wheel only, not the source repo).
  Confirm with `tao-daft --version`.
- A DAFT dataset, or a parent directory containing many, on local
  disk.

## Instructions

### CLI conventions

`tao-daft` is nested argparse subcommands. The conventions below are
stable across versions even when format names or flags change, so
**always discover the current surface from `--help`** rather than
relying on names this doc happens to mention.

1. **Source and target are both positional subcommands**, not
   `--from`/`--to`: `tao-daft convert <source> <target> [flags]`.
   Format slugs are versioned, lowercase, dot-separated
   (`metropolis-v3.0`, `cosmos-reason-v1.0`, ...).
2. **Path and output are flags** — `--path PATH` (source),
   `--output OUTPUT` (destination). Both required at the leaf;
   passing positionally fails.
3. **`--path` accepts both granularities** — a single scene/dataset
   or a parent directory; the converter walks the tree.
4. **Per-pair flags live at the leaf** — flag sets differ between
   targets (e.g. media-handling). Always check the leaf `--help`.

**Operating procedure:**

1. `tao-daft --version` — confirm install, pin version in any report.
2. `tao-daft convert --help` — list supported source formats.
3. `tao-daft convert <source> --help` — list valid targets for that
   source.
4. Infer source from layout (same directory markers as the
   `tao-validate-dataset-format` skill's "Format inference"). If you cannot infer
   or the target is unspecified, ask.
5. `tao-daft convert <source> <target> --help` — pick flags for the
   user's intent (task subset, media copy vs reference, metadata).
6. Execute, then interpret (see below).

### Reading output

Per-scene progress prints to stdout; non-zero exit on failure. The
converted dataset is written under `--output` — spot-check it with
the `tao-validate-dataset-format` skill before training. For large trees, capture
the full output and partial-read if huge.

## Limitations

- DAFT-supported source formats only. For non-DAFT layouts use the
  upstream repo's converter skills.
- Supported pairs are whatever `--help` reports for the installed
  version — don't pass an unconfirmed pair.
- Source and target are positional; `--path` / `--output` are flags.
- `convert` only — `validate` and `info` have their own skills.
- Do not reimplement conversion in Python; the CLI is the spec.

## Troubleshooting

- **`tao-daft: command not found`** — wheel not installed; `pip
  install nvidia-tao-daft`, verify with `tao-daft --version`.
- **`error: argument --path/--output is required`** — passed
  positionally; move behind the flag.
- **`invalid choice: '<format>'`** — slug not wired up in this
  version. Re-run the relevant `--help`.
- **Output rejected by `tao-daft validate`** — re-check per-pair
  flags (media handling, task subset) via leaf `--help`; a misset
  flag often produces a structurally valid but semantically wrong
  target.
