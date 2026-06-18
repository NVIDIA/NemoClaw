---
name: earth2studio-deterministic-forecast
version: 0.16.0
license: Apache-2.0
metadata:
  author: NVIDIA Earth-2 Team
  tags:
    - earth2studio
    - earth2
    - python
    - inference
    - forecast
    - deterministic
description: >
  Build deterministic forecast scripts with Earth2Studio (model, data source,
  IO, inference). Do NOT use for ensemble, diagnostics, data-only fetch, or
  install.
---

# Earth2Studio Deterministic Forecast Skill

Guide users through building deterministic (single-member) weather forecast
inference scripts using `earth2studio.run.deterministic`.

## Prerequisites

- Earth2Studio installed with CUDA-capable GPU
- Python 3.10+, network access for model weights and data

## Live Doc References

Fetch relevant docs to verify current APIs before recommending components:

| Component | URL |
|-----------|-----|
| Prognostic models | <https://nvidia.github.io/earth2studio/modules/models_px.html> |
| Data sources (analysis) | <https://nvidia.github.io/earth2studio/modules/datasources_analysis.html> |
| Data sources (forecast) | <https://nvidia.github.io/earth2studio/modules/datasources_forecast.html> |
| IO backends | <https://nvidia.github.io/earth2studio/modules/io.html> |
| `run.deterministic` | <https://github.com/NVIDIA/earth2studio/blob/main/earth2studio/run.py> |

## Workflow

### 1. Gather Requirements (skip what's already provided)

- Time horizon (hours/days/weeks)
- Variables of interest (t2m, wind, geopotential, etc.)
- Region (global or specific like CONUS)
- GPU/VRAM available

### 2. Select Model

Fetch prognostic models page. Filter by time horizon, region, VRAM. Note model's:
- Input variables (`input_coords["variable"]`)
- Time step size (`output_coords["lead_time"]`)

### 3. Select Data Source

Data source must provide all model input variables. Verify via lexicon at
`earth2studio/lexicon/<source>.py`. Common pairings: Global models → GFS/ARCO/IFS;
Regional → HRRR.

### 4. Select IO Backend

Default: `ZarrBackend`. Use `NetCDF4Backend` for legacy tools, `XarrayBackend`
for in-memory/small runs.

### 5. Calculate nsteps

`nsteps = forecast_hours / model_step_hours`

Example: 5-day forecast with 6h step → `nsteps = 120 / 6 = 20`

### 6. Decide: output_coords Filtering

- **Filter variables** (`output_coords`) when user requests specific variables (e.g., "t2m and wind") - reduces output size
- **Save all variables** (omit `output_coords`) when user says "all variables" or doesn't specify - preserves full model output

### 7. Generate Script

```python
from collections import OrderedDict
import numpy as np
import torch
from earth2studio.models.px import <ModelClass>
from earth2studio.data import <DataSourceClass>
from earth2studio.io import <IOBackendClass>
from earth2studio.run import deterministic

model = <ModelClass>.load_model(<ModelClass>.load_default_package())
data = <DataSourceClass>()
io = <IOBackendClass>("<output_path>")

# Include output_coords ONLY if user requested specific variables
output_coords = OrderedDict({"variable": np.array(["t2m", "u10m"])})

io = deterministic(
    time=["YYYY-MM-DDTHH:MM:SS"],
    nsteps=<N>,
    prognostic=model,
    data=data,
    io=io,
    output_coords=output_coords,  # omit if saving all variables
    device=torch.device("cuda"),
)
```

### 8. Manual Loop Alternative

When user explicitly requests manual implementation (NOT using `earth2studio.run.deterministic`), follow this checklist in order:

1. **fetch_data** - Get initial conditions: `x, coords = fetch_data(data, time, model.input_coords, device)`
2. **Setup total_coords** - Build coordinate arrays for time and lead_time dimensions
3. **io.add_array** - Initialize IO backend with total_coords before loop
4. **create_iterator** - Create prognostic iterator: `model_iter = model.create_iterator(x, coords)`
5. **Loop through nsteps** - `for step, (x, coords) in enumerate(model_iter): if step >= nsteps: break`
6. **map_coords** - Filter output variables if needed: `x_out, coords_out = map_coords(x, coords, output_coords)`
7. **split_coords** - Prepare for IO write: `x_out, coords_out = split_coords(x_out, coords_out)`
8. **io.write** - Write each step to backend

### 9. Explain Next Steps

- How to change forecast time or run multiple initializations
- How to read output (`xr.open_zarr(...)`)
- Point to diagnostic workflow for post-processing

## Ownership

**Owns:** Model selection, data source compatibility, IO backend selection,
nsteps calculation, generating `earth2studio.run.deterministic` scripts.

**Does not own:** Ensemble workflows, diagnostics, data-only fetch, installation,
model training.

## Troubleshooting

See `references/troubleshooting.md` for common errors and solutions.

## Reminders

- **Always fetch live docs** before recommending models or data sources - APIs change between releases
- **Verify lexicon compatibility** - Model input variables must exist in data source's VOCAB
- **Use `load_default_package()`** - This is the standard pattern for loading model weights
- **Time format is ISO 8601** - Use `"YYYY-MM-DDTHH:MM:SS"` format for the `time` argument
- **Wind speed needs both components** - If user asks for "wind speed", include both `u10m` and `v10m`
- **nsteps is integer division** - `nsteps = total_hours // model_step_hours`
- **ZarrBackend is the default** - Only suggest alternatives if user has specific requirements
- **GPU is required** - All prognostic models require CUDA; CPU inference is not supported
