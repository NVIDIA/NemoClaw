---
name: tao-validate-dataset-format
description: Run `tao-daft validate` to check NVIDIA TAO DAFT datasets for structure, schema, and cross-reference errors. Do
  not use for non-DAFT formats. Use when the user asks to validate a DAFT dataset, check DAFT schema, validate a TAO dataset
  format, or run `tao-daft validate`.
license: Apache-2.0
compatibility: Requires Python 3.10+ and the nvidia-tao-sdk package (pip install nvidia-tao-daft).
metadata:
  author: NVIDIA Corporation
  version: "1.0.0"
allowed-tools: Read Bash
tags:
- tao-daft
- dataset
- validation
- schema
---

# Validate a TAO DAFT Dataset

## Quick start

```bash
tao-daft validate <format> --path <dataset-or-parent-dir>
```

`<format>` is a positional subcommand (e.g. `metropolis-v3.0`, `cosmos-reason-v1.0`);
`--path` is required. Discover supported formats and per-format flags via
`tao-daft validate --help` and the leaf `--help` (see "CLI conventions" below).

## Preflight
```bash
python -c "import nvidia_tao_daft" 2>/dev/null || {
  echo "MISSING: tao-daft not installed. Run:"
  echo "  pip install nvidia-tao-daft"
  exit 1
}
```

## Quick Start

Discover the installed validator formats before choosing a format slug, then
run validation with the target passed through `--path`:

```bash
tao-daft --version
tao-daft validate --help
tao-daft validate <format> --help
tao-daft validate <format> --path /path/to/daft-dataset
```

## Purpose

Drive `tao-daft validate` against a DAFT dataset (or a tree of them).
The CLI is the spec; the skill picks subcommand + flags and explains
the result.

Trigger when the user mentions "TAO DAFT", "DAFT format", validating a
DAFT dataset, schema/cross-reference errors, or `tao-daft validate`.
Do **not** trigger for non-DAFT layouts (COCO, YOLO, Data Factory JSONL),
or for `tao-daft info` / `tao-daft convert` — those have their own skills.

If the user's opening is ambiguous, run a few `--help` commands first
to ground yourself, then come back and confirm the task.

## Prerequisites

- `nvidia-tao-daft` installed (`pip install nvidia-tao-daft`; the wheel
  is enough, no source repo). Confirm with `tao-daft --version`.
- A DAFT dataset, or a parent directory of them, on local disk.

## Instructions

### CLI conventions

`tao-daft` is nested argparse subcommands. Names and flags drift across
versions, so **discover the current surface from `--help`** rather than
trusting any list in this doc.

1. **Format is a positional subcommand**, not `--format`:
   `tao-daft validate <format> [flags]`. List current formats via
   `tao-daft validate --help`; slugs look like `metropolis-v3.0`,
   `cosmos-reason-v1.0`.
2. **Target is `--path PATH`**, not positional. It accepts a single
   dataset/scene or a parent directory — the validator walks the tree.
3. **Flags are per-format**; run the leaf help, e.g.
   `tao-daft validate metropolis-v3.0 --help`, before choosing them.
   Don't assume a flag from one format exists on another.

So the loop is: `tao-daft --version` → `tao-daft validate --help` →
pick format (infer if unspecified, see below) →
`tao-daft validate <format> --help` → run → interpret.

### Format inference

Use directory markers, not filenames:

- `meta.json` next to `media/` and `text/` ⇒ `cosmos-reason-v1.0`.
- A directory (or nested directories) containing `contextual/`,
  typically alongside `raw/` and `task/` ⇒ `metropolis-v3.0`.
- Neither marker present ⇒ ask the user; do not guess.

### Reading errors

The CLI ends every run with a `VALIDATION RESULTS` block, then
`✅ VALIDATION PASSED` or `❌ VALIDATION FAILED`, and exits non-zero on
failure (safe to chain in scripts).

Output can be large on big trees — capture the full output to a file
and read it in slices rather than scrolling inline.

## Limitations

- Validates DAFT only. Non-DAFT layouts (COCO, YOLO, Data Factory
  JSONL, etc.) belong in the upstream converter skills.
- Supported formats are whatever `tao-daft validate --help` reports
  for the installed version; older slugs may have been retired.
- Covers `validate` only. Defer to the dedicated skills for
  `tao-daft info` and `tao-daft convert`.
- Don't reimplement validation in Python; the CLI is the spec.

## Troubleshooting

- **`tao-daft: command not found`** — wheel not installed in the active
  env. `pip install nvidia-tao-daft`; verify `tao-daft --version`.
- **`error: argument --path is required`** — path passed positionally.
  Move it behind `--path`.
- **`invalid choice: '<format>'`** — slug isn't wired up in this
  version. Re-run `tao-daft validate --help` and pick from the list.
- **Auto-detection (raw type / contextual set) is wrong** — override
  via the format's scope-restriction flag; discover the name from the
  leaf `--help`.
- **CI wants warnings to fail** — add `--strict`.
