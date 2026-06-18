# LP duals and reduced costs (C API)

Retrieve dual values (shadow prices) and reduced costs after solving an LP.

**Problem:** Minimize 3x + 2y + 5z subject to x + y + z = 4, 2x + y + z = 5, x, y, z ≥ 0.

**Build:** With cuOpt on `INCLUDE_PATH` and `LIB_PATH`:

```bash
gcc -I${INCLUDE_PATH} -L${LIB_PATH} -o lp_duals lp_duals.c -lcuopt
LD_LIBRARY_PATH=${LIB_PATH}:$LD_LIBRARY_PATH ./lp_duals
```

**See also:** [references/examples.md](../../references/examples.md) for full parameter reference.
