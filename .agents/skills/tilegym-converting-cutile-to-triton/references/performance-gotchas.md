# Performance Gotchas — 10-50× Regression Risk

**⚠️ These cause CATASTROPHIC slowdowns. Check BEFORE benchmarking.**

| Pattern | SLOW (Regression) | FAST (Optimized) | Impact |
|---------|-------------------|------------------|--------|
| **Memory access (2D+ tiles)** | Raw ptr + masks: `tl.load(ptr+offs, mask=m)` for block-shaped 2D+ loads | TMA: `tl.make_tensor_descriptor(...).load([off])` | **5-20x (500%-2000%)** — **most common cause of conversion regression; use TMA for every 2D+ tile load** |
| **Group iteration** | Linear search all groups per tile | While-loop with `last_problem_end` tracking | **2-5x** |
| **Tile sizes** | Fixed `BLOCK_M=128, BLOCK_N=128` | `@triton.autotune` with GPU-specific configs | **2-3x** |
| **Alignment** | No hints | `tl.assume(stride % 8 == 0)`, `tl.assume(ptr % 16 == 0)` | **1.5-2x** |
| **Full-tile masks** | Masks on every load/store | Remove masks, let TMA handle bounds | **1.2-1.5x** |
| **K-loop offsets** | Recalculate full offset each iter | `a_ptrs += BLOCK_K` or TMA offset increment | **1.1-1.2x** |
| **Memory layout** | 5D reshape for split dims | Transpose + contiguous first/second half | **50-150%** |
| **constexpr params** | Dynamic dimension params | Mark `bs`, `hd`, `n_h` as `tl.constexpr` | **10-20%** |
| **Unnecessary clones** | `q.clone()` before in-place op | Transpose → contiguous (natural copy) | **10-20%** |
| **Row stride pattern** | Per-element stride calculation | Row stride with `ptr + pid * row_stride` | **10-30%** |
| **broadcast_to + tl.dot** | `W.broadcast_to((BS,M,K))` then `tl.dot(W, X)` | 1-batch-per-block, load W as 2D `(M,K)`, use `tl.dot(W, X)` | **10-50×** (FFT case study) |
| **extract_slice chains** | Chain of `extract_slice` + `reshape` (24+ calls) | Direct offset computation, load into final shape | **2-5×** |

**Full details:** [../translations/workflow.md](../translations/workflow.md) — section **CRITICAL PERFORMANCE PATTERNS (AVOID 10-50x REGRESSION)**

Full API mapping: [api-mapping.md](./api-mapping.md).

Triton math dtype (erf/erfc/exp/log/sqrt) and the "don't substitute erf with tanh" pattern: [debugging.md](./debugging.md) — section **Triton Math Function Dtype Requirements (CRITICAL)**.

For the broader cuTile → Triton translation gotchas (mma, type cast, grid, layout flags, batched matmul, etc.), see [gotchas.md](./gotchas.md).
