# Simple MILP (C API)

Same as LP but `x1` is integer. Demonstrates variable types and MIP parameters.

**Build:** With cuOpt on `INCLUDE_PATH` and `LIB_PATH`:

```bash
gcc -I${INCLUDE_PATH} -L${LIB_PATH} -o milp_simple milp_simple.c -lcuopt
LD_LIBRARY_PATH=${LIB_PATH}:$LD_LIBRARY_PATH ./milp_simple
```

**See also:** [references/examples.md](../../references/examples.md) for full parameter reference.
