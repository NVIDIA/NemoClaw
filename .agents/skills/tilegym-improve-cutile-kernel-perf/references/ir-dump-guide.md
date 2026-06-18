# IR Analysis Guide

## Overview

This guide covers how to dump and analyze MLIR IR for cuTile kernels.
cuTile compiles through the tileir backend: TileIR → Bytecode → cubin (PTX → SASS).
By examining IR and SASS you can pinpoint performance bottlenecks.

---

## Compilation Path

### cuTile

```
Python (@ct.kernel)
  │
  ├──▶ Bytecode (.tileirbc)          ← CUDA_TILE_DUMP_BYTECODE
  │       │
  │       ▼  tileiras --arch sm_120
  │     cubin → SASS                 ← ACTUAL runtime path
  │
  └──▶ TileIR MLIR (.tileir)         ← CUDA_TILE_DUMP_TILEIR
```

- **`tileiras`** is the real compiler. It reads bytecode directly.

### Which Level to Analyze?

| Question | Analyze at |
|----------|-----------|
| Are the frontends generating the same high-level ops? | **TileIR** |
| How many HW instructions? Which MUFU ops? | **SASS** |
| What is the scheduling / loop throughput? | **tileiras --remarks** |

---

## Prerequisites

```bash
source /workspace/entrypoint.sh

# Install cuda-tile
pip install cuda-tile[tileiras]

# Verify tools
which tileiras
```

---

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `CUDA_TILE_DUMP_TILEIR` | cuTile TileIR MLIR dump | `/tmp/cutile_tileir` |
| `CUDA_TILE_DUMP_BYTECODE` | cuTile bytecode dump | `/tmp/cutile_bytecode` |
| `CUDA_TILE_LOGS` | cuTile compilation logs | `CUTILEIR` |
| `DISABLE_CUTILE_TUNE` | Force first autotune config (TileGym convention, not a cuTile env var) | `1` |
| `CUDA_TILE_ENABLE_CRASH_DUMP` | Crash dump on failure | `1` |
| `CUDA_TILE_TESTING_DISABLE_TOKEN_ORDER` | Disable token ordering in CuTile | `1` |

---

## How to Dump IR

### cuTile

```bash
# Clean
rm -rf /tmp/cutile_tileir /tmp/cutile_bytecode
mkdir -p /tmp/cutile_tileir /tmp/cutile_bytecode

# Dump TileIR MLIR + bytecode (requires cuda-tile)
# WARNING: autotune overwrites per config. Use DISABLE_CUTILE_TUNE=1.
CUDA_TILE_DUMP_TILEIR=/tmp/cutile_tileir \
CUDA_TILE_DUMP_BYTECODE=/tmp/cutile_bytecode \
DISABLE_CUTILE_TUNE=1 \
  pytest {test_path} -k "test_op and cutile and {config}" --timeout=120

# Compile bytecode → cubin
tileiras --arch sm_120 -o /tmp/cutile.cubin /tmp/cutile_bytecode/*.tileirbc

# Dump SASS
/usr/local/cuda/bin/cuobjdump --dump-sass /tmp/cutile.cubin
```

---

## How to Analyze

### SASS Level: Instruction Counts

```bash
# MUFU instruction breakdown
/usr/local/cuda/bin/cuobjdump --dump-sass /tmp/cutile.cubin | \
  grep "MUFU" | sort | uniq -c | sort -rn

# Total instruction count
/usr/local/cuda/bin/cuobjdump --dump-sass /tmp/cutile.cubin | grep -c ";"

# Cubin size
ls -la /tmp/cutile.cubin
```

MUFU instruction mapping:

| MUFU | HW operation | cuTile API |
|------|-------------|------------|
| `MUFU.TANH` | Hardware tanh (1 cycle) | `ct.tanh(x, rounding_mode=RoundingMode.APPROX)` (since CTK 13.2) |
| `MUFU.EX2` | Hardware exp2 (1 cycle) | `ct.exp()` lowers to mul + EX2 |
| `MUFU.RCP` | Hardware reciprocal (1 cycle) | `ct.truediv(x, y, rounding_mode=RoundingMode.APPROX)` |
| `MUFU.RSQ` | Hardware rsqrt (1 cycle) | `ct.rsqrt()` |

### tileiras Scheduling Remarks

```bash
tileiras --arch sm_120 \
  --remarks=all --remark-format=command-line \
  -o /dev/null /tmp/cutile_bytecode/*.tileirbc
```

Outputs:
- **II (Initiation Interval)**: loop throughput — lower is better
- **NumOps**: operations per loop body
- **Gantt chart**: visual timeline — check if loads overlap with compute
- **TMA Load shapes**: should match your tile sizes
- **Tensor-core shapes**: confirms MMA instruction selection

What to look for:
- **High II** (>1000) → register pressure or long dependency chains
- **Gantt overlaps** (loads start while compute still running) → good pipelining
- **Sequential Gantt** (load → wait → compute → load) → no pipelining

---

## Performance Debugging Techniques

### Technique 1: Isolation Experiment

When cuTile performance is unexpectedly poor, the gap may come from multiple sources
(activation function, memory access, compiler scheduling). To decompose:

1. Replace the suspect operation with a trivial one (e.g., `activation_fn(x)` → `x * constant`)
2. Re-benchmark
3. If performance improves significantly, the suspect operation is the bottleneck

### Technique 2: Register Pressure Diagnosis

```bash
tileiras --arch sm_120 --remarks=schedule --remark-format=command-line \
  -o /dev/null /tmp/cutile_bytecode/*.tileirbc
```

If II is very high, try simplifying the inner loop body (e.g., remove activation, reduce tile size)
and check if II drops. If it does → original code has register pressure.

### Technique 3: cuTile API Introspection

Check what parameters a cuTile math function actually supports:

```python
import cuda.tile as ct
import inspect

for name in ['tanh', 'exp', 'exp2', 'rsqrt', 'truediv']:
    fn = getattr(ct, name, None)
    if fn:
        sig = inspect.signature(fn)
        print(f'ct.{name}: {sig}')
```

Check bytecode encoding to see if a parameter is even representable:

```python
import cuda.tile._bytecode as bc
import inspect
print(inspect.getsource(bc.encode_TanHOp))
```

---

## Known cuTile Limitations

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| `ct.tanh()` APPROX mode (since CTK 13.2) | Use `ct.tanh(x, rounding_mode=RoundingMode.APPROX)` to emit single MUFU.TANH | Prior to CTK 13.2, precise tanh emits many EX2+RCP; upgrade to 13.2+ and use APPROX |
| `ct.exp()` rounding_mode hardcoded to FULL | Cannot force fast exp — rounding_mode is not exposed in the API (TODO in source) | Compiler does its own lowering; no user workaround |
| `ct.mma` no auto float32→tf32 | cuTile does not auto-cast fp32→tf32 | Guard: `a = ct.astype(a, ct.tfloat32) if a.dtype == ct.float32 else a` before `ct.mma` |
| Unnecessary token dependencies | cuTile compiler may insert unnecessary token ordering dependencies, causing pipeline stalls | Set `CUDA_TILE_TESTING_DISABLE_TOKEN_ORDER=1` (see § Token Dependency Analysis below) |
| `tileiras` scheduling quality | May produce suboptimal II for some kernels | No user-facing workaround |

---

## Token Dependency Analysis

CuTile may insert **token dependencies** (ordering constraints) that serialize operations which should run in parallel.

### Detect

Dump IR and check for token operations:

```bash
grep -i "token" /tmp/cutile_tileir/*.tileir
```

If cuTile has excessive token chains → likely unnecessary.

### Mitigate

```bash
CUDA_TILE_TESTING_DISABLE_TOKEN_ORDER=1 \
  pytest {test_path} -k "test_op and cutile" --timeout=120
```

**IMPORTANT**: Always verify correctness after disabling tokens — re-run the pytest correctness test (e.g., `pytest {test_path} -k "test_op and cutile and {config}" --timeout=120`) and confirm all assertions pass. If correctness fails, the tokens are required for that kernel and this flag must not be used.

---

## Full Compiler Pass Dump (Alternative to Per-Level Extraction)

For a comprehensive view of all compiler passes in a single dump:

```bash
# Dump ALL passes for cuTile
tileiras --arch {SM_ARCH} --mlir-print-ir-after-all -o /dev/null \
  /tmp/cutile_bytecode/*.tileirbc 2>&1 > /tmp/cutile_full_dump.txt

# List available passes
grep "IR Dump After" /tmp/cutile_full_dump.txt | head -30

# Extract a specific pass by name
awk '/IR Dump After <PassName>/{found=1; next} /IR Dump After/{if(found) exit} found' \
  /tmp/cutile_full_dump.txt | grep -v "^into " > /tmp/cutile_pass_output.mlir
```

**When to use full dump:**
- When you need to investigate pass ordering, or find where a transformation happens

---

## When to Use IR Analysis

**Use when:**
- cuTile performance is unexpectedly poor and you need to understand why
- Numerical results are correct but performance is poor
- Filing a feature request for the cuTile team (need concrete evidence)

**Don't use when:**
- Kernel doesn't compile (fix syntax/type errors first)
- Numerical results are wrong (fix correctness first)
- Performance difference <5% (likely noise or autotune variance)
