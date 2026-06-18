# Optimization strategy (cuTile → Triton)

**Purpose:** One-page strategy distilled from [translations/advanced-patterns.md](../translations/advanced-patterns.md) and [optimizing-reference.md](./optimizing-reference.md). Agents **must** apply this when converting **attention / FMHA / Gemma-style** kernels (e.g. `gemma_attention`) or any kernel where Triton is expected to match an optimized in-repo baseline.

**Full detail:** Use this file for *what to do and in what order*; open the two linked docs for proofs, code samples, and edge cases.

---

## When to read this (mandatory triggers)

| Trigger | Action |
|---------|--------|
| Converting **attention**, **FMHA**, **sliding window**, **soft cap**, or **GQA** (e.g. Gemma) | Read **§4 Gemma / FMHA checklist** below **before** writing the Triton inner loop. |
| Host exposes **`transpose` / `transpose_v`** or MLA-style layout modes | Read **§1** + [advanced-patterns §1](../translations/advanced-patterns.md#dual-layout-flag); use **two kernels**, not one + `tl.trans` in the KV loop. |
| Kernel uses **`@triton.autotune`** | Read **§2** + [advanced-patterns §2](../translations/advanced-patterns.md); grid **`lambda META: (...)`**; never freeze `BLOCK_*` from Python in a way that ignores autotune. |
| After TMA is in place but Triton still **>20% slower** than cuTile / baseline | Walk **§3** + [optimizing-reference](./optimizing-reference.md) sections 1–7 and §9 as applicable. |
| **10–50×** regression | [translations/workflow.md](../translations/workflow.md) — **CRITICAL PERFORMANCE PATTERNS** first (raw `tl.load` vs TMA). |

---

## §1 Layout flags → structure (from advanced-patterns)

- **Dual layout (`transpose` / `transpose_v`):** Implement **separate `@triton.jit` kernels** when math and TMA layouts differ per mode (MLA: `qk` `[H,N]` vs `[N,H]`, different `V` descriptor). Reusing the transpose path with extra `tl.trans` per KV block → **3–15×** on the other mode.
- **Autotune + grid:** `grid = lambda META: (triton.cdiv(..., META["BLOCK_M"]), ...)` — tile sizes come from **META**, not hard-coded `forward()` kwargs that bypass tuning.
- **Host `TensorDescriptor` vs in-kernel `tl.make_tensor_descriptor`:** If descriptors must track autotuned block sizes, use a **`pre_hook`** to set `block_shape` per config (see Gemma FMHA host side), or follow `mla_decoding.py` in-kernel style — do not freeze wrong tile sizes on the host.
- **Multi-tensor small ops:** Batched launch (`program_id(1)` selects tensor) — [optimizing-reference §8](./optimizing-reference.md), [advanced-patterns §5](../translations/advanced-patterns.md).

---

## §2 Post-TMA micro-optimizations (from optimizing-reference)

Apply in roughly this order after **all** 2D+ tile paths use TMA (or justified exceptions):

| Priority | Pattern | Impact (typical) | Pointer |
|----------|---------|------------------|---------|
| 1 | **Autotune breadth + backend/GPU split** — `get_available_triton_backend()`, `torch.cuda.get_device_capability()`, `num_stages`, `num_warps`, **`occupancy`**, `warp_specialize` where the stack supports it | **10–20%+** | [optimizing-reference §4](./optimizing-reference.md) |
| 2 | **EVEN_K / EVEN_*** heuristics — skip masks in inner loop when divisible | **5–15%** | §1 |
| 3 | **Transpose** — pointer/layout encoding; avoid **`tl.trans` inside the K/V loop** when avoidable | **5–15%** | §2 |
| 4 | **2D grid** for pointer BMM — `(num_mn_blocks, batch)` + grouped M for L2 | **0–10%** | §3 |
| 5 | **Epilogue subtile** (large TMA stores) | **5–15%** | §5 |
| 6 | **`tl.assume`** alignment on strides/pointers | **5–15%** | §6 |
| 7 | **Persistent vs non-persistent** + occupancy tuning | **10–30%** | §7, §9.3 |

**Blackwell / complex iterative kernels:** TMA descriptors, **`tl.range(..., loop_unroll_factor=1)`** for heavy loops, **TMEM-friendly** `tl.dot` blocks (often ≥32), slab allocator — [optimizing-reference §9](./optimizing-reference.md), [advanced-patterns §6](../translations/advanced-patterns.md).

---

## §3 Fast vs slow patterns (skill gotchas, condensed)

| Slow | Fast |
|------|------|
| Raw `tl.load(ptr+offs, mask=…)` for **block-shaped 2D+** tiles | **`tl.make_tensor_descriptor` / host `TensorDescriptor` + TMA load/store** |
| `broadcast_to` + `tl.dot` for batched matmul | One batch (or head) per program; **2D `tl.dot`** on real tiles |
| `qk = tl.zeros(...); tl.dot(q, k, qk)` when a fused dot exists | **`qk = tl.dot(q, k)`** (avoid redundant zero + 3-arg dot if the compiler path is worse) |
| Generic autotune for all GPUs/backends | **Separate config lists** for different backends and architectures; **sm_90 vs sm_120 vs sm_80** |
| Wrong TMA **logical shape** (e.g. K/V head dim = **H** when tensor is **H_kv**) | Descriptor **`shape` matches tensor rank sizes** for GQA: **`H // QUERY_GROUP_SIZE`** (or `num_head_kv`) on K/V |
| Always `libdevice.tanh` in hot path | Use fast tanh approximation where numerics allow (see `gemma_attention.py`) |
| Forcing **`.contiguous()`** on every forward | Only when required for TMA/strides; avoid extra copies |
| Autotune **key** missing `WINDOW_SIZE`, `SOFT_CAP`, `dtype` | **Include** keys that change optimal tile or specialization |

---

## §4 Gemma FMHA / `gemma_attention` conversion checklist (mandatory)

When converting or reworking **Gemma-style attention** (soft cap, sliding window, causal, GQA, BNSD), **do not stop at “correct TMA”** — apply these checklist items to match optimized Triton patterns:

1. **GQA TMA metadata:** `Q` / `Out` descriptors use `[B, H, S, D]`; **K** and **V** descriptors use **`[B, H // QUERY_GROUP_SIZE, S_kv, D]`** (same strides as the physical K/V tensor). Using **`H`** for the KV head dimension in the descriptor shape is a common bug and can hurt TMA behavior.
2. **Autotune:** `get_configs()` branches on **`get_available_triton_backend()`** and **`torch.cuda.get_device_capability()`** (e.g. **(12,0)/(12,1)** vs **(9,0)** vs **(8,0)**). Include **`occupancy`**, **`warp_specialize`**, **`num_stages`**, **`num_warps`** as in the reference — a single “SM ≥ 10 → 256×128” grid **misses** tuned Blackwell behavior.
3. **`@triton.autotune` `key`:** Include **`S_qo`, `S_kv`, `BLOCK_D`, `STAGE`, `QUERY_GROUP_SIZE`, `WINDOW_SIZE`, `SOFT_CAP`, `dtype`** (or equivalent) so different attention modes do not share one stale config.
4. **QK matmul:** Prefer **`qk = tl.dot(q, k)`** over explicit **`tl.zeros` + `tl.dot(q, k, qk)`** unless profiling shows otherwise.
5. **Soft cap:** Preserve **scale order** (tanh on logits in **original scale**, then align with **`INV_LOG_2`** / `exp2` softmax). Use fast tanh when supported by the backend (guard with a feature-detection flag).
6. **Inner loop:** `offs_m` / `offs_n` as **`tl.constexpr`** where the reference does; **`tl.max(qk, 1)`** / **`tl.sum(p, 1)`** axis consistent with layout.
7. **Host:** `triton.set_allocator` for TMA metadata; **`pre_hook`** updates descriptor **`block_shape`** for each autotune config. Avoid unconditional **`.contiguous()`** on Q/K/V unless needed.
8. **Prune configs:** For causal **`STAGE == 3`**, enforce **`BLOCK_M % BLOCK_N == 0`** if the algorithm requires it (see reference `prune_invalid_configs`).

After implementation, run the same **pytest + perf gates** as in [SKILL.md](../SKILL.md) mandatory completion checklist.

---

## Cross-references

| Document | Role |
|----------|------|
| [translations/advanced-patterns.md](../translations/advanced-patterns.md) | Dual kernels, autotune+META, descriptor vs autotune, diagnosis table |
| [optimizing-reference.md](./optimizing-reference.md) | EVEN_K, transpose, grid, autotune, epilogue, alignment, persistent, batched launch, Blackwell §9 |
| [translations/workflow.md](../translations/workflow.md) | Phases, TMA gate, catastrophic regression section |
| [SKILL.md](../SKILL.md) | Master checklist; must link **optimization-strategy** for attention conversions |
