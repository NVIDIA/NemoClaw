# TileGym and Packaged Examples Guide

**Always look at existing cuTile code before writing a new kernel.** There are two sources, in priority order: TileGym's own ops (primary), then the skill's packaged `examples/` (complementary, for ops TileGym does not yet cover).

## Locating TileGym

The skill supports two installation contexts. Figure out which one applies before searching.

### Case 1 — skill inside a TileGym checkout

Path looks like `<repo>/skills/tilegym-cutile-python/` (or `<repo>/.agents/skills/tilegym-cutile-python/` / `<repo>/.claude/skills/tilegym-cutile-python/` via the backward-compat symlinks). The enclosing repo **is** TileGym. No clone needed — use it directly:

```
<repo>/src/tilegym/ops/cutile/
```

### Case 2 — skill installed elsewhere (e.g. `~/.agents/skills/` or `~/.claude/skills/`)

Path looks like `~/.agents/skills/tilegym-cutile-python/` or `~/.claude/skills/tilegym-cutile-python/`, or the skill is inside some other repo that does not ship `src/tilegym/`. TileGym is not adjacent; clone it once on first use to the cache directory and use it from there:

```
${TILEGYM_SKILL_CACHE_DIR:-~/.cache/tilegym}/TileGym/src/tilegym/ops/cutile/
```

Clone URL: `https://github.com/NVIDIA/TileGym.git`.

**Matching the cache to your `cuda-tile` version.** Read the installed `cuda-tile` version — `cuda.tile.__version__` or `pip show cuda-tile`. In the cached TileGym checkout, pick the tag whose version matches the same `MAJOR.MINOR`; if several patch tags share that `MAJOR.MINOR`, use the highest. Deterministic fallback when no tag matches `MAJOR.MINOR`: pick the most recent tag with the same `MAJOR`; only fall back to `main` as a last resort (API mismatches are possible). Refresh the cache whenever `cuda-tile` is upgraded.

### How to decide

Starting from the skill directory, walk up looking for a `src/tilegym/` sibling. If you find one, you are in Case 1 — use it. Otherwise you are in Case 2 — use (or create) the cached checkout.

## TileGym contents (`src/tilegym/ops/cutile/`)

Production cuTile kernels, autotuned and perf-tuned: standard GEMM/BMM (`matmul.py`, `bmm.py`, `group_gemm.py`), attention variants (`attention.py`, `flash_attention.py`, `mla*.py`, `pod_attention.py`, `gemma_attention*.py`), normalization (`layer_norm.py`, `rms_norm.py`, `cache_layer_norm.py`), activations (`activation/*.py`, `swiglu.py`, `silu_and_mul.py`), RoPE, dropout, MoE, FFT, transpose, and more. This is the canonical reference.

## Packaged examples (`<skill_dir>/examples/`)

Complementary — covers ops TileGym does not yet implement. These prioritize correctness over performance; tune block sizes and validate against a PyTorch reference before using.

| Directory | Operations Covered |
|-----------|-------------------|
| `examples/convolution/` | conv2d, conv3d, conv_transpose_2d, conv_transpose_3d |
| `examples/matmul/` | gemv, matmul_4d, split_k_gemm |
| `examples/normalization/` | group_norm |
| `examples/pooling/` | maxpool3d, avgpool3d |
| `examples/scan/` | cumsum, cumprod |

## Search order

1. Search TileGym's `src/tilegym/ops/cutile/` for the op. Read the closest match and adapt.
2. If TileGym has no match, search the skill's packaged `examples/`.
3. If neither has it, consult the language spec at <https://docs.nvidia.com/cuda/cutile-python> and design from scratch.
