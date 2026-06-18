# Assets — sample MPS files

Sample MPS files for use with `cuopt_cli`. Use as reference; do not edit in place.

| File | Type | Description |
|------|------|-------------|
| [lp_production](lp_production/) | LP | Production planning: chairs + tables, wood/labor |
| [milp_facility](milp_facility/) | MILP | Facility location with binary open/close |
| [lp_simple](lp_simple/) | LP | Minimal LP (PROD_X, PROD_Y, two constraints) |

**Run:** From each subdir or with path: `cuopt_cli lp_simple/sample.mps` (or `cuopt_cli production.mps`, etc.). See the skill for options (`--time-limit`, `--mip-relative-tolerance`, etc.).

## Test CLI

With conda env `cuopt` activated, from this `assets/` directory:

```bash
cuopt_cli lp_simple/sample.mps --time-limit 10
```

Use the same pattern for the other MPS files; for MILP, add e.g. `--mip-relative-gap 0.01`.
