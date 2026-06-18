# Testing & Validation (cuTile → Triton)

How to test and benchmark kernels after converting from cuTile to Triton,
using the standard TileGym pytest infrastructure.

---

## Table of Contents

- [Test Harness](#test-harness)
- [Benchmark Harness](#benchmark-harness)
- [Conversion Skill Workflow](#conversion-skill-workflow)

---

## Test Harness

`tests/common.py::PyTestCase` provides the correctness comparison infrastructure:

```python
# Primary kernel comparison method
self.assertCorrectness(
    test_fn,           # Kernel under test (e.g., Triton impl)
    ref_fn,            # Reference (e.g., PyTorch or cuTile)
    kwargs,            # Input tensors
    rtol=1e-3,         # Relative tolerance
    atol=1e-5,         # Absolute tolerance
    gradient=True,     # Also check backward pass
)
```

**Key methods**:

- `assertCorrectness()` — Compare test vs reference with tolerances
- `assertDeterministic()` — Verify consistent results across iterations
- `compare_tensors()` — Low-level comparison with detailed mismatch reporting
- `benchmark()` — Performance measurement with CUDA events/CUPTI

**Tolerance defaults by dtype** (from `get_dtype_tolerances()`):

| dtype | rtol | atol |
|-------|------|------|
| float64 | 1e-12 | 1e-15 |
| float32 | 1e-5 | 1e-8 |
| float16 | 1e-2 | 1e-2 |
| bfloat16 | 1e-2 | 2e-2 |
| float8_e4m3fn | 1e-1 | 1e-1 |

Run the op's test suite filtering for the Triton backend:

```bash
# All Triton correctness tests
pytest tests/ops/test_<op>.py -k "triton" -vs

# For suites/ operators (external framework)
pytest tests/suites/<framework>/test_<op>.py -k "triton" -vs
```

**Pass gate:** `N passed, 0 failed` before moving to performance.

If tests fail, see [debugging.md](./debugging.md) for the most common root causes
(`cudaErrorIllegalAddress`, pointer type mismatch, stride overflow, dtype issues).

---

## Benchmark Harness

TileGym provides a benchmark harness with provider abstraction for systematic
performance measurement across backends:

```python
from harness import run_benchmarks, get_providers

run_benchmarks(
    kernel_name="matmul",
    providers=get_providers(),  # ["triton", "cutile", "pytorch"]
    x_name="M",
    x_vals=[512, 1024, 2048, 4096],
    make_fwd_fn=lambda provider, x: create_forward_fn(provider, x),
    csv_path="./benchmark_results.csv",
)
```

**Provider mapping**:

- `triton` — Triton backend
- `cutile` — cuTile backend
- `pytorch` — PyTorch reference

Run performance tests to compare backends side-by-side:

```bash
# Ops
pytest tests/ops/test_<op>.py -k "test_perf" --print-record -v

# Suites
pytest tests/suites/<framework>/test_<op>.py -k "test_perf" --print-record -v
```

The output table includes TFLOPS (or GB/s) per config and backend. The acceptance
threshold is **Triton ≥ 80% of cuTile** across all tested configs.

---

## Conversion Skill Workflow

The cuTile→Triton conversion follows a **5-phase gated workflow**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    SKILL WORKFLOW PHASES                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  c2t-1 (Optional)      c2t-2              c2t-3                 │
│  ┌─────────────┐      ┌─────────────┐    ┌─────────────┐       │
│  │ Test        │ ──▶  │ Convert     │ ──▶│ Test        │       │
│  │ Coverage    │      │ cuTile→     │    │ Correctness │       │
│  │ Analysis    │      │ Triton      │    │ (pytest)    │       │
│  └─────────────┘      └─────────────┘    └──────┬──────┘       │
│                                                  │               │
│                                    ┌─────────────▼───────────┐  │
│  c2t-5                             │       c2t-4             │  │
│  ┌─────────────┐                   │  TMA OPTIMIZATION       │  │
│  │ Performance │ ◀─────────────────│  (MANDATORY)            │  │
│  │ Test        │                   │  • 2D+ loads → TMA      │  │
│  │ (≥80% of    │                   │  • tl.assume() hints    │  │
│  │  cuTile)    │                   │  • Dual kernels if      │  │
│  └─────────────┘                   │    transpose flag       │  │
│                                    └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Phase Summary

| Phase | ID | Purpose | Gate Criteria |
|-------|-----|---------|---------------|
| Test Coverage | c2t-1 | Verify cuTile tests pass | Optional baseline |
| Convert | c2t-2 | Apply API mapping | No syntax errors |
| Test | c2t-3 | Correctness validation | `0 failed` |
| TMA Optimize | c2t-4 | **MANDATORY** TMA for 2D+ | No raw ptr+mask loads |
| Performance | c2t-5 | Benchmark comparison | Triton ≥ 80% cuTile |

### TMA Verification (Pre-Benchmark)

Before running perf tests, confirm every 2D+ tile load uses TMA — raw pointer+mask loads
cause 5–20× regressions that will fail the performance gate:

```bash
# Should return 0 for fully-optimized kernels
grep -c "tl\.load.*mask" <your_triton_kernel.py>

# Confirm TMA descriptors are present
grep -n "make_tensor_descriptor\|make_block_ptr" <your_triton_kernel.py>
```

---

## Related Documents

- [workflow.md](../translations/workflow.md) — Full phase-gated conversion workflow
- [debugging.md](./debugging.md) — Runtime error diagnosis
- [advanced-patterns.md](../translations/advanced-patterns.md) — Dual-kernel layout flags, autotune
