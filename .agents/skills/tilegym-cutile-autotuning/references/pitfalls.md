# Pitfall Checklist

Before submitting code with autotune, verify these:

## Pitfall #1: In-Place Kernel Data Corruption

**Problem**: `exhaustive_search` runs the kernel multiple times to benchmark. If the kernel modifies input tensors in-place, the data is corrupted after the first trial run.

**Solution**: Split-buffer pattern — use separate read-only input and write-only output during search:

```python
# During exhaustive_search: use separate output buffer
Q_scratch = torch.empty_like(Q)
configs = list(_rope_autotune_configs())
result = exhaustive_search(
    configs, stream,
    grid_fn=...,
    kernel=rope_kernel,
    args_fn=lambda cfg: (Q, Q_scratch, ...),  # Q_in != Q_out
    hints_fn=...,
)

# After search: launch with in-place args using tuned config
cfg = result.best.config
tuned_kernel = rope_kernel.replace_hints(occupancy=cfg.occupancy)
ct.launch(stream, grid, tuned_kernel, (Q, Q, ...))  # Q_in == Q_out (in-place)
```

**Real example**: `rope_embedding.py` — Search uses split-buffer, final launch uses same-buffer.

**Also wrong**: Using `Q.clone()` in `args_fn` — this adds ~4us per clone, which is fatal for small kernels (~5us). The clone+copy pattern caused 0.48x performance in RoPE.

**Tip — isolating output buffers in `args_fn`**: For kernels that write to a dedicated output tensor (not in-place), you *may* use `c.clone()` inside `args_fn` to prevent trial runs from overwriting the final output buffer. This is only needed when the caller reads the output tensor after `exhaustive_search` returns — if you immediately overwrite it with `ct.launch`, clone is unnecessary:

```python
# Output tensor c will be overwritten by each trial — clone it so trials don't
# corrupt the buffer the caller expects to use after exhaustive_search returns.
result = exhaustive_search(
    configs, stream,
    grid_fn=...,
    kernel=my_kernel,
    args_fn=lambda cfg: (a, b, c.clone()),  # each trial gets a fresh output
    hints_fn=...,
)
```

This is safe because the clone cost (~4us) is negligible relative to compute-bound kernel execution time (~50us+). Only avoid `clone()` for very small, memory-bound kernels where 4us is a significant fraction of runtime — in that case, pre-allocate a single scratch buffer outside `args_fn` (as in the split-buffer pattern above).

## Pitfall #2: Compilation Timeout

**Problem**: >30 configs in the **final code** causes compilation to exceed 5 minutes. CuTile compilation is heavier than Triton.

**Solution**:
- Keep the final code's search space ≤ 30 configs — apply arch filters, tile size filters, and pruning rules until you're under the limit
- Use architecture-conditional yield to only generate relevant configs
- If the initial template configs don't beat baseline, use a temporary directed probe (30–100 configs, via bash, not written to file) to identify winning dimensions, then lock the final code to ≤ 8 top candidates (see Design Philosophy)

**Real example**: Grouped GEMM expanded from 4 to 32 configs → all backward tests timed out. Reverted to occupancy-only (4 configs) with no performance loss.

## Pitfall #3: Cold-Cache Performance Skew

**Problem**: First process run is slower due to driver/JIT caches. Can cause wrong config selection.

**Solution**: Always warm up before measuring. `exhaustive_search` has built-in warmup, but first-process cold start is unavoidable. Re-run if you suspect the initial result was affected.

## Pitfall #4: NCU Profiling Interference

**Problem**: NCU profiles autotune trial runs, cluttering the trace.

**Solution**: Set `DISABLE_AUTOTUNE=1` before profiling, or use `ncu --launch-skip N`.

## Pitfall #5: search_space as Generator (Exhaustion)

**Problem**: `exhaustive_search` requires a `Sequence` (list/tuple), not a generator. Passing a generator directly will fail or produce unexpected results.

**Solution**: Always convert to list:
```python
# CORRECT: convert generator to list
configs = list(_matmul_autotune_configs())
result = exhaustive_search(configs, ...)

# WRONG: passing generator directly
result = exhaustive_search(_matmul_autotune_configs(), ...)
```

## Pitfall #6: FP8 Precision Loss

**Problem**: Hardware `/` breaks FP8 quantization bucket boundaries.

**Solution**: Use `ct.truediv(x, y, rounding_mode=RoundingMode.FULL)` for IEEE-compliant division in FP8 kernels. Never use `/` operator for FP8 scale computation.

## Pitfall #7: `replace_hints` on Hot Path (Recompilation)

**Problem**: `replace_hints()` returns a **new kernel object** with its own JIT cache (internally uses `dataclasses.replace()` which creates a fresh instance). Calling it on every kernel invocation — even with the same arguments — triggers recompilation every time. This is the most common autotune performance bug: `cutile_ms` jumps from ~0.04ms to 16–39ms (100–500× slower).

**Incorrect** (recompiles on every call):
```python
_cache[key] = result.best.config  # only stores config

cfg = _cache[key]
tuned = my_kernel.replace_hints(occupancy=cfg.occupancy)  # NEW kernel each time!
ct.launch(stream, grid, tuned, ...)
```

**Correct** (compile once, reuse forever):
```python
best_cfg = result.best.config
tuned = my_kernel.replace_hints(occupancy=best_cfg.occupancy)  # compile ONCE
_cache[key] = (best_cfg, tuned)  # cache both

cfg, tuned = _cache[key]
ct.launch(stream, grid, tuned, ...)  # reuse compiled kernel
```

**Rule**: Call `replace_hints` exactly once per config (immediately after `exhaustive_search`), cache the returned kernel object, and never call `replace_hints` again on the fast path.
