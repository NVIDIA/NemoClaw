# MPS file solver (C API)

Read and solve LP/MILP from a standard MPS file using `cuOptReadProblem`.

**Build:** With cuOpt on `INCLUDE_PATH` and `LIB_PATH`:

```bash
gcc -I${INCLUDE_PATH} -L${LIB_PATH} -o mps_solver mps_solver.c -lcuopt
LD_LIBRARY_PATH=${LIB_PATH}:$LD_LIBRARY_PATH ./mps_solver data/sample.mps
```

**Data:** `data/sample.mps` is a small LP (two variables, two constraints). Use any MPS file path as the first argument.

**See also:** [references/examples.md](../../references/examples.md); repo example `docs/cuopt/source/cuopt-c/lp-qp-milp/examples/mps_file_example.c`.
