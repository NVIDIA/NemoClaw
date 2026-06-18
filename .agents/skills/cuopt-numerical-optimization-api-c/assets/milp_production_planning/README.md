# Production planning MILP (C API)

Two products (A, B), resource limits (machine time, labor, material), minimum production, maximize profit.

**Build:** With cuOpt on `INCLUDE_PATH` and `LIB_PATH`:

```bash
gcc -I${INCLUDE_PATH} -L${LIB_PATH} -o milp_production milp_production.c -lcuopt
LD_LIBRARY_PATH=${LIB_PATH}:$LD_LIBRARY_PATH ./milp_production
```

**See also:** [references/examples.md](../../references/examples.md) for parameters and MIP options.
