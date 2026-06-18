---
name: earth2studio-data-fetch
version: 0.16.0
license: Apache-2.0
metadata:
  author: NVIDIA Earth-2 Team
  tags:
    - earth2studio
    - earth2
    - python
    - data-fetch
    - weather-data
    - xarray
description: >
  Fetch weather/climate data via Earth2Studio data sources for specific variables
  and times. Do NOT use for inference pipelines, model discovery, or installation.
---

# Earth2Studio Data Fetch Skill

## Purpose

Guide a user through downloading weather/climate data via Earth2Studio data source
APIs. Identifies compatible sources by checking the lexicon, verifies variable
support, and produces a working fetch script outputting an xarray DataArray.

## Prerequisites

- Earth2Studio installed (`uv pip install earth2studio` or equivalent)
- Network access to remote data stores (GCS, S3, CDS API, etc.)
- For CDS-based sources: valid CDS API key configured (`~/.cdsapirc`)
- Python 3.10+

## Instructions

You are helping a user download specific weather/climate data using
Earth2Studio's data source APIs. Your job is to identify which data source(s)
can provide the requested variables, verify compatibility via the lexicon
system, and produce a working fetch script.

### Core principle: live docs and lexicon are the source of truth

Data source APIs, available variables, and the lexicon evolve between releases.
Before recommending a data source or writing a fetch script:

1. **Fetch the relevant data source doc page** to confirm the API signature
   and constructor arguments.
2. **Check the lexicon** to verify the requested variable is supported by
   that data source.

Live doc references (fetch only what the user's request requires):

- **Analysis data sources:**
  <https://nvidia.github.io/earth2studio/modules/datasources_analysis.html>
- **Forecast data sources:**
  <https://nvidia.github.io/earth2studio/modules/datasources_forecast.html>
- **DataFrame data sources:**
  <https://nvidia.github.io/earth2studio/modules/datasources_dataframe.html>
- **Lexicon base:**
  <https://github.com/NVIDIA/earth2studio/blob/main/earth2studio/lexicon/base.py>
- **Lexicon per-source:**
  <https://github.com/NVIDIA/earth2studio/tree/main/earth2studio/lexicon>

### Interaction protocol

#### Step 1. Understand the user's request

Extract from what the user has said (ask follow-ups if needed, cap at 3
questions):

- **Variables** — what do they want? Use Earth2Studio variable names
  (e.g. `t2m`, `u500`, `z850`, `tp`, `msl`). If the user uses plain language
  ("500 hPa geopotential height"), map it to the E2Studio name by checking
  the live `base.py` E2STUDIO_VOCAB.
- **Time** — what date/time range? A single timestamp, a range, or multiple
  discrete times?
- **Data type** — analysis/reanalysis (historical state) or forecast (lead-time based)?
- **Lead time** (forecast only) — how far ahead? Which initialization time?
- **Region** — global or regional (e.g. North America for HRRR)?
- **Output format** — xarray DataArray (default), save to file (NetCDF/Zarr)?

#### Step 2. Identify candidate data sources

Based on the request type, narrow candidates:

**Analysis/reanalysis** (historical state at a specific time):

- Use analysis data source page to identify options
- Common choices: GFS (operational, recent), HRRR (NA, hourly),
  IFS/IFS_ENS (ECMWF), ARCO/CDS/WB2ERA5/NCAR_ERA5 (ERA5 reanalysis),
  GOES/MRMS/JPSS (observational)

**Forecast** (predictions from an initialization time with lead times):

- Use forecast data source page to identify options
- Common choices: GFS_FX, GEFS_FX, HRRR_FX, IFS_FX, IFS_ENS_FX,
  AIFS_FX, CFS_FX

Key differentiators to surface:

- **Temporal coverage** — operational sources (GFS, HRRR) have limited
  history; reanalysis (ERA5 via ARCO/CDS/WB2) goes back decades
- **Spatial resolution** — HRRR is 3km NA-only; GFS is 0.25° global;
  WB2ERA5_32x64 is 5.625° global
- **Update frequency** — some are real-time, some have multi-day lag

#### Step 3. Verify variable support via lexicon

This is critical. Each data source has a lexicon file that defines which
E2Studio variables it can provide.

To verify:

1. Fetch the source's lexicon file from
   `https://github.com/NVIDIA/earth2studio/blob/main/earth2studio/lexicon/<source>.py`
   (e.g. `gfs.py`, `hrrr.py`, `cds.py`, `arco.py`, `wb2.py`)
2. Check that the user's requested variable(s) appear as keys in the
   source's `VOCAB` dict
3. If a variable is NOT in a source's lexicon, that source cannot provide
   it — try another

The lexicon VOCAB maps Earth2Studio variable names → source-specific
identifiers. If a variable key exists in the VOCAB, the source supports it.

Present the results clearly: *"GFS supports `t2m`, `u500`, `z850`. HRRR also
supports these but is limited to North America. ARCO (ERA5) supports all
three and has data back to 1959."*

#### Step 4. Confirm data source selection with user

Present the viable options with tradeoffs:

| Source | Variables | Coverage | Resolution | Time Range |
|--------|-----------|----------|------------|------------|
| ... | ... | ... | ... | ... |

Let the user pick. If there's one obvious choice, recommend it and ask for
confirmation.

#### Step 5. Generate fetch script

Write a Python script that uses the selected data source to fetch the
requested data. The script structure depends on whether it's an analysis or
forecast source.

**Analysis source pattern:**

```python
import datetime
from earth2studio.data import <SourceClass>

# Initialize data source
ds = <SourceClass>()

# Fetch data
# Analysis sources use: ds(time, variable) -> xr.DataArray
time = [datetime.datetime(YYYY, M, D, H)]  # or array of times
variable = ["var1", "var2"]  # E2Studio variable names

data = ds(time, variable)
```

**Forecast source pattern:**

```python
import datetime
from earth2studio.data import <SourceClass>

# Initialize data source
ds = <SourceClass>()

# Forecast sources use: ds(time, lead_time, variable) -> xr.DataArray
time = [datetime.datetime(YYYY, M, D, H)]  # initialization time
lead_time = [datetime.timedelta(hours=H)]   # or array of lead times
variable = ["var1", "var2"]

data = ds(time, lead_time, variable)
```

Always fetch the specific data source's API doc page to confirm the exact
constructor arguments and call signature before writing the script — they can
vary (some need auth tokens, cache paths, specific parameters).

Include in the script:

- Appropriate imports
- Clear comments explaining each step
- How to inspect the result (`print(data)`, `data.shape`, `data.coords`)
- Optional: saving to file if the user requested it

#### Step 6. Offer next steps

After delivering the script, mention:

- How to change variables/times without rewriting the whole thing
- If they might want to feed this into a model, point them to the
  discover skill
- Cache behavior (data is cached locally after first fetch via
  `EARTH2STUDIO_CACHE`)

### Ownership and out-of-scope

**Owns:** identifying data sources for a user's variable/time request,
verifying variable support via lexicon, generating data fetch scripts,
explaining analysis vs. forecast source differences.

**Does not own:** installation (earth2studio-install), model selection
(earth2studio-discover), inference pipelines, custom data source creation
(point to extend examples), data source authentication setup beyond what
the docs describe.

## Examples

Typical invocation:

> "I need 500 hPa geopotential height and 2m temperature from ERA5
> for January 1, 2020 at 00Z."

The skill would:

1. Map plain language → `z500`, `t2m`
2. Check ARCO/CDS/WB2ERA5 lexicons for support
3. Recommend ARCO (free, no API key) or CDS (official, needs key)
4. Generate a fetch script using the selected source

## Limitations

- **Network required** — all data sources fetch from remote stores
  (GCS, S3, CDS API)
- **No local file loading** — for local NetCDF/Zarr, use
  `DataArrayFile`/`DataSetFile` directly
- **One source type per script** — cannot mix analysis and forecast
  sources in a single call
- **Variable availability varies** — not all sources provide all
  variables; always verify via lexicon
- **Rate limits** — CDS API has queue-based throttling; GCS/S3 sources
  are generally faster

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `KeyError: '<var>'` | Not in lexicon | Check lexicon; try another source |
| `FileNotFoundError` / 404 | Time not available | Verify temporal coverage |
| `CDS API timeout` | Queue congestion | Retry or use ARCO for ERA5 |
| `ModuleNotFoundError` | Not installed | `uv pip install earth2studio` |
| Empty DataArray | Time/var mismatch | Check datetime and variable name |
