# cuDF API Patterns, Gaps, and Semantic Differences

## Key Semantic Differences from pandas

### Null/NaN Handling

cuDF preserves nullable dtypes more often than pandas and uses Arrow-style
nulls instead of float `NaN` promotion for nullable numeric columns:

```python
import cudf
import pandas as pd

s = cudf.Series([1, None, 3])
print(s.dtype)   # Int64 (nullable), not float64 with NaN

# Check for null
s.isnull()       # works as expected
s.isna()         # equivalent

# Fill nulls
s.fillna(0)      # works
```

Difference: `pd.Series([1, None, 3])` → dtype `float64` with `NaN`; cuDF → nullable `Int64` with `<NA>`.

For string columns in current releases, missing string values display as `None`
rather than `<NA>`. Do not write tests that depend on the display repr; compare
with `.isna()`, `.notna()`, or typed result values.

When comparing cuDF output with a pandas nullable reference, convert with
`nullable=True`:

```python
actual_pdf = gdf.to_pandas(nullable=True)
```

This keeps nullable pandas dtypes when they exist, instead of converting nulls
to `np.nan` or `None` during the comparison boundary.

For a null-heavy workflow, keep the pandas behavior as a compact reference and
make the GPU path explicit:

- scalar, dictionary, forward, and backward fills map directly to cuDF
- group-specific fills are usually `groupby().transform(...)` followed by
  `fillna(...)`
- conditional fills are boolean masks plus assignment, or a grouped aggregate
  merged back onto the original frame
- linear interpolation is a semantic boundary; use cuDF only after checking the
  installed API behavior, or keep that narrow step under `cudf.pandas` with a
  parity check

Validate row count, null count by column, representative filled values, grouped
aggregates, and any rows produced by sort/interpolation-sensitive code.

### Sort Stability

cuDF sort is **not stable by default**:

```python
# Unstable (default) — faster
df.sort_values("col")

# Stable — required when sort order must match pandas exactly
df.sort_values("col", stable=True)
```

### String Operations — RE2 Regex

cuDF uses RE2 (not Python's `re` / PCRE). Some patterns differ:

```python
# RE2 does not support:
# - Lookahead/lookbehind: (?=...), (?!...)
# - Backreferences: \1
# - Possessive quantifiers: ?+, *+

# RE2-compatible (works):
df["col"].str.contains(r"\d+")
df["col"].str.replace(r"[aeiou]", "", regex=True)

# Not RE2-compatible (will fail or fall back):
df["col"].str.contains(r"(?=.*foo)")   # lookahead — use different approach
```

### CuPy Array Output

When you access `.values` on a cuDF Series/DataFrame, you get a CuPy array (not NumPy):

```python
import cudf
import cupy as cp

df = cudf.DataFrame({"a": [1, 2, 3]})
arr = df["a"].values     # CuPy array, not NumPy!
type(arr)                # <class 'cupy.ndarray'>

# To get NumPy explicitly:
np_arr = df["a"].to_numpy()
np_arr = cp.asnumpy(arr)
```

## Common API Gaps and Workarounds

The pandas API surface is vast and cuDF only covers a limited subset of it. This section lays out some of the common gaps but it should not be construed as an exhaustive list of discrepancies between the cuDF and pandas APIs.

### Operations Not Yet in cuDF

| pandas Operation | Status | Workaround |
|---|---|---|
| `df.apply(func, axis=0)` | Column-wise apply: limited | Rewrite as vectorized cuDF ops |
| `df.apply(func, axis=1)` | Row-wise apply: limited | Use `df.apply()` for simple funcs; otherwise `cudf.pandas` fallback |
| Some `pd.Grouper` options | Partial | Use resample or direct groupby |
| `pd.read_html()` | Not supported | Use pandas, then `cudf.from_pandas()` |
| `pd.ExcelWriter` / `read_excel` | Not supported | Convert to CSV/Parquet first |
| `df.to_sql()` | Not supported | Convert to pandas, then use pandas |
| Multi-level columns (MultiIndex) | Partial | Flatten column names first |

### Reshape and Crosstab Fidelity

`cudf.pivot_table`, `cudf.melt`, `cudf.crosstab`, `DataFrame.unstack`, and
`DataFrame.stack` cover many reshape workflows. Treat the source pandas schema
as observable behavior when a pipeline depends on reshape output:

- Capture expected index labels, column labels or levels, names, shape, and
  representative values from the pandas path before rewriting.
- Preserve pandas MultiIndex columns when the downstream code consumes them. If
  a flat schema is the practical cuDF representation, return a documented
  mapping such as `revenue_sum_2024` and validate consumers against that schema.
- For multi-aggregation `pivot_table` outputs, keep aggregation names in the
  schema. Build the cuDF result from explicit grouped aggregations when needed,
  then either recreate the pandas column levels or flatten with deterministic
  names such as `{value}_{agg}_{column}`.
- Implement missing `crosstab` conveniences with explicit GPU operations:
  counts via `cudf.crosstab`, margins via row/column sums, and row-normalized
  values by dividing each row by its row total.
- Use `cudf.pandas` as a compatibility-first path when exact pandas reshape
  semantics are the goal and explicit cuDF would require broad schema changes.
- Add a reusable validation helper that compares shape, index/column labels,
  aggregation names, null placement, and numeric values against the pandas
  reference on a small fixture.

### Time-Series and Rolling Fidelity

cuDF supports datetime columns, sorting, grouped operations, shifts, cumulative
operations, and many rolling-window patterns. Preserve pandas-visible time
semantics when rewriting:

- keep timezone, timestamp dtype, frequency, and bucket labels as part of the
  output contract
- sort by grouping keys and timestamp before grouped `shift`, `rolling`,
  cumulative, or expanding-style calculations
- validate sparse or missing buckets against the pandas reference; explicitly
  materialize the desired bucket grid when downstream consumers expect empty
  periods
- use final `.to_pandas()` only for display, plotting, or reference comparison

### I/O Formats Supported by cuDF

```python
# Fully supported (fast GPU I/O)
cudf.read_csv(), cudf.read_parquet(), cudf.read_json()
cudf.read_orc(), cudf.read_feather(), cudf.read_avro()

# Not supported (use pandas, convert with cudf.from_pandas())
# Excel, HTML, SQL, HDF5, SAS, Stata, pickle
```

## Useful cuDF-Specific APIs

```python
# Convert between pandas and cuDF
cudf_df = cudf.from_pandas(pd_df)
pd_df = cudf_df.to_pandas()

# Interop with CuPy
import cupy as cp
arr = cp.asarray(df["col"])          # zero-copy view
df["new_col"] = cudf.Series(arr)     # back to cuDF
```

## Performance Tips

1. **Cast to float32 early**: `df[numeric_cols] = df[numeric_cols].astype("float32")`
2. **Use `cudf.read_parquet()` not CSV**: Parquet is columnar and dramatically faster to read
3. **Avoid `.apply()` with Python lambdas**: Use built-in cuDF ops instead
4. **Use `persist()` with dask-cuDF**: keeps computed data on GPU workers to avoid recomputation
5. **Avoid mid-pipeline `.to_pandas()`**: each roundtrip is a PCIe transfer
