---
name: cupynumeric-migration-readiness
description: Pre-migration readiness assessor for porting NumPy to cuPyNumeric. Use BEFORE substantial porting work begins when the user asks whether code will scale on GPU, whether they should migrate to cuPyNumeric, which NumPy patterns transfer cleanly, what must be refactored before porting, or mentions pre-port assessment, scaling analysis, or refactor planning. Inspect the user's source code, look up NumPy usage, cross-reference the cuPyNumeric API support manifest, and distinguish distributed-scaling-friendly patterns from blockers such as unsupported APIs, scalar synchronization, host round-trips, Python/object-heavy control flow, shape/data-dependent branching, and in-place mutation hazards. Produce a verdict of READY, LIGHT REFACTOR, SIGNIFICANT REFACTOR, or NOT RECOMMENDED, with concrete refactor pointers.
license: CC-BY-4.0 OR Apache-2.0
compatibility: Knowledge-driven assessment; no cuPyNumeric install required. Runtime claims target Linux x86_64/aarch64 with NVIDIA compute capability >= 7.0 and CUDA 12.x/13.x. Runtime validation is delegated to cuPyNumeric Doctor.
metadata:
  author: "NVIDIA Corporation <legate@nvidia.com>"
  version: "2.0.0"
  tags:
  - cupynumeric
  - legate
  - numpy
  - gpu
  - distributed-computing
  upstream: https://github.com/nv-legate/cupynumeric
  docs: https://docs.nvidia.com/cupynumeric/latest/
---

# cuPyNumeric Migration Readiness

## Purpose

**Use this skill BEFORE the migration, not during.** Answer one question: *which of the user's existing NumPy APIs will scale on cuPyNumeric, and which need refactoring, before they commit engineer-weeks to porting?* To answer it: read the source, classify each NumPy idiom by its expected multi-GPU scaling on the Legate/NVIDIA GPU stack, cross-reference the bundled API-support manifest, and produce a structured verdict with per-finding reasoning and recipe pointers.

**This is a static, read-only assessment.** Inspect the user's source with `Read`, `Grep`, and `Glob`. Do **not** execute the user's code, modify or write files, or print environment variables or secrets. The `legate`, and cuPyNumeric Doctor commands shown below are suggestions for the *user* to run — not actions this skill performs.

If this skill has never been seen before, head to [`references/getting-started.md`](references/getting-started.md) first.

## When to use this skill

Use when the user is **about to** migrate NumPy code to GPU and asks whether it will scale on cuPyNumeric / GPU, whether they should migrate, which parts will benefit, what must change before porting, or whether the port is worth it — or mentions pre-port assessment, scaling analysis, idiom analysis, GPU refactor planning, or identifying NumPy anti-patterns for GPU.

**Decline and redirect** when the request is *not* a pre-migration assessment:

- **Post-migration performance / profiling** ("already ported, why is it slow?") → point to `legate --profile` and the upstream [profiling and debugging](https://docs.nvidia.com/cupynumeric/latest/user/profiling_debugging.html) walkthrough.
- **Custom CUDA / kernel authoring** ("write/optimize a CUDA kernel")

A graph / sparse / ML / NLP  workload that the user *is* asking to migrate is still **in scope**: assess it and return **NOT RECOMMENDED** via Gate 4. That is a verdict, not a decline.

## Instructions

Run all five steps below, in order. Read the user's code and reason about it semantically; do not emit a one-shot prose verdict.

### Step 1 — Gather context

Elicit before scanning code. Each item below has a default tuned to the typical workload — use the default when the user does not volunteer specifics; do not block on questions.

- **Source location.** Default to the current working directory when no path is given.
- **Approximate hot-path array sizes at runtime.** Default to 30–50 million elements. Map the user's numbers (or this default) to the [Gate 2 tiers](references/decision-framework.md#gate-2-problem-size) (65K per-GPU floor; 10M+ for real single-GPU speedup; 100M+ for multi-GPU).
- **Target hardware.** Default to 1–4 GPUs, single-node. Confirm before assuming multi-node. For CPU-only runs, ask about RAM per node instead of FBMEM.
- **Dominant compute pattern.** Stencil / GEMM / Monte Carlo / reductions / mixed-with-SciPy. Ask the user to name it; otherwise infer it from the code in Step 3.

State the defaults you applied at the top of the assessment so the user can correct them. If a value is indeterminable, say so plainly and proceed with the qualitative-only assessment — do not fabricate numbers beyond the defaults above.

### Step 2 — Load the API support manifest

Read [`assets/api-support.md`](assets/api-support.md), the committed snapshot of the upstream NumPy-vs-cuPyNumeric comparison table. For each NumPy API the code calls, find its line and read the leading glyph:

- `✓✓ numpy.X` — implemented and works on multi-GPU (the best path).
- `✓ numpy.X` — implemented but single-GPU/CPU only (caveats multi-node).
- `🟡 numpy.X — <note>` — partial support; read the note.
- `✗ numpy.X` — not implemented on the cuPyNumeric distributed path. Behavior on call is version-specific (some unsupported APIs route through host NumPy, others raise an exception) — either way, hot-path use is a migration blocker. Do not promise users a silent fallback to host-NumPy.

If the `Fetched:` line is more than ~90 days old, refresh the snapshot — see the **Available Scripts** section.

### Step 3 — Read the code semantically

Walk the user's files with `Read` and `Grep` and classify each region of array math against [`references/idioms-that-scale.md`](references/idioms-that-scale.md) and [`references/idioms-that-block.md`](references/idioms-that-block.md) (full rationale and R-codes live there). Read semantically, not by regex: before flagging, confirm `arr` traces back to a `cupynumeric` array (or `np.*` aliased to it) and check whether the access sits inside a hot loop. Apply these rules:

- **Flag element loops** (`for i in range(n): arr[i] = ...`) as blockers; treat an epoch/step/file loop with a vectorized body as fine — distinguish the two.
- **Flag scalar sync** — `.item()` / `float()` / `int()` / `bool()` / `complex()` on a cuPyNumeric array inside a hot loop (per-iteration host sync); allow it at the boundary.
- **Flag reducing conditions** — `if`/`while` over an array reduction (`while np.max(err) > tol:`) syncs every iteration.
- **Flag hoistable allocation in a loop** as a fixable inefficiency.
- **Flag `mpi4py`** in runtime code that partitions/communicates array data alongside `cupynumeric` ([R108](references/idioms-that-block.md#r108)) — but first confirm it issues MPI calls on a hot path; ignore a grep hit in a README, build script, or alt-launcher.
- **Flag `order=`** on `reshape` / `asarray` / `flatten` as [R109](references/idioms-that-block.md#r109) — always, regardless of whether the version warns or silently no-ops.
- **Always cite [R304](references/idioms-that-scale.md#r304)** in INFO for `np.random.*` under multi-GPU: cross-GPU bit-identical reproducibility is impossible by default (`--gpus N` / `LEGATE_GPUS` is the [Legate launcher arg](https://docs.nvidia.com/legate/latest/manual/usage/running.html)).
- **Flag Python builtins on arrays** (`sum`/`max`/`min`/`any`/`iter(arr)`) — host-iteration fallback ([R110](references/idioms-that-block.md#r110); [upstream best practices](https://nv-legate.github.io/cupynumeric/user/practices.html#use-numpy-s-functions-avoid-using-python-s-built-in-functions)). Allow `len(arr)` (shape lookup; prefer `arr.shape[0]` / `arr.size` for 0-d safety).
- **Flag `cupy` mixed with `cupynumeric`** in a hot loop ([R111](references/idioms-that-block.md#r111)); the runtimes don't share GPU memory, so every hop goes through host NumPy.
- **Look up every NumPy API the code calls** in `assets/api-support.md` (glyph legend in Step 2).

For the deep "why," read [`references/gpu-stack.md`](references/gpu-stack.md) (memory, SM, communication, dispatch) and [`references/execution-model.md`](references/execution-model.md) (lazy execution, sync points, mapper).

### Step 4 — Produce a structured assessment

Deliver the report in this order. Cite `file:line` for every finding so the user can navigate.

1. **Verdict** in one sentence — see "Verdict framework" below.
1. **What works (SCALES findings)** — quote representative lines so the user sees what will speed up after the import swap.
1. **What blocks (BLOCKS findings)** — each tied to [`idioms-that-block.md`](references/idioms-that-block.md) and a recipe in [`refactor-recipes.md`](references/refactor-recipes.md).
1. **What's fixable (REFACTOR findings)** — group by recipe; one recipe often fixes many sites.
1. **Compatibility / cost notes (INFO findings)** — SciPy boundaries, single-GPU-only linalg / FFT, RNG layout vs `--gpus N`.
1. **API support gaps** — APIs the code calls that are unimplemented or single-GPU only per the manifest.
1. **Decision-framework summary** — Gates 1–6 from [`references/decision-framework.md`](references/decision-framework.md), marked pass / fail / uncertain.
1. **Recommended next steps** — which recipes to apply first, whether to port one module first, and when to involve cuPyNumeric Doctor.

**All 8 sections must appear**, even when the verdict is READY or NOT RECOMMENDED. Under an empty section write **"None for this code"** or **"n/a — see verdict"** in one line — do NOT omit the heading; the headings are the structural contract the report is graded on. See [`assets/sample_report.md`](assets/sample_report.md) for worked reports.

### Step 5 — Hand off to cuPyNumeric Doctor for runtime validation

Direct the user to run [cuPyNumeric Doctor](https://docs.nvidia.com/cupynumeric/latest/user/doctor.html) once they have applied the recipes and the code runs:

```bash
CUPYNUMERIC_DOCTOR=1 CUPYNUMERIC_DOCTOR_FORMAT=json CUPYNUMERIC_DOCTOR_FILENAME=doctor-report.json legate --gpus 1 main.py
```

cuPyNumeric Doctor catches at runtime what source review can miss (scalar item access, ndarray iteration, advanced indexing, `nonzero` misuse, `mpi4py` import, in-place ops on views). End the assessment at: "now run with cuPyNumeric Doctor enabled; here is what to look for in its output."

## Verdict framework

Assign the verdict **qualitatively**, from the *kinds* of findings, not a score:

| Verdict | When | Action |
|---|---|---|
| **READY** | No BLOCKS; few/no REFACTOR | Swap the import; benchmark |
| **LIGHT REFACTOR** | A few recipe-fixable patterns ([R201](references/idioms-that-block.md#r201)–[R206](references/idioms-that-block.md#r206)), or one or two simple BLOCKS | Apply 1–3 recipes from [`refactor-recipes.md`](references/refactor-recipes.md); re-walk to READY |
| **SIGNIFICANT REFACTOR** | Multiple BLOCKS in hot paths, or any [R108](references/idioms-that-block.md#r108) (`mpi4py`) — rewrites, not disqualifications | Real project; budget 1–3 engineer-weeks per module |
| **NOT RECOMMENDED** | Only two failures: Gate 2 (arrays below the 65,536 floor) or Gate 4 (wrong compute pattern). A pile of BLOCKS does *not* land here | Restructure first or use a different runtime |

Apply these in order; the first match wins:

1. **Gate 4 fails** (sparse / graph / ML / sequential / string) → **NOT RECOMMENDED**.
1. **Gate 2 fails** (hot-path arrays < 65,536 elements/GPU, no realistic batching path) → **NOT RECOMMENDED**.
1. **Any [R108](references/idioms-that-block.md#r108) (`mpi4py`)** → **SIGNIFICANT REFACTOR** (the parallelism-layer rewrite is the cost, not a disqualification).
1. **Multiple BLOCKS** ([R101](references/idioms-that-block.md#r101)–[R111](references/idioms-that-block.md#r111)) across hot paths → **SIGNIFICANT REFACTOR** (count does not escalate past this — each BLOCKS has a documented recipe).
1. **One or two recipe-fixable BLOCKS** (e.g., R101–R104 element-loop / sync) → **LIGHT REFACTOR**.
1. **Only REFACTOR patterns** (R201–R206) → **LIGHT REFACTOR**; recipes are mechanical.
1. **No BLOCKS, no REFACTOR** → **READY**.
1. **APIs missing from the manifest on the hot path** → demote one tier (SIGNIFICANT stays SIGNIFICANT, never NOT RECOMMENDED). Single-GPU-only APIs matter only for multi-node.

**Weigh the *kinds* of findings, not their count.** One R101 in a hot loop outranks ten R001s — it destroys the scaling the R001s would have delivered. Conversely a pile of BLOCKS + R108 is *still* SIGNIFICANT, not NOT RECOMMENDED — the tiers measure engineering cost, not despair. NOT RECOMMENDED requires a *size* or *compute-pattern* failure. Full framework: [`references/decision-framework.md`](references/decision-framework.md).

## What scales vs what blocks (at-a-glance)

- **SCALES** (keep as-is) — vectorized elementwise, reductions, matmul / einsum, `np.where`, large-per-GPU stencil slicing `arr[1:-1, 1:-1]`, `out=`, boolean-mask indexing.
- **BLOCKS** (remove before migration) — element loops, `np.vectorize`, `for row in arr`, `.item()/.tolist()/bool(arr)` in a hot loop, reducing `if`/`while` in a loop, `arr[::2]`, `dtype=object`, `mpi4py`, `order=`, `min/max/sum(arr)`.
- **REFACTOR** (apply a [recipe](references/refactor-recipes.md)) — alloc in a loop, `x = x + y` rebind in a loop, `vstack/hstack/concatenate` in a loop, `np.nonzero()` + indexing, view-mutation of `diag/flip/flatten`, `reshape` in a hot loop.
- **INFO** (cost note, not a blocker) — SciPy imports, single-device `linalg.qr/svd`, single-transform `fft.*`, size-thresholded `linalg.solve/cholesky`.

Full taxonomy in [`idioms-that-scale.md`](references/idioms-that-scale.md) and [`idioms-that-block.md`](references/idioms-that-block.md). Pass over silently any API the manifest doesn't list (out of scope of the upstream table — flagging it would be noise).

## Reading order

The canonical, read-in-order guide lives in [`references/getting-started.md`](references/getting-started.md#must-read-references-in-order) — read it once for orientation.

For a non-trivial assessment the must-reads are [`idioms-that-block.md`](references/idioms-that-block.md), [`refactor-recipes.md`](references/refactor-recipes.md), and [`decision-framework.md`](references/decision-framework.md); the rest ([`idioms-that-scale.md`](references/idioms-that-scale.md), [`gpu-stack.md`](references/gpu-stack.md), [`execution-model.md`](references/execution-model.md), [`partitioning-and-balance.md`](references/partitioning-and-balance.md), [`case-studies.md`](references/case-studies.md)) are read on demand.

## Limitations

- **Does not run cuPyNumeric.** No runtime required; this is the pre-port check. Actual speedup measurement happens after migration.
- **Does not auto-generate refactored code.** It identifies what to change and points to recipes; the user (or a follow-up agent) applies them.
- **Does not profile the workload.** For runtime measurement use `legate.timing.time()` and the upstream [profiling and debugging](https://docs.nvidia.com/cupynumeric/latest/user/profiling_debugging.html) guide.
- **Does not replace judgment.** Pattern matching misses implicit syncs inside logging, decorators that hide `.tolist()`, runtime-data-dependent partition mismatches. Read the source too, especially in borderline cases.

## Examples

A worked assessment of the bundled `assets/examples/` fixtures (an example, not a template):

> **Verdict: LIGHT REFACTOR.** `scales_well.py` translates cleanly; `needs_refactor.py` needs one allocation hoisted; `blocks_scaling.py` syncs every iteration via `.item()`.
>
> **What works:** `scales_well.py:23-31` (stencil R005), `:40-44` (reduction R002), `:18-22` (elementwise R001).
> **What blocks:** `blocks_scaling.py:51-58` ([R104](references/idioms-that-block.md#r104) — `.item()` in hot loop) → [RR-sync](references/refactor-recipes.md#rr-sync).
> **What's fixable:** `needs_refactor.py:21-28` ([R201](references/idioms-that-block.md#r201) — alloc in loop) → [RR-alloc](references/refactor-recipes.md#rr-alloc).
> **Next:** apply the recipes; re-walk to READY; enable `CUPYNUMERIC_DOCTOR=1` on the first real run.

The full worked report is in [`assets/sample_report.md`](assets/sample_report.md).

## Authoritative upstream references

- **Comparison table** (source for `assets/api-support.md`): https://nv-legate.github.io/cupynumeric/api/comparison.html (mirror, most current) / `.../latest/api/comparison.html` on docs.nvidia.com (canonical)
- **Best practices**, **Doctor**, **profiling**, **differences with NumPy**, **Legate launcher** — under https://docs.nvidia.com/cupynumeric/latest/ (`user/practices.html`, `user/doctor.html`, `user/profiling_debugging.html`, `user/differences.html`) and https://docs.nvidia.com/legate/latest/manual/usage/running.html
- **Source**: https://github.com/nv-legate/cupynumeric

## Available Scripts

| Script | Purpose | Arguments |
|---|---|---|
| `scripts/fetch_api_support.py` | Scrape the upstream comparison table into `assets/api-support.md`. Python stdlib only; standalone. | `--default-path` (write the committed `assets/api-support.md`); `--docs-nvidia-url` (use canonical `docs.nvidia.com` instead of the default GitHub Pages mirror) |

The user runs this to refresh the manifest (`python scripts/fetch_api_support.py --default-path`).

## Bundled references and assets

The `references/` files are enumerated under **Required reading order** above (R-code ranges: idioms-that-scale.md = R001–R007 / R301–R305; idioms-that-block.md = R101–R111 / R201–R206). Assets: `assets/api-support.md` (committed API snapshot, load in Step 2), `assets/sample_report.md` and `assets/examples/*.py` (worked report and fixtures).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Fetched:` line in the manifest > ~90 days old | Stale snapshot | Run `fetch_api_support.py --default-path` (user-run) |
| Manifest missing or scraper fails | Upstream HTML changed | `WebFetch` the [comparison table](https://nv-legate.github.io/cupynumeric/api/comparison.html) for that assessment |
| NOT RECOMMENDED for many fixable BLOCKS | Heuristics applied out of order | Re-apply order: Gate 4 → Gate 2 → R108 → BLOCKS → REFACTOR; weigh *kinds*, not count |
| Kernel authoring or post-migration profiling | Out of scope | Decline and redirect (see "When to use") — no verdict |
