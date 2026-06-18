# USD Sample Data

## Triggers

Use this skill for I need sample data, find USD assets, get me a scene, download USD, sample scenes, test data, USD examples, or need a stage to load.

Use this skill when a developer needs sample OpenUSD data for an `ovrtx` viewer and does not already have scenes. Prefer local filesystem paths because `ovrtx` loads stages and their dependencies from disk.

Recommended storage root:

```bash
export USD_ASSET_ROOT="${USD_ASSET_ROOT:-/path/to/usd-assets}"
mkdir -p "$USD_ASSET_ROOT"
```

## Fast Choices

| Need | Use |
|---|---|
| Official viewer samples | `stage01.usd` / `stage02.usd` from `https://d4i3qtqj3r0z5.cloudfront.net/omni.usd_viewer.samples-106.3.3.zip` |
| Fast smoke test | `stage01` / `stage02` from the official viewer samples, or NVIDIA Scene Templates |
| Small material/variant test | `usd-wg/assets` StandardShaderBall |
| Demo scene | OldAttic, Kitchen Set, or a small Marbles subset with required dependencies |
| Renderer stress test | full Marbles, Showcases, Sample Scenes pack |
| Production-scale stress | full Sample Scenes, ALab, or Moana |

## Official USD Viewer Sample Stages (stage01 / stage02)

These are the actual sample stages used by the Omniverse USD Viewer extension. Use them when an agent needs the viewer's default sample scenes with known-good USD composition, PBR materials, and texture coverage.

Direct download URL, no auth required:

```text
https://d4i3qtqj3r0z5.cloudfront.net/omni.usd_viewer.samples-106.3.3.zip
```

The zip is about 38 MB total and contains `samples_data/` with `stage01.usd`, `stage02.usd`, `materials/`, `textures/`, and referenced sub-USD files.

Download and unzip:

```bash
export USD_ASSET_ROOT="${USD_ASSET_ROOT:-/path/to/usd-assets}"
mkdir -p "$USD_ASSET_ROOT/usd_viewer_samples"

curl -L https://d4i3qtqj3r0z5.cloudfront.net/omni.usd_viewer.samples-106.3.3.zip -o /tmp/omni.usd_viewer.samples.zip
unzip -q /tmp/omni.usd_viewer.samples.zip -d $USD_ASSET_ROOT/usd_viewer_samples
```

After unzipping, load:

```text
$USD_ASSET_ROOT/usd_viewer_samples/samples_data/stage01.usd
$USD_ASSET_ROOT/usd_viewer_samples/samples_data/stage02.usd
```

This is the recommended source for agents needing the official viewer default sample scenes.

## NVIDIA Omniverse Downloadable Packs

Source page: `https://docs.omniverse.nvidia.com/usd/latest/usd_content_samples/downloadable_packs.html`

CDN base: `https://d4i3qtqj3r0z5.cloudfront.net/`

No auth is required. Use `curl -L` and keep each pack in its own directory so relative asset references stay intact after unzip.

| Pack | Size | Direct URL | Notes |
|---|---:|---|---|
| Default Scene Templates | 24 MB | `https://d4i3qtqj3r0z5.cloudfront.net/Scene_Templates_NVD%4010011.zip` | 10 template scenes; best quick-start pack |
| Sample Scenes | 26 GB | `https://d4i3qtqj3r0z5.cloudfront.net/Sample_Scenes_NVD%4010013.zip` | 441 assets; includes Old Attic, Marbles, composed scenes |
| Showcase Scenes | 2.3 GB | `https://d4i3qtqj3r0z5.cloudfront.net/Showcases_Content_NVD%4010011.zip` | 2 RTX showcase scenes; depends on Sample Scenes |
| Commercial | 5.8 GB | `https://d4i3qtqj3r0z5.cloudfront.net/Commercial_NVD%4010013.zip` | 82 office assets; needs Base Materials |
| Industrial | 1.8 GB | `https://d4i3qtqj3r0z5.cloudfront.net/Industrial_NVD%4010012.zip` | 72 industrial components |
| Residential | 22.5 GB | `https://d4i3qtqj3r0z5.cloudfront.net/Residential_NVD%4010012.zip` | 507 residential assets |
| Warehouse | 18 GB | `https://d4i3qtqj3r0z5.cloudfront.net/Warehouse_NVD%4010013.zip` | 763 warehouse components |
| Base Materials | 8.2 GB | `https://d4i3qtqj3r0z5.cloudfront.net/Base_Materials_NVD%4010013.zip` | Required by Commercial pack |
| Environments | varies | `https://d4i3qtqj3r0z5.cloudfront.net/Environments_NVD%4010012.zip` | HDR domes and skies |
| Characters | 891 MB | `https://d4i3qtqj3r0z5.cloudfront.net/Characters_NVD%4010012.zip` | Rigged assets; viewer usually does not support animation playback |

### Download a CloudFront Pack

```bash
export USD_ASSET_ROOT="${USD_ASSET_ROOT:-/path/to/usd-assets}"
mkdir -p "$USD_ASSET_ROOT/downloads" "$USD_ASSET_ROOT/Scene_Templates"

curl -L \
  "https://d4i3qtqj3r0z5.cloudfront.net/Scene_Templates_NVD%4010011.zip" \
  -o "$USD_ASSET_ROOT/downloads/Scene_Templates_NVD.zip"

unzip -q "$USD_ASSET_ROOT/downloads/Scene_Templates_NVD.zip" \
  -d "$USD_ASSET_ROOT/Scene_Templates"
find "$USD_ASSET_ROOT/Scene_Templates" -iname "*.usd" -o -iname "*.usda" -o -iname "*.usdc"
```

For large packs, prefer resumable downloads:

```bash
curl -L -C - \
  "https://d4i3qtqj3r0z5.cloudfront.net/Sample_Scenes_NVD%4010013.zip" \
  -o "$USD_ASSET_ROOT/downloads/Sample_Scenes_NVD.zip"
```

## NVIDIA Public S3 Bucket

Bucket host: `omniverse-content-production.s3.us-west-2.amazonaws.com`

Use AWS CLI with unsigned requests:

```bash
python3 -m pip install --user awscli
export USD_ASSET_ROOT="${USD_ASSET_ROOT:-/path/to/usd-assets}"
mkdir -p "$USD_ASSET_ROOT/NVIDIA_Samples"

aws s3 sync --no-sign-request \
  "s3://omniverse-content-production/Samples/Marbles/" \
  "$USD_ASSET_ROOT/NVIDIA_Samples/Marbles/"
```

Use HTTPS for individual files when the exact key is known:

```bash
curl -L \
  "https://omniverse-content-production.s3.us-west-2.amazonaws.com/Samples/Marbles/<path-to-file.usd>" \
  -o "$USD_ASSET_ROOT/NVIDIA_Samples/Marbles/<path-to-file.usd>"
```

Useful prefixes:

| Prefix | Size | Notes |
|---|---:|---|
| `Samples/Marbles/` | 4.5 GB, 3,892 files | Excellent stress test; root prim is `/stage` |
| `Samples/OldAttic/` | 1.5 GB, 929 files | Good composed scene for demo work |
| `Samples/Showcases/` | 14.7 GB, 1,462 files | Larger RTX showcase scenes |
| `Samples/Examples/` | 29 GB, 11K files | Broad sample corpus |
| `Samples/Flight/` | 4.3 GB | Flight-themed scene content |
| `Samples/Astronaut/` and `Samples/EuclidVR/` | 1.5 GB combined | Character/VR-oriented samples |

### Sync a Selective Prefix

```bash
export USD_ASSET_ROOT="${USD_ASSET_ROOT:-/path/to/usd-assets}"
mkdir -p "$USD_ASSET_ROOT/NVIDIA_Samples/OldAttic"

aws s3 sync --no-sign-request \
  "s3://omniverse-content-production/Samples/OldAttic/" \
  "$USD_ASSET_ROOT/NVIDIA_Samples/OldAttic/"
```

To inspect a prefix before downloading:

```bash
aws s3 ls --no-sign-request "s3://omniverse-content-production/Samples/Marbles/" --recursive --human-readable --summarize
```

For a subset, start from the root `.usd` and include every referenced layer, texture, MDL, and material file. If any dependency is missing, the Omniverse Realtime Viewer may load a gray or partial scene. Full prefix sync is usually faster than debugging broken relative references for large NVIDIA samples.

## External USD Sources

| Source | URL | Use |
|---|---|---|
| USD Working Group assets | `https://github.com/usd-wg/assets` | 30+ PBR test assets with variants, skeletons, and material coverage |
| StandardShaderBall live asset | `https://prefrontalcortex.github.io/usd-wg-assets/full_assets/StandardShaderBall/layers/shaderball/` | Quick shader/material smoke test |
| OpenUSD samples | `https://openusd.org/release/dl_downloads.html` | Kitchen Set, City Set, and UsdSkel examples; accept the displayed license before download |
| ALab / DPEL | `https://dpel.aswf.io/` and `https://github.com/DigitalProductionExampleLibrary/ALab` | Full production USD scene with characters; large download and registration/download-page flow may apply |
| Intel 4004 Moore Lane | `https://dpel.aswf.io/4004-moore-lane/` | House interior/exterior for ray-tracing tests; direct package is `https://dpel-assets.aswf.io/4004-moore-lane/intel_moorelane_v1_2_0.zip` |
| DPEL OpenPBR Shader Playground | `https://github.com/DigitalProductionExampleLibrary/OpenPBRShaderPlayground` | MaterialX/OpenPBR/USD material testing |
| Moana Island Scene | `https://www.disneyanimation.com/resources/moana-island-scene/` | Production-scale island scene; use the USD package for USD testing |

Clone `usd-wg/assets`:

```bash
export USD_ASSET_ROOT="${USD_ASSET_ROOT:-/path/to/usd-assets}"
mkdir -p "$USD_ASSET_ROOT"
git clone https://github.com/usd-wg/assets.git "$USD_ASSET_ROOT/usd-wg-assets"
find "$USD_ASSET_ROOT/usd-wg-assets" -iname "*.usd" -o -iname "*.usda" -o -iname "*.usdc"
```

Download Intel 4004 Moore Lane:

```bash
export USD_ASSET_ROOT="${USD_ASSET_ROOT:-/path/to/usd-assets}"
mkdir -p "$USD_ASSET_ROOT/downloads" "$USD_ASSET_ROOT/Intel_4004_Moore_Lane"

curl -L -C - \
  "https://dpel-assets.aswf.io/4004-moore-lane/intel_moorelane_v1_2_0.zip" \
  -o "$USD_ASSET_ROOT/downloads/intel_moorelane_v1_2_0.zip"

unzip -q "$USD_ASSET_ROOT/downloads/intel_moorelane_v1_2_0.zip" \
  -d "$USD_ASSET_ROOT/Intel_4004_Moore_Lane"
```

Clone OpenPBR Shader Playground:

```bash
export USD_ASSET_ROOT="${USD_ASSET_ROOT:-/path/to/usd-assets}"
git clone https://github.com/DigitalProductionExampleLibrary/OpenPBRShaderPlayground.git \
  "$USD_ASSET_ROOT/OpenPBRShaderPlayground"
```

## Quality Tiers

| Tier | Recommendations |
|---|---|
| Quick start | bundled `stage01` / `stage02`, Scene Templates pack, `usd-wg/assets` StandardShaderBall |
| Demo-quality | Marbles subset with dependencies, OldAttic, Kitchen Set |
| Stress test | full Marbles, Showcase Scenes, full Sample Scenes pack |
| Production-scale | full Sample Scenes, ALab, Moana |

Quick-start zip sizes can exceed the tier name. Choose by stage complexity and load time, not only archive size.

## Directory Layout

Keep each source unpacked under one stable root:

```text
/path/to/usd-assets/
  Scene_Templates/
  NVIDIA_Samples/
    Marbles/
    OldAttic/
  usd-wg-assets/
  Intel_4004_Moore_Lane/
```

Do not flatten directories. USD layers, textures, MDL files, and payloads often use relative paths.

## Omniverse Realtime Viewer Integration Notes

- Marbles uses root prim `/stage`; many other samples use `/World`. Detect the root prim dynamically and pass it through `openStageResult`.
- The frontend `openStageRequest` sent on WebRTC connect can override a server-loaded stage. Match defaults on both sides or let the server's initial state be authoritative.
- Large scenes over 1 GB need async stage loading, progress/error state, and skip-reload logic for the currently loaded normalized path.
- First load with new MDL/materials can spend several minutes compiling shaders. A 4 minute first load is plausible for Marbles-class content.
- Keep sample stages on a fast local disk. Use `/path/to/usd-assets/<PackName>/` or a configurable `USD_ASSET_ROOT`.
- Never substitute a browser 3D renderer for large or unsupported samples. The Omniverse Realtime Viewer still uses server-side `ovrtx`; the browser only displays the WebRTC video stream.
- After any stage switch, rebuild hierarchy, native pickability state, selection state, and native selection outline groups.

### Sample Data Directory Layout For Deployment

The download script (or zip extraction) places samples in `samples/samples_data/`. However, the server expects `samples_data/` as a sibling directory (not nested under `samples/`). The `_ovrtx_composite_*.usda` files reference stage USD files by relative path (e.g., `./stage01.usd`), so the composite and the referenced stage USD must be in the same directory.

Correct layout for the server:

```text
/app/samples_data/
  stage01.usd
  stage02.usd
  _ovrtx_composite_stage01.usda
  _ovrtx_composite_stage02.usda
  materials/
  textures/
```

Incorrect (nested) layout that breaks relative references:

```text
/app/samples/samples_data/    ← extra nesting breaks relative paths
  stage01.usd
  ...
```

When deploying, ensure you copy or symlink the `samples_data/` contents to the path the server's `--stage` argument expects. For Docker images, `COPY samples_data/ /app/samples_data/` is sufficient if the build context has the correct flat structure.

See also: `huggingface-usd`, `usd-viewer-app`, `stage-management`, `stage-loading`, `cloud-assets`, `render-settings`, `streaming-server`, `streaming-client`.
