# File Structure & Registration (cuTile → Triton)

Where to place Triton files when converting from cuTile. Inverse of the Triton→cuTile layout.

---

## Directory Structure

### Standard Mode (Directory-Based)

When converting **from** cuTile **to** Triton, create Triton files under the `triton/` mirror of the cuTile path.

There are two top-level layouts depending on whether the op is a first-party TileGym op or an external-framework suite:

```
TileGym/
├── src/tilegym/
│   ├── ops/                        # First-party TileGym ops (fmha, matmul, softmax, …)
│   │   ├── triton/
│   │   │   ├── add.py              # Triton (target of c2t conversion)
│   │   │   ├── softmax.py
│   │   │   └── layer_norm.py
│   │   └── cutile/
│   │       ├── add.py              # Existing cuTile (source)
│   │       ├── softmax.py
│   │       └── layer_norm.py
│   └── suites/                     # External-framework suites
│       └── <framework>/            # e.g. unsloth, flashinfer
│           ├── triton/
│           │   └── <op>.py         # Triton conversion target
│           └── cutile/
│               └── <op>.py         # Existing cuTile source
└── tests/
    ├── ops/
    │   └── test_<op>.py            # Tests for ops/ kernels
    └── suites/
        └── <framework>/
            └── test_<op>.py        # Tests for suites/ kernels
```

**Path derivation:**

```bash
# ops/ kernel: swap /cutile/ → /triton/
CUTILE_PATH="src/tilegym/ops/cutile/softmax.py"
TRITON_PATH="${CUTILE_PATH//\/cutile\//\/triton\/}"
# → src/tilegym/ops/triton/softmax.py

# suites/ kernel: same rule
CUTILE_PATH="src/tilegym/suites/<framework>/cutile/<op>.py"
TRITON_PATH="${CUTILE_PATH//\/cutile\//\/triton\/}"
# → src/tilegym/suites/<framework>/triton/<op>.py

mkdir -p $(dirname $TRITON_PATH)
```

---

## Registration Patterns

Same as the Triton→cuTile skill: register implementations by backend.

```python
from tilegym.backend import register_impl

@register_impl("op_name", backend="triton")
def op_triton(...):
    ...

@register_impl("op_name", backend="cutile")
def op_cutile(...):
    ...
```

Tests typically parametrize over `backend=["triton", "cutile"]` so both are exercised.

---

## Multi-Agent / Two-Step Workflow

| Step | Purpose |
|------|---------|
| **Step 1: Convert** | cuTile → Triton conversion |
| **Step 2: Perf** | Performance testing & comparison (Triton vs cuTile) |

Default: run both steps unless the user asks only for conversion or only for perf.

---

## Common Pitfalls

- **Wrong path:** Putting the new Triton file in `cutile/` instead of `triton/`.
- **Leftover cuTile imports:** Removing `import cuda.tile as ct` and all `ct.*` usage in the new Triton file; use `import triton.language as tl` and `triton.jit` only.
- **Launch style:** Using `ct.launch(stream, grid, kernel, args)` in the Triton host; must use `<code>kernel［grid］(launch_args)</code>` and `triton.cdiv` for grid.
