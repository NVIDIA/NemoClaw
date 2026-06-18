# MPS Solver Data

This directory contains MPS files for testing.

## Included Files

### air05.mps (MIPLIB Benchmark)

An airline crew scheduling problem from the MIPLIB benchmark library.

| Property | Value |
|----------|-------|
| Type | Binary Integer Program |
| Variables | 7,195 (all binary) |
| Constraints | 426 |
| Non-zeros | 52,121 |
| Known Optimal | 26,374 |

**Source**: https://miplib.zib.de/instance_details_air05.html

**Problem**: Given flight legs and possible crew pairings, find the minimum-cost
set of pairings that covers all flight legs (set covering problem).

## MPS File Format

MPS (Mathematical Programming System) is a standard format for LP/MILP problems.

### Sections

| Section | Purpose |
|---------|---------|
| NAME | Problem name |
| ROWS | Constraint and objective definitions |
| COLUMNS | Variable coefficients in each row |
| RHS | Right-hand side values for constraints |
| BOUNDS | Variable bounds and types |
| ENDATA | End of file marker |

### Row Types

| Type | Meaning |
|------|---------|
| N | Objective function (no constraint) |
| L | Less than or equal (≤) |
| G | Greater than or equal (≥) |
| E | Equality (=) |

### Bound Types

| Type | Meaning |
|------|---------|
| LO | Lower bound |
| UP | Upper bound |
| FX | Fixed value (lb = ub) |
| FR | Free variable (-∞ to +∞) |
| BV | Binary variable (0 or 1) |
| UI | Upper bound, integer |
| LI | Lower bound, integer |

## Adding Custom MPS Files

```bash
python model.py --file path/to/your/problem.mps
```

## Standard Test Problem Sources

- [MIPLIB](https://miplib.zib.de/) - Mixed Integer Programming Library
- [Netlib LP](https://www.netlib.org/lp/) - Classic LP test problems
- [NEOS](https://neos-server.org/neos/) - Network-Enabled Optimization System

## Creating MPS Files

cuOpt can export problems to MPS format:

```python
from cuopt.linear_programming.problem import Problem

problem = Problem("MyProblem")
# ... define variables, constraints, objective ...
problem.writeMPS("output.mps")
```
