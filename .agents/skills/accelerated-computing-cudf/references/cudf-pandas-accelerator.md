# cudf.pandas Accelerator — Deep Dive

## How It Works

`cudf.pandas` replaces the pandas module with a proxy that routes operations to cuDF when supported, falling back to standard pandas on CPU silently for unsupported operations. The fallback is transparent — code continues to work correctly, but unsupported ops run on CPU.

## Activation Methods

| Method | Use Case |
|---|---|
| `%load_ext cudf.pandas` | Jupyter/IPython notebooks |
| `python -m cudf.pandas script.py` | CLI script execution |
| `import cudf.pandas; cudf.pandas.install()` | Programmatic, multiprocessing |

**Critical**: Activation must happen BEFORE any pandas import, direct or transitive. If you're using IPython and pandas was already imported in the kernel, restart and run activation first. Direct usage of `cudf.pandas.install()` in a script cannot be undone and the script must be restarted.

## Profiling for GPU vs CPU Ops

### Cell-Level Profiling (Jupyter)

```python
%load_ext cudf.pandas
import pandas as pd

%%cudf.pandas.profile
df = pd.read_csv("data.csv")
result = df.groupby("category")["amount"].sum()
df.merge(lookup, on="id")
```

Output shows each operation's execution path (GPU or CPU) and time.

### Line-Level Profiling

```python
%%cudf.pandas.line_profile
df = pd.DataFrame({"a": range(1000000), "b": range(1000000)})
result = df.groupby("a")["b"].sum()    # shows GPU time
df.apply(lambda x: x + 1, axis=1)     # shows CPU fallback time
```

### CLI Profiling

```bash
python -m cudf.pandas --profile my_script.py
```

### Detecting Silent Fallbacks

The profiling tools are also a convenient way to detect silent fallback. If the profiles show tasks running on the CPU unexpectedly, you may be hitting unsupported GPU methods (limitations are discussed in depth in the api-patterns.md reference file). Try reproducing with raw cudf code without cudf.pandas to verify.

## Verifying GPU Is Actually Used

```python
# Method 1: Run nvidia-smi during execution
# nvidia-smi dmon -s u -d 1

# Method 2: Check cudf.pandas stats
import cudf.pandas
stats = cudf.pandas.get_stats()
print(stats)  # shows GPU vs CPU operation counts
```

If GPU utilization stays 0% during execution, the entire workload fell back. Diagnose with `%%cudf.pandas.profile`.

## multiprocessing Support

```python
# This pattern ensures workers also use cudf.pandas
import cudf.pandas
cudf.pandas.install()           # must be FIRST, before everything else

from multiprocessing import Pool
import pandas as pd

def process_chunk(args):
    # Workers inherit cudf.pandas installation
    df = pd.read_csv(args)
    return df.groupby("key")["value"].sum()

with Pool(4) as pool:
    results = pool.map(process_chunk, file_list)
```

## Limitations

- **Usage of the NumPy C API**: Many projects have custom extension modules that interface with pandas dataframes via the NumPy C API for interacting with individual pandas columns. That will never work with cudf.pandas.
- **Subclassed DataFrames**: code that subclasses `pd.DataFrame` may not work with cudf.pandas proxy
- **Private pandas APIs** (`pd._libs.*`, etc.): not supported
- **In-place operations with external code**: if third-party code holds references to pandas internals, proxy may not intercept correctly
- **cudf.pandas does not speed up Python-level loops**: vectorize first, then accelerate

## When to Move to Explicit cuDF

Move from cudf.pandas to explicit cuDF when:
1. Profile shows >30% CPU fallback rate on hot paths
2. You need cuDF-specific features (e.g., `cudf.set_option("spill", True)`)
3. You need explicit control over dtype casting (float32 optimization)
4. You're building a cuDF-first library, not accelerating existing pandas code
