# Advanced Triton patterns (cuTile → Triton)

**Strategy hub:** For an ordered summary of this file plus [optimizing-reference.md](../references/optimizing-reference.md) (and a **mandatory Gemma FMHA checklist**), read **[references/optimization-strategy.md](../references/optimization-strategy.md)** first when converting attention or matching `gemma_attention`-class perf.

Patterns that are easy to miss in conversion but cause **large correctness or performance gaps**. Complements [translations/workflow.md](./workflow.md) (phases, TMA, autotune) and [SKILL.md](../SKILL.md) (checklist).

---

## 1. Dual layout flag (`transpose` / `transpose_v`): two kernels, not one + transposes {#dual-layout-flag}

**Applies to:** MLA-style decoding, attention variants, any op where the host exposes a boolean like `transpose=True/False` to match cuTile or framework layout.

### Failure mode (real case: MLA decoding)

| Benchmark slice | What you see |
|-----------------|--------------|
| `transpose=True` (e.g. small head counts in tests) | Converted kernel ≈ same ms as reference Triton |
| `transpose=False` | **Severe regression** (often **3–15×**, worse on fp8 / long `S_kv`) |

**Why:** The fast Triton baseline uses **different math and tensor layouts** per mode:

- **`transpose=False` (cache-friendly V along batch×seq):** Keep `qk` as **`[BLOCK_H, BLOCK_N]`**, softmax state **`l_prev` shape `[BLOCK_H]`**, `tl.max(qk, 1)`, `tl.sum(p, 1)`, and **`tl.dot(p, v, acc)`** with `p` already `[H, N]` and `v` `[N, D]` — one streamlined path.

- **`transpose=True` (V read with seq leading):** `qk` is **`[BLOCK_N, BLOCK_H]`** (e.g. `tl.dot(k, q)` with `q` as `[D, H]`), `l_prev` **`[BLOCK_N, BLOCK_H]`**, `V` needs a **separate TMA descriptor** (`shape=[S_kv, B, D]`, `strides=[stride_n, stride_b, 1]`, `block_shape=[BLOCK_N, 1, D]`) so the value load is not folded away or mis-coalesced — then **`tl.dot(v, p, acc)`** with transposed `v`/`p` (see `naive_absorb_mla_transpose` in the same file).

**Anti-pattern:** Implementing `transpose=False` by **reusing the transpose kernel’s structure** (e.g. forcing `l_prev` to `[BLOCK_N, BLOCK_H]`, transposing `qk` and `p` every KV block). That is **correctable** but **much slower** than the dedicated non-transpose kernel.

**Agent checklist:**

1. If cuTile or the PyTorch wrapper has **`transpose` (or equivalent)**, grep the Triton tree for **one** `@triton.jit` handling both — verify each branch uses the **same layout strategy** as the in-repo reference, not “transpose path + extra `tl.trans`”.
2. Add **two** `@triton.jit` kernels when the reference does (or split with `tl.constexpr` flags only if the compiler fully specializes — prefer two kernels for clarity and perf).
3. **Do not** pass fixed `BLOCK_H` / `BLOCK_N` from Python into `autograd.Function.forward` when the kernel is **`@triton.autotune`** — see §2.

---

## 2. Autotune + grid: `BLOCK_*` must come from `META`, not from the host

**Failure mode:** Host passes `BLOCK_H=16`, `BLOCK_N=128` into `apply()`, and launch uses `grid = (cdiv(heads, BLOCK_H), B)`. Autotune configs that use **64×128** or **128×128** never affect grid → **under-occupancy and wrong tuning** vs a baseline that uses:

```python
grid = lambda META: (triton.cdiv(num_head, META["BLOCK_H"]), B, 1)
# Launch kernel with that grid; pass tensor bases and META-sized BLOCK_* inside the kernel — not via apply().
```

**Rule:** For autotuned kernels, **`forward` should only pass dynamic shapes / strides / pointers**; tile sizes are **`tl.constexpr`** filled by autotune from `META`.

**Cross-check:** Run with `TRITON_PRINT_AUTOTUNING=1` and confirm the chosen config matches the problem key (`BLOCK_D`, `S_kv`, `EVEN_N`, etc.).

---

## 3. When to use host `TensorDescriptor` vs `tl.make_tensor_descriptor` in-kernel

TileGym’s `mla_decoding.py` uses **`tl.make_tensor_descriptor`** inside the JIT function with raw tensor bases + strides (plus `triton.set_allocator` for TMA metadata).

An alternate style (some LLM ports) builds **`triton.tools.tensor_descriptor.TensorDescriptor`** on the host when `sm >= 90` and passes descriptors into the kernel. That can be correct but:

- If you **freeze** tile sizes on the host descriptor to match **fixed** `BLOCK_H`/`BLOCK_N`, you **fight autotune** — either descriptors must be rebuilt per config (heavy) or you should use **in-kernel** `tl.make_tensor_descriptor` like `mla_decoding.py`.

**Preference for new conversions:** Align with **`mla_decoding.py`**: allocator + in-kernel descriptors + autotune + dual kernels for layout flags.

---

## 4. Quick diagnosis table

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| Good perf when `transpose=True`, terrible when `transpose=False` | Single “transpose-style” kernel + extra transposes / wrong `l_prev` shape | Add dedicated non-transpose kernel; match `naive_absorb_mla` layout |
| Autotune “does nothing” / grid too large | `BLOCK_H`/`BLOCK_N` from Python, not `META` | `lambda META: (cdiv(..., META["BLOCK_H"]), ...)`; drop fixed blocks from `apply()` |
| `transpose=True` wrong or slow on V | V shares K descriptor | Separate **V_desc** with seq-leading shape/strides (see `mla_decoding.py` comment on optimization-out) |

---

## 5. Batched kernel launch for multi-tensor ops

**Applies to:** `cat`, `stack`, `split`, multi-tensor copy/scatter operations.

When converting a cuTile kernel that processes multiple tensors (e.g., concatenation), **do not** naively launch one Triton kernel per tensor. Instead, batch up to 4 tensors per launch using a 2D grid:

```python
# Grid: (blocks_over_elements, num_tensors_in_batch)
grid = (triton.cdiv(max_elements, BLOCK), min(4, num_remaining_tensors))

# Kernel uses program_id(1) to select which tensor to process
pid_y = tl.program_id(1)
if pid_y == 0:
    in_ptr, size = in_ptr_a, size_a
elif pid_y == 1:
    in_ptr, size = in_ptr_b, size_b
# ...
```

**Impact:** 2–4× speedup for small-to-medium tensors (LLM KV-cache concatenation). Kernel launch overhead (~5–10µs per launch) dominates for small tensors; batching amortizes this cost.

**Full pattern and code:** See **§8 Batched Kernel Launch** in [references/optimizing-reference.md](../references/optimizing-reference.md).

---

## 6. Blackwell Optimization Patterns

For complex kernels targeting Blackwell (sm_100+), additional optimization patterns can yield **2–10× speedups**. These are documented in **[references/optimizing-reference.md §9](../references/optimizing-reference.md)** and include:

| Pattern | Impact | When to Use |
|---------|--------|-------------|
| TMA Descriptors | 20–50% | All 2D+ loads on triton DSL |
| Loop Unroll Control | 2–5× | Iterative algorithms (matrix inversion, recurrence) |
| Occupancy Autotuning | 1.5–3× | All kernels on Blackwell |
| TMEM-Friendly Blocks | 1.5–2× | Kernels with multiple `tl.dot` operations |
| Slab Allocator | 10–30% | Kernels with multiple intermediate buffers |
| Dual-Path Design | — | Cross-platform support (triton DSL + OpenAI Triton) |

**Key insight:** On Blackwell, register pressure from loop unrolling is often the #1 performance killer. Use `tl.range(..., loop_unroll_factor=1)` for loops with >16 iterations and complex bodies.

---

## 7. Reference implementations

- **MLA decoding with transpose flag:** Implement two separate `@triton.jit` kernels (`transpose=False` path and `transpose=True` path). The `transpose=False` path: `qk` as `[BLOCK_H, BLOCK_N]`, `l_prev` as `[BLOCK_H]`, `tl.dot(p, v, acc)`. The `transpose=True` path: separate V TMA descriptor with layout matching the transposed access pattern. See §1 above and [examples/05_attention/](../examples/05_attention/) for a worked example.

- **Cat (batched):** Original TileGym `cat` implementation (adapted from [FlagGems](https://github.com/FlagOpen/FlagGems)) demonstrates batched multi-tensor kernel launch. See `cat_copy_func_kernel_4` pattern or §8 of [references/optimizing-reference.md](../references/optimizing-reference.md).
