# Step-by-Step Workflow

## Adding Autotune to a New Kernel

1. **Classify the kernel** using the decision tree above.
   - *VERIFY*: You know whether this is occupancy-only or requires tile-size tuning.

2. **Remove hardcoded hints from decorator** (strongly recommended): If the kernel currently has hardcoded hints in its decorator (e.g. `@ct.kernel(occupancy=2, num_ctas=1)`), **remove those fixed hints** and change to bare `@ct.kernel` before adding autotuning. While `replace_hints` does correctly override decorator values at runtime, leaving them creates a silent fallback trap: if any code path (e.g., `DISABLE_AUTOTUNE`, error handling, or a future refactor) skips `replace_hints`, the decorator's fixed hints are used instead of the autotuned values — and this produces no error, just silently worse performance. Removing them makes the failure mode explicit (missing hints → compiler defaults) rather than silent (wrong fixed hints used).
   - *VERIFY*: The `@ct.kernel` decorator has no `occupancy=` or `num_ctas=` arguments before proceeding. Use bare `@ct.kernel` instead.

3. **Check for in-place writes**: If the kernel modifies input tensors in-place, you MUST use the split-buffer pattern during `exhaustive_search` — see Pitfall #1.
   - *VERIFY*: Either the kernel is not in-place, or you have added a split-buffer scratch tensor for the search phase.

4. **Select the template** from [`kernel-type-templates.md`](kernel-type-templates.md) based on kernel type.

5. **Design the search space** following [`parameter-space-design.md`](parameter-space-design.md):
   - **Start from reference configs**, not from scratch. Clone configs from existing production kernels of the same type (e.g., `ops/cutile/matmul.py` for GEMM) and adapt. For GEMM-class kernels, `nvMatmulHeuristics` can suggest 8-16 high-quality candidates that reach 96-99% peak performance — see [`parameter-space-design.md`](parameter-space-design.md) for details.
   - Detect the current GPU architecture with `torch.cuda.get_device_capability()`.
   - **Target one architecture at a time.** Generate configs only for the detected arch. Do NOT add branches for other architectures — they cannot be tested on this machine and untested code paths are unreliable. If multi-arch support is needed later, add it in a separate pass on the appropriate hardware.
   - **When modifying code that already has autotune configs**: see "Handling Existing Autotune Configs (Multi-Architecture)" below. The "do NOT add branches" rule means do not *invent new configs* for untested architectures — it does NOT mean remove existing configs that were previously validated.
   - Identify tunable parameters (tile sizes, occupancy, num_ctas)
   - **Ensure the search space includes the original fixed config** (or an equivalent). This guarantees that the autotuned result is at least as good as the original — no performance regression is possible.
   - If the generated set exceeds 30, apply tile size filters and pruning rules to reduce it to ≤ 30 in the final code
   - *VERIFY*: Total configs in final code ≤ 30 (CuTile compilation is heavy, >30 configs will timeout). Temporary directed probes during development (30–100 configs, run via `bash + python3 -c`) are allowed — see Design Philosophy.

6. **Implement** the tune-once/cache/launch pattern:
   - Define a `_cache` dict at module level
   - Define a cache key that captures all parameters affecting optimal config (shapes, dtypes, device, any flags like `is_causal`). **⚠️ Use `str(x.device)` not `x.device`** in the cache key — `torch.device` objects are not reliably hashable and can cause `TypeError: unhashable type` at runtime. Always convert to string: `cache_key = (..., x.dtype, str(x.device))`. **Tip**: For GEMM-class kernels, round dimensions to the next power of 2 in the cache key (e.g., `cache_key = (next_pow2(M), next_pow2(N), next_pow2(K), dtype, str(device))`) to reduce unique key count and avoid re-tuning for similar shapes.
   - Call `exhaustive_search(list(configs), ...)` only when cache misses
   - Store `result.best.config` in cache
   - Use `kernel.replace_hints(...)` to create the tuned kernel variant
   - Use `ct.launch()` for the actual kernel invocation
   - `grid_fn` correctly computes grid from config
   - `args_fn` passes all kernel arguments including tile sizes as `ct.Constant[int]`
   - `hints_fn` passes `occupancy` and/or `num_ctas` from config
   - *VERIFY*: `exhaustive_search` receives a `list()` of configs, not a raw generator.

7. **(Optional) Add DISABLE_AUTOTUNE support** for CI and profiling: check `os.environ.get("DISABLE_AUTOTUNE", "0") == "1"` — when set, skip `exhaustive_search` entirely and fall back to `ct.launch` with the first valid config. Useful for:
   - CI determinism (autotune adds variable wall time)
   - NCU profiling (prevents autotune trial runs from cluttering the trace — see Pitfall #4)
   - Debugging (isolates kernel correctness from autotune behavior)
   Skip this step if your task only requires adding autotuning and the project's tests don't check for `DISABLE_AUTOTUNE`.

8. **Test**: Run correctness tests first (`pytest -k "test_op and cutile"`), then benchmark.
   - *VERIFY*: Correctness passes with autotune enabled AND with `DISABLE_AUTOTUNE=1`.

9. **Validate with A/B test**: Compare autotune version vs fixed best-known config. See [`search-strategies.md`](search-strategies.md) for methodology.
   - *VERIFY*: Autotune version ≥ baseline (or within noise). If worse, check that the search space includes the original fixed config, and that `replace_hints` is being used correctly.

10. **Shrink the search space** — reduce compilation cost without losing performance.

    Templates provide broad search spaces as a starting point (e.g., 9 configs for varlen attention). Not all configs contribute to finding the optimal one — on a given architecture and kernel shape, many large-tile or multi-CTA configs compile for seconds each but are never selected. The goal of this step is to *prune the dead weight* so the final committed code has 5–8 configs per architecture instead of 10–15.

    **Why this matters**: Each config in `exhaustive_search` requires a full JIT compilation + warmup + benchmark of the kernel. For complex kernels (FMHA, varlen attention), this costs 2–4 seconds *per config*. Cutting from 9 to 5 configs saves 8–16 seconds of one-time autotuning cost per unique shape, with zero performance loss.

    **Procedure**:

    1. After Step 9 passes, you already have a working autotuned kernel with the full template search space. Now run the test on 2–3 representative shapes and observe which config wins for each shape. You can inspect this by temporarily adding a print inside the cache-miss block:
       ```python
       print(f"[autotune] shape={cache_key[:5]} best={result.best.config} "
             f"time={result.best.time_ms:.3f}ms  "
             f"configs_tried={len(result.successes)}")
       ```

    2. Identify which configs are *competitive* — within 5% of the best for at least one shape. Configs that are never within 5% of the best across any test shape are *dead weight*.

    3. Remove dead-weight configs from the generator. Always keep:
       - The original fixed config (safety net — guarantees no regression)
       - The config(s) that won on each test shape
       - Any config within 5% of a winner (may win on untested shapes)

    4. Re-run the test to confirm speedup is unchanged after pruning.

    **Common dead-weight patterns** (prune these first):
    - `TILE_M=256` configs for attention/varlen kernels where `S_qo` in the test shapes is ≤ 4096 and batch×heads is large — the grid is already saturated at TILE_M=128.
    - `num_ctas=2` configs for kernels with irregular or small grids — multi-CTA parallelism requires enough CTAs to benefit from cooperative launch, which doesn't hold when `grid[0]` is small.
    - `occupancy=4` or `occupancy=8` configs on sm100+ for compute-bound kernels — Blackwell typically prefers lower occupancy (1–2) with larger tiles.

    **Target**: ≤ 8 configs per architecture branch in the final code. This keeps the one-time tuning cost under 25 seconds even for the most complex kernels (FMHA, varlen attention).

    - *VERIFY*: Config count ≤ 8 per architecture. `speedup_over_fixed` unchanged after pruning.

11. **(MANDATORY) Verify correctness and performance before finalizing.**

    The verification requirements depend on the task type. In ALL cases, start with the code-level sanity check, then apply the task-specific verification.

    ---

    **A. Code-level sanity check (ALL tasks — do this first)**

    Review your implementation for known performance anti-patterns. These checks catch *implementation bugs*, not algorithmic issues — they apply regardless of whether you are adding, modifying, or fixing autotune code.

    - `replace_hints` must be called *exactly once* per config and the returned kernel object cached (Pitfall #7). If `replace_hints` appears on the hot path (outside the `if cache_key not in` block), you have a recompilation bug that causes 100-500× slowdown.
    - `exhaustive_search` must be inside the cache-miss block, not called on every kernel invocation.
    - The fast path should only do: cache lookup → `ct.launch` with the cached tuned kernel. No JIT-triggering calls in between.
    - The cache must store `(best_cfg, tuned_kernel)` together — not just `best_cfg` alone.

    ---

    **B. Task-specific verification**

    **B1. Adding or modifying autotune configs** (the original code is correct):

    - *Correctness*: autotuned kernel output matches the reference (e.g. `torch` or fixed-config kernel) within tolerance.
    - *Performance*: autotuned kernel must be *at least as fast* as the original fixed-config kernel. If it is slower:
      - Check that the search space includes the original fixed config (this guarantees no regression).
      - Check if `replace_hints` is being called on every code path — revisit Step 2 (if any path skips `replace_hints`, the decorator's fixed hints are used instead of autotuned values).
      - Expand search space if all configs perform similarly (see `references/parameter-space-design.md` → "Adapting Search Space").

    **B2. Fixing a correctness bug** (the original code produces wrong results):

    - *Correctness is the primary goal*: the fixed kernel must produce correct results. Do NOT compare speedup against the broken original — a correct-but-slower kernel is always better than a fast-but-wrong one.
    - *Perf sanity check*: after fixing, verify that the implementation is not catastrophically slow due to an implementation bug (e.g. Pitfall #7). Two ways to check:
      1. *Code review*: confirm the code-level sanity check (Section A above) passes — this catches the most common perf bugs.
      2. *Runtime check*: if possible, compare your fixed+autotuned kernel against a simple correct baseline (e.g. the equivalent `torch` operation, or the kernel launched with a single hardcoded config and no autotuning). Your autotuned version should not be slower than this naive baseline. Minor overhead from the fix itself (e.g. split-buffer allocation) is acceptable.

    ---

    *⚠️ Autotuning bugs (silent hint override, split-buffer omission, hot-path recompilation) are only caught at runtime — always verify by running the kernel, not just by reading the code.*

## Handling Existing Autotune Configs (Multi-Architecture)

When adding autotune to a kernel, the source code may already contain autotune configs from a previous pass on different hardware. There are three scenarios:

**Scenario 1: No existing autotune code.** The source has no autotune at all — follow the standard "Adding Autotune to a New Kernel" workflow above. Generate configs for the current GPU architecture only.

**Scenario 2: Existing autotune, but no config for the current architecture.** The source already has autotune with configs for other architecture(s) (e.g., sm103) but NOT for the current GPU (e.g., sm100). Steps:

1. Detect the current architecture with `torch.cuda.get_device_capability()`.
2. Check whether the existing config generator already uses architecture-conditional branching (i.e., `if/elif` on device capability).
   - **If yes** (conditional yield structure exists): Add a new `elif` branch for the current architecture. Preserve all existing branches **unchanged** — do not modify their config values.
   - **If no** (flat configs, no architecture branching): Add an `if` branch for the current architecture with new configs, and keep the existing flat configs in the `else` block as the default fallback. This ensures that all other architectures continue to use the original configs unchanged — the code modification must not alter kernel behavior on any architecture other than the current one.
3. Design configs for the current architecture following the standard workflow (Steps 4–10 above).
4. Validate only the current architecture's configs (Step 11). Other branches are assumed correct since they were previously validated on their respective hardware.

Example — adding sm100 to a generator that already has sm103 configs (conditional structure exists):

```python
def _my_autotune_configs():
    gpu_capability = torch.cuda.get_device_capability()

    if gpu_capability == (10, 0):                   # sm100 (B200)
        # NEW: configs for sm100 (added in this pass)
        for occ in [1, 2, 4]:
            yield SimpleNamespace(occupancy=occ, TILE_M=128, TILE_N=128)
    elif gpu_capability == (10, 3):                  # sm103 (GB300)
        # EXISTING: configs for sm103 (do NOT modify)
        for occ in [2, 4, 8]:
            yield SimpleNamespace(occupancy=occ, TILE_M=256, TILE_N=128)
    else:
        # Fallback for unknown architectures
        yield SimpleNamespace(occupancy=2, TILE_M=128, TILE_N=128)
```

Example — adding current-arch configs to flat (non-branching) code:

```python
# BEFORE: flat configs (no architecture branching)
def _my_autotune_configs():
    for occ in [2, 4, 8]:
        yield SimpleNamespace(occupancy=occ, TILE_M=256, TILE_N=128)

# AFTER: if-branch for current arch, original configs become the else-default
def _my_autotune_configs():
    gpu_capability = torch.cuda.get_device_capability()

    if gpu_capability == (10, 0):                    # sm100 (B200) — current arch
        # NEW: configs designed and tested for sm100
        for occ in [1, 2, 4]:
            yield SimpleNamespace(occupancy=occ, TILE_M=128, TILE_N=128)
    else:
        # UNCHANGED: original flat configs as default for all other architectures
        for occ in [2, 4, 8]:
            yield SimpleNamespace(occupancy=occ, TILE_M=256, TILE_N=128)
```

**Scenario 3: Existing autotune with config for the current architecture.** The source already has a conditional branch for the current GPU architecture. Only modify the current architecture's branch (e.g., adjust tile sizes, add/remove occupancy values). Do **NOT** modify or remove configs for other architectures.

**Key principles:**

- **"Target one architecture at a time" means only *add or modify* configs for the detected arch** — it does NOT mean delete existing configs for other architectures. Existing configs were validated on their respective hardware and must be preserved.
- **When adding architecture branching to flat configs**: add an `if` for the current architecture and keep existing configs in the `else` as the default. This guarantees that the code change does not alter kernel behavior on any non-current architecture — the `else` path is identical to the original flat code.
- **Test/validation (Step 11) only applies to the current architecture's branch.** Other branches are assumed correct since they were previously validated on their respective hardware. You cannot test them here because you don't have access to that hardware.

## Integration with torch.autograd.Function

When the kernel is used inside a `torch.autograd.Function`:
- Place the tune-once/cache/launch logic in `forward()` only. The cached config is reused across calls.
- In `backward()`, using `ct.launch` with a fixed or cached config is often sufficient. However, if backward has its own independent search space (e.g. grouped GEMM dX and dW have separate optimal configs), autotuning is appropriate there too.
- Example: `rope_embedding.py` — forward uses `exhaustive_search` + cache with split-buffer, backward uses `ct.launch` with same-buffer (Q_in=Q_out).

## Cross-Backend Config Transfer (Triton → CuTile)

Use `src/tilegym/autotune.py`: maps `BLOCK_SIZE_M/N/K` → `TILE_SIZE_M/N/K`; `num_warps`/`num_stages` have no CuTile equivalent.

## Optimizing an Existing Autotune Config

1. **Profile first**: Use NCU (set `DISABLE_AUTOTUNE=1`).
2. **Expand** (too narrow): add tile sizes, `num_ctas` (sm90+), `swap_ab`.
3. **Prune** (too slow): remove suboptimal configs, use arch-conditional yield, add size filters.
4. **Re-validate**: A/B test to confirm improvement.
