---
name: cuopt-numerical-optimization-api-cli
version: "26.08.00"
description: LP, MILP, and QP (beta) with cuOpt — CLI only (MPS files, cuopt_cli). Use when the user is solving LP, MILP, or QP from MPS via command line.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - cuopt
    - linear-programming
    - milp
    - qp
    - cli
---



# cuOpt Numerical Optimization — CLI

Solve LP, MILP, and QP problems from MPS files via `cuopt_cli`. The same command, options, and MPS workflow apply across all three; QP uses the standard MPS quadratic-objective extension.

Confirm problem type and formulation (variables, objective, constraints, variable types) before coding.

This skill is **CLI only** (MPS input).

## Basic usage

```bash
# Solve LP or MILP from MPS file
cuopt_cli problem.mps

# With options
cuopt_cli problem.mps --time-limit 120 --mip-relative-tolerance 0.01
```

## Common options

```bash
cuopt_cli --help

# Time limit (seconds)
cuopt_cli problem.mps --time-limit 120

# MIP gap tolerance (stop when within X% of optimal)
cuopt_cli problem.mps --mip-relative-tolerance 0.001

# MIP absolute tolerance
cuopt_cli problem.mps --mip-absolute-tolerance 0.0001

# Presolve, iteration limit, method
cuopt_cli problem.mps --presolve --iteration-limit 10000 --method 1
```

## MPS format (required sections, in order)

1. **NAME** — problem name
2. **ROWS** — N (objective), L/G/E (constraints)
3. **COLUMNS** — variable names, row names, coefficients
4. **RHS** — right-hand side values
5. **BOUNDS** (optional) — LO, UP, FX, BV, LI, UI
6. **ENDATA**

Integer variables: use `'MARKER' 'INTORG'` before and `'MARKER' 'INTEND'` after the integer columns.

## QP via CLI (beta)

Quadratic objectives extend the standard MPS workflow — same `cuopt_cli` command, same options. Check `cuopt_cli --help` for QP-specific flags and the repo docs at `docs/cuopt/source/cuopt-cli/` for the quadratic-objective MPS format.

**QP rules:**
- **MINIMIZE only.** For maximization, negate the objective coefficients (and Q entries) in the MPS file.
- **Continuous variables only** — do not mix integer markers with quadratic objectives.

## Troubleshooting

- **Failed to parse MPS** — Check ENDATA, section order (NAME, ROWS, COLUMNS, RHS, [BOUNDS], ENDATA), integer markers.
- **Infeasible** — Check constraint directions (L/G/E) and RHS values.

## Examples

- [assets/README.md](assets/README.md) — Build/run for sample MPS files
- [lp_simple](assets/lp_simple/) — Minimal LP (PROD_X, PROD_Y, two constraints)
- [lp_production](assets/lp_production/) — Production planning: chairs + tables, wood/labor
- [milp_facility](assets/milp_facility/) — Facility location with binary open/close

## Getting the CLI

CLI is included with the Python package (`cuopt`). Install via pip or conda; then run `cuopt_cli --help` to verify.
