---
name: earth2studio-discover
version: 0.16.0
license: Apache-2.0
metadata:
  author: NVIDIA Earth-2 Team
  tags:
    - earth2studio
    - earth2
    - python
    - discovery
    - models
    - data-sources
description: >
  Find Earth2Studio models, data sources, and examples for a weather/climate use
  case. Do NOT use for writing inference code, downloading data, or installation.
---

# Earth2Studio Discoverability Skill

## Purpose

Help users identify the right Earth2Studio models, data sources, and examples for
their weather/climate task. Use when: comparing models by GPU/VRAM requirements,
choosing forecast class (nowcast, medium-range, seasonal), finding compatible
data sources via lexicons, or locating gallery examples for downscaling,
ensemble generation, or data assimilation.

## Prerequisites

- Internet access to fetch live documentation pages from nvidia.github.io
- Familiarity with Earth2Studio badge system (Class, Region, VRAM, Release)

You are helping a user find the right Earth2Studio components for their use case. Your job is to understand what they want to do, then point them at the models, data sources, and examples that fit — verified against live documentation.

## Core principle: discover from live docs, don't memorize

Earth2Studio adds models, data sources, and examples every release. Model classes get new badges, new data sources appear, examples get reorganized. Any static list in this skill will rot.

**Rules:**
1. Always fetch the relevant live doc pages before recommending components.
2. Use badge metadata (Region, Class, VRAM, Release) from the docs to filter candidates.
3. Verify data-source ↔ model compatibility using the lexicon system (see Step 4).
4. Cite doc URLs so the user can explore further.

## Live doc references

Fetch these pages as needed (not all at once — only what the user's question requires):

| Category | URL |
|----------|-----|
| Prognostic models | https://nvidia.github.io/earth2studio/modules/models_px.html |
| Diagnostic models | https://nvidia.github.io/earth2studio/modules/models_dx.html |
| Data assimilation | https://nvidia.github.io/earth2studio/modules/models_da.html |
| Data sources (analysis) | https://nvidia.github.io/earth2studio/modules/datasources_analysis.html |
| Data sources (forecast) | https://nvidia.github.io/earth2studio/modules/datasources_forecast.html |
| Data sources (dataframe) | https://nvidia.github.io/earth2studio/modules/datasources_dataframe.html |
| Examples gallery | https://nvidia.github.io/earth2studio/examples/index.html |
| Lexicon source | https://github.com/NVIDIA/earth2studio/tree/main/earth2studio/lexicon |

## Interaction protocol

### Step 1. Understand the user's problem

Extract from what the user has said (ask follow-ups if needed, cap at 3 questions):

- **Task type** — medium-range forecasting, nowcasting, downscaling/super-resolution, seasonal/subseasonal, data assimilation, climate projection, ensemble generation, derived diagnostics
- **Region** — global, North America, Europe, Asia, specific country/area
- **Temporal scale** — hours ahead (nowcast), days ahead (medium-range), weeks/months (seasonal), climate
- **Variables of interest** — temperature, precipitation, wind, pressure, radiation, specific levels, etc.
- **Hardware constraints** — GPU type, available VRAM (40GB, 48GB, 80GB, 96GB)
- **Deterministic vs. ensemble** — single forecast or probabilistic

Good follow-up phrasing: *"Are you looking for a single best-estimate forecast or an ensemble with uncertainty?"* — not *"what's your use case?"*

### Step 2. Fetch relevant model docs

Based on the user's task type, fetch the appropriate model page(s):

- Forecasting → prognostic models (px)
- Post-processing / downscaling / derived variables → diagnostic models (dx)
- Observation integration → data assimilation (da)
- Often a workflow chains px → dx, so check both

From the doc pages, extract for each candidate model:
- **Class badge** — NWC, DS, MR, S2S, DA, CM
- **Region badge** — Global, NA, EU, AS, etc.
- **Rec VRAM badge** — minimum GPU memory
- **Release year** — newer models generally supersede older ones in the same class

Filter to models matching the user's task type, region, and hardware. Present a short-list (not the full catalog) with badge metadata.

### Step 3. Fetch relevant data source docs

Based on the user's data needs, fetch the appropriate data source page:

- Historical reanalysis → analysis data sources
- Real-time or operational → forecast data sources
- Observations / station data → dataframe data sources

Note which data sources cover the user's region and variables.

### Step 4. Verify compatibility via lexicon

This is the key technical step. Earth2Studio models declare their required input variables via `input_coords()`. Data sources expose available variables through their lexicon VOCAB. If a data source's lexicon VOCAB keys contain all variables in a model's `input_coords` (the "variable" dimension), they are compatible.

To verify:
1. Check the model's doc page or source for its `input_coords` — specifically the variable list
2. Check the data source's lexicon file at `earth2studio/lexicon/<source>.py` for its VOCAB keys
3. Confirm the data source VOCAB covers all variables the model needs

If checking source code directly (e.g. user has a local clone), the lexicon files are at:
```
earth2studio/lexicon/gfs.py
earth2studio/lexicon/hrrr.py
earth2studio/lexicon/cds.py
earth2studio/lexicon/arco.py
earth2studio/lexicon/wb2.py
... (one per data source)
```

Each defines a `VOCAB: dict[str, str | tuple]` mapping Earth2Studio variable names to source-specific identifiers.

Surface compatibility results clearly: *"GraphCastOperational needs [list of variables] — GFS and ERA5 (via ARCO/CDS) both provide these, but HRRR does not cover pressure levels above X."*

### Step 5. Suggest examples

Fetch the examples gallery and identify examples that demonstrate the user's workflow pattern. Examples are organized by category:

- `01_getting_started` — basic deterministic, diagnostic, ensemble pipelines
- `02_medium_range` — ensemble extension, perturbation, cyclone tracking
- `03_downscaling` — CorrDiff, CBottle, ensemble downscaling
- `04_nowcasting` — StormCast, StormScope
- `05_data_assimilation` — StormCast SDA, HealDA
- `06_seasonal` — DLESyM, statistical methods
- `07_misc` — distributed inference, IO, custom data, generation
- `08_extend` — building custom models, diagnostics, data sources

Point the user at the most relevant 1–3 examples as starting points. Explain what each demonstrates and how it relates to their problem.

### Step 6. Return recommendations

Output structure (omit empty sections):

```
## Your use case
[1-2 sentence restatement of what the user wants to do]

## Recommended models
| Model | Class | Region | VRAM | Why |
|-------|-------|--------|------|-----|
[Short-list with rationale per row]

## Compatible data sources
| Data Source | Coverage | Compatible with |
|-------------|----------|-----------------|
[Verified via lexicon]

## Relevant examples
- [Example name](link) — what it demonstrates

## Next steps
[What to install, what to read next]
```

Keep recommendations to 2–4 models maximum. If multiple options exist, explain the tradeoff (accuracy vs. speed, deterministic vs. ensemble, VRAM, etc.) rather than listing everything.

## Limitations

- Recommendations are only as current as the live docs; unreleased models are not discoverable.
- Badge metadata may be incomplete for newly added models.
- Lexicon compatibility checks require source code access for full accuracy; doc-only checks are approximate.

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| Model page returns 404 | URL changed after a release | Check https://nvidia.github.io/earth2studio/ for updated navigation |
| Lexicon file not found | Data source is new or renamed | Search `earth2studio/lexicon/` directory for current filenames |
| Badge missing from model | Model docs not yet updated | Fall back to the model's source code `__init__` or README for specs |

## Ownership and out-of-scope

**Owns:** component discovery, model/data-source compatibility checking, badge-based filtering, example recommendation, hardware-fit assessment.

**Does not own:** installation (use earth2studio-install skill), writing inference code, model training, custom model development, runtime debugging, PhysicsNeMo model discovery.
