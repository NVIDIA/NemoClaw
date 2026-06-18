# Simple LP (C API)

Minimize `-0.2*x1 + 0.1*x2` subject to:
- `3*x1 + 4*x2 <= 5.4`
- `2.7*x1 + 10.1*x2 <= 4.9`
- `x1, x2 >= 0`

**Build:** From repo root or skill dir, with cuOpt on `INCLUDE_PATH` and `LIB_PATH`:

```bash
gcc -I${INCLUDE_PATH} -L${LIB_PATH} -o lp_simple lp_simple.c -lcuopt
LD_LIBRARY_PATH=${LIB_PATH}:$LD_LIBRARY_PATH ./lp_simple
```

**See also:** [references/examples.md](../../references/examples.md) for parameter constants and more examples.
