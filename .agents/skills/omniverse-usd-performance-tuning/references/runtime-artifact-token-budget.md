<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runtime Artifact Token Budget

Use this policy whenever a skill launches Kit, Asset Validator, Scene Optimizer,
Tracy, or any helper wrapper that can produce large stdout, stderr, logs, CSVs,
or traces.

## Default Rule

Keep large runtime artifacts on disk. Do not read, paste, or summarize full raw
logs or issue dumps into the agent context.

High-risk artifacts include:

- Kit launch stdout/stderr and extension startup logs.
- Asset Validator CSVs with one row per issue.
- Scene Optimizer `run.log`, verbose operation logs, and analysis payloads.
- Tracy CSV exports, `.tracy` captures, and frame/zone dumps.
- Any file that may contain thousands of rows, repeated prim paths, or stack
  traces.

## Preferred Read Order

1. Read compact structured artifacts first:
   - `<output_path>/setup-preflight.json`
   - validator `summary.json`
   - `summarize_csv.py` compact JSON output
   - operation `summary.json`
   - profile metric JSON
   - optimization report JSON
2. If raw context is still needed, read a bounded snapshot:
   - POSIX: `tail -n 80 <log>` or `sed -n '1,80p' <file>`
   - PowerShell: `Get-Content <path> -Tail 80` or
     `Get-Content <path> -TotalCount 80`
3. For targeted troubleshooting, search first, then show only nearby lines:
   - `rg -n "ERROR|WARN|failed|exception" <log>`
   - `rg -n -C 3 "<rule-or-prim>" <artifact>`

## Hard Limits

- Do not use live log streaming by default (`tail -f`, `Get-Content -Wait`).
  Poll bounded snapshots instead.
- Do not `cat` full `run.log`, `issues.csv`, Tracy CSVs, or Kit logs.
- Do not paste complete validator rows for every failing prim. Group by rule,
  severity, message, and count; show at most 10 example locations per rule in
  the initial report.
- Ask before expanding beyond the bounded snapshot, and explain the artifact
  size or row count.

## Stderr Production Guard

USD C++ libraries emit high-volume warnings to stderr (asset resolution failures,
diagnostic manager messages, load-time schema warnings). A single operation on a
large stage can produce hundreds of MB of repeated `_ReportErrors` lines.

Default cap: **50 MB** of stderr per subprocess invocation (configurable via
operation parameters).

### Procedure

1. **Before launch:** Set diagnostic-suppression environment variables on the
   subprocess:
   - `TF_LOG_SILENCE_PATTERNS=.*` (silences TfDiagnosticMgr warnings)
   - `AR_LOG_LEVEL=0` or equivalent (silences asset resolution chatter)
   - Only suppress when the operation does not need stderr diagnostics for its
     own correctness (i.e. the operation result is in files, not stderr).
2. Redirect subprocess stderr to `<output_path>/stderr.log`.
3. Poll file size (or use OS-level file size limits like `ulimit -f`).
4. On threshold breach (default: **50 MB**):
   a. Preserve the first 1 MB as `stderr.head.log`.
   b. Preserve the last 1 MB as `stderr.tail.log`.
   c. Truncate the main `stderr.log` to those samples.
   d. Decide: terminate the subprocess (if safe to retry with narrower scope)
      or continue with bounded capture (accept growth until exit).
   e. Emit a single structured warning to the operation log.
5. Never read `stderr.log` into agent context if it exceeds 5 MB. Use the
   head/tail samples only.

### Scope

Applies to:
- Scene Optimizer CLI / `run.py` invocations
- Kit / `kit --exec` script launches
- Standalone `python -m` USD processing scripts
- Any subprocess where `from pxr import ...` is in play

## User-Facing Reporting

Report paths and compact facts:

- Artifact directory.
- Summary JSON path.
- Log path.
- Row/rule counts.
- Top errors or failures.
- Next action.

Keep raw artifacts available for inspection, but make the default interaction a
small, reproducible summary rather than a transcript.
