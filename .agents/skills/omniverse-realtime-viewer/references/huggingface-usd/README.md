# Hugging Face USD Asset Acquisition

## Prerequisites

Install the Hugging Face SDK (provides both Python API and `hf` CLI):

```bash
pip install -U "huggingface_hub[cli]"
```

## Authentication

| Scenario | Auth needed? |
|----------|-------------|
| Public datasets (e.g., NVIDIA SimReady) | No |
| Gated datasets | Accept terms on HF website + token |
| Private datasets | Access granted + token |
| Higher rate limits | Token recommended |

Setup:

```bash
# Interactive (stores at ~/.cache/huggingface/token)
hf auth login

# Or via environment
export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxx"

# Or inline
hf download <dataset> --token hf_xxx ...
```

Create tokens at: https://huggingface.co/settings/tokens — *Read* scope is sufficient.

## Downloading Assets

### Single file

```bash
hf download <org>/<dataset> <path/to/file.usd> --repo-type dataset --local-dir assets
```

### Entire asset folder (includes dependencies like textures/sublayers)

```bash
hf download <org>/<dataset> --repo-type dataset --local-dir assets --include "<folder>/*"
```

### Multiple patterns (batch)

```bash
hf download <org>/<dataset> --repo-type dataset --local-dir assets \
  --include "Props/assembly/Pallets_*/*" \
  --include "Props/general/Warehouse/Forklift*/*"
```

### Full dataset

```bash
hf download <org>/<dataset> --repo-type dataset --local-dir assets
```

Always use `--repo-type dataset` — HF defaults to model repos otherwise.

## Hero Stage Discovery

When a user provides a Hugging Face dataset URL and wants "the USD to open", use these heuristics to identify the correct entry-point file (the "hero stage"):

### Decision process

1. **List root-level files** in the repository (not in subdirectories)
2. **Filter for USD files** (`.usd`, `.usda`, `.usdc`)
3. **If exactly one root-level USD exists** — that's almost certainly the hero
4. **If multiple exist**, score them using the signals below

### Scoring signals (strongest first)

| Signal | Confidence | How to check |
|--------|-----------|--------------|
| Has a `.thumbs/256x256/<filename>.png` thumbnail | Very high | Check if `.thumbs/` folder contains a matching PNG |
| Has a `defaultPrim` set | Very high | Open with `pxr` → `stage.GetDefaultPrim()` is valid |
| References sublayers | High | `stage.GetRootLayer().subLayerPaths` is non-empty |
| Name matches dataset name | High | e.g., `physical_ai_simready_warehouse_01.usd` in dataset `PhysicalAI-SimReady-Warehouse-01` |
| Larger file size than siblings | Medium | Scenes are bigger than individual props |
| Name contains "scene", "stage", "world", "main" | Medium | Common naming conventions |
| A `SubLayers/` folder exists in the repo | Supporting | Confirms the root USD is a composed scene |

### What is NOT the hero

- Files inside `Props/` — these are individual assets/components
- Files inside `SubLayers/` — these are scene partitions referenced by the hero
- Files inside `Materials/` or `Textures/` — supporting data
- Files with `_physics` suffix — physics layer overrides, not visual entry points

### Without pxr available

If you can't inspect USD structure programmatically, rely on:
1. Position (root-level, not in a subdirectory)
2. Naming (matches dataset name)
3. Thumbnail presence (`.thumbs/256x256/`)
4. Context (does a `SubLayers/` folder exist?)

These four signals together are sufficient to identify the hero in all known NVIDIA SimReady datasets.

## Dependency Resolution

Once you identify the hero stage, determine what else to download:

| Hero characteristics | What to download |
|---------------------|-----------------|
| No sublayers, no external references | Just the hero file — self-contained |
| Has sublayers only | Hero + `SubLayers/*` |
| Has sublayers + payload references to `Props/` | Full dataset for complete rendering |
| Unknown/complex | Download everything to be safe |

For a *quick structural preview* (walls/floor render, some props missing):

```bash
hf download <org>/<dataset> --repo-type dataset --local-dir assets \
  --include "<hero>.usd" --include "SubLayers/*" \
  --include "Props/assembly/*" --include "Props/modular/*"
```

For *full fidelity* (all props, textures, materials resolve):

```bash
hf download <org>/<dataset> --repo-type dataset --local-dir assets
```

## Catalog Discovery

Many NVIDIA datasets include a CSV catalog at the repo root. Download it to browse available assets:

```bash
hf download <org>/<dataset> <catalog>.csv --repo-type dataset --local-dir .
```

For `nvidia/PhysicalAI-SimReady-Warehouse-01`, the catalog is `physical_ai_simready_warehouse_01.csv` with columns:
- `asset_name` — human-friendly name
- `relative_path` — path within the repo (use for download commands)
- `classification` — category (e.g., "Prop general hand manipulation")
- `label` — object type (e.g., "bottle", "Forklift", "Cardboard Box")

Parse it, filter by label or classification, then feed `relative_path` values into `hf download`.

## End-to-End Example

Developer: "I want to use the warehouse stage at huggingface.co/datasets/nvidia/PhysicalAI-SimReady-Warehouse-01 as my test stage"

1. Parse URL → dataset is `nvidia/PhysicalAI-SimReady-Warehouse-01`
2. List root files → one USD: `physical_ai_simready_warehouse_01.usd` (27 KB)
3. Check signals: ✓ root-level, ✓ name matches dataset, ✓ has thumbnail, ✓ `SubLayers/` exists
4. Conclusion: **that's the hero stage**
5. Inspect (if pxr available): defaultPrim=`/World`, upAxis=Z, metersPerUnit=1.0, 6 sublayers
6. Download for development:

```bash
# Structural preview (~24 MB)
hf download nvidia/PhysicalAI-SimReady-Warehouse-01 --repo-type dataset --local-dir ./test-assets \
  --include "physical_ai_simready_warehouse_01.usd" \
  --include "SubLayers/*" \
  --include "Props/assembly/*" \
  --include "Props/modular/*"

# Open: ./test-assets/physical_ai_simready_warehouse_01.usd
# Default prim: /World | Up axis: Z | Meters per unit: 1.0
```

## Curl Fallback (No Python Needed)

For environments where installing packages isn't practical:

```bash
# Public dataset file
curl -L --fail -o asset.usd \
  "https://huggingface.co/datasets/<org>/<dataset>/resolve/main/<path>?download=true"

# Authenticated (gated/private)
curl -L --fail -H "Authorization: Bearer $HF_TOKEN" \
  -o asset.usd \
  "https://huggingface.co/datasets/<org>/<dataset>/resolve/main/<path>?download=true"
```

Verify you got real data: `head -c 8 asset.usd` should show `PXR-USDC` (binary) or `#usda 1.0` (ASCII), not a git-lfs pointer.

## Important Notes

- `huggingface_hub` handles Xet-backed repos transparently (many newer HF repos use Xet storage)
- Downloads cache in `~/.cache/huggingface/` — use `--local-dir` to place files where you need them
- Large downloads resume automatically on retry
- A single `.usd` may reference textures/sublayers via relative paths — preserve directory structure
- Individual SimReady props are 1–100 KB; full datasets can be 10+ GB — be selective with `--include`

## Viewer Integration

After downloading the hero stage:

1. Ensure directory structure is preserved (hero USD uses relative paths like `./SubLayers/...`)
2. Open the hero `.usd` file — it will resolve references to sublayers and props
3. Key metadata for viewer configuration:
   - `defaultPrim` — root prim to load (usually `/World`)
   - `upAxis` — coordinate system (Z-up for SimReady)
   - `metersPerUnit` — scale factor (1.0 = real-world meters)

## Known NVIDIA SimReady Datasets on HF

- `nvidia/PhysicalAI-SimReady-Warehouse-01` — 753 warehouse/manipulation props (~14.4 GB total)
  - Hero: `physical_ai_simready_warehouse_01.usd`
  - 6 sublayers (loading zone, sorting area, unloading/staging, metro racks, floorplan, transporter area)
  - 85 asset labels (Cardboard Box ×151, Warehouse ×43, Pallet ×28, Forklift ×5, etc.)

See also: `usd-sample-data`, `stage-loading`, `stage-management`, `cloud-assets`.
