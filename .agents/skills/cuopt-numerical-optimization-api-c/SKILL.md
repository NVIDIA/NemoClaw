---
name: cuopt-numerical-optimization-api-c
version: "26.08.00"
description: LP, MILP, and QP (beta) with cuOpt — C API only. Use when the user is embedding LP, MILP, or QP in C/C++.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - cuopt
    - linear-programming
    - milp
    - qp
    - c-api
---


# cuOpt Numerical Optimization — C API

Solve LP, MILP, and QP problems via the cuOpt C API. The same library, headers, build pattern, and core calls (`cuOptCreate*Problem`, `cuOptSolve`, `cuOptGetObjectiveValue`) apply across all three; QP extends the API with quadratic-objective creation calls.

Confirm problem type and formulation (variables, objective, constraints, variable types) before coding.

This skill is **C only**.

## API Call Sequence

For LP/MILP, the ordered C entry points are: `cuOptCreateRangedProblem` (sense `CUOPT_MINIMIZE` / `CUOPT_MAXIMIZE`, CSR constraint matrix as `row_offsets` / `col_indices` / `values`, `var_types` char array using `CUOPT_CONTINUOUS` / `CUOPT_INTEGER` macros) → `cuOptSolve(problem, settings, &solution)` → `cuOptGetObjectiveValue(solution, &obj_value)` → matching `cuOptDestroy*` calls. Include `<cuopt/linear_programming/cuopt_c.h>`. Full ordered code with build instructions in [references/examples.md](references/examples.md).

## QP via C API (beta)

QP uses the same library, include/lib paths, and build pattern as LP/MILP — only the problem-creation call differs (it accepts a quadratic objective). See the cuOpt C headers (`cpp/include/cuopt/linear_programming/`) for the QP-specific creation/solve calls and the repo docs at `docs/cuopt/source/cuopt-c/lp-qp-milp/` for end-to-end QP examples.

**QP rules:**
- **MINIMIZE only** (`CUOPT_MINIMIZE`). To maximize `f(x)`, negate objective coefficients and Q entries.
- **Continuous variables only** — set `CUOPT_CONTINUOUS` for every variable; integer QP is not supported.
- **Q should be PSD** for a convex problem.

## Dual values (LP / QP)

`cuOptGetDualSolution` and `cuOptGetReducedCosts` return duals and reduced costs for **LP and QP**. They are not returned for a problem with quadratic constraints (the arrays are filled with `NaN`), so read them only when all constraints are linear. See [assets/lp_duals](assets/lp_duals/) for the call sequence.

## Debugging (MPS / C)

**MPS parsing:** Required sections in order: NAME, ROWS, COLUMNS, RHS, (optional) BOUNDS, ENDATA. Integer markers: `'MARKER'`, `'INTORG'`, `'INTEND'`.

**OOM or slow:** Check problem size (variables, constraints); use sparse matrix; set time limit and gap tolerance.

## Examples

- [examples.md](references/examples.md) — LP/MILP with build instructions
- [assets/README.md](assets/README.md) — Build commands for all reference code below
- [lp_basic](assets/lp_basic/) — Simple LP: create problem, solve, get solution
- [lp_duals](assets/lp_duals/) — Dual values and reduced costs
- [lp_warmstart](assets/lp_warmstart/) — PDLP warmstart (see README)
- [milp_basic](assets/milp_basic/) — Simple MILP with integer variable
- [milp_production_planning](assets/milp_production_planning/) — Production planning with resource constraints
- [mps_solver](assets/mps_solver/) — Solve from MPS file via `cuOptReadProblem`

For **CLI** (MPS files), use `cuopt_cli` and product docs.

## Escalate

For contribution or build-from-source, use product or repo documentation.
