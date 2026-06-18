---
name: physical-ai-neural-reconstruction
description: "Router for NVIDIA NuRec/NRE: USDZ rendering, NCore conversion, 3DGS, gRPC sensor sim, PhysicalAI HF datasets. Do NOT use for SimReady or infra setup."
license: Apache-2.0
version: "0.3.0"
tools:
  - Read
  - Shell
compatibility: >-
  Router skill; downstream sibling skills require Docker, NVIDIA Container
  Toolkit, GPU, NGC API key, Hugging Face token with PhysicalAI gated
  licenses accepted, Python 3.10+, and `huggingface_hub`. Optional:
  CARLA / Isaac Sim 5.1 / AlpaSim for simulator integration over
  `serve-grpc`.
metadata:
  author: NVIDIA Physical AI
  tags:
    - physical-ai
    - nurec
    - neural-reconstruction
    - router
    - sensor-sim
  upstream:
    repo: https://github.com/NVIDIA/nurec-skills
    branch: main
    skills_dir: .agents/skills/
    skills_dir_alias: skills/
    index_skill: .agents/skills/SKILL.md
    index_skill_name: nurec-index
    sibling_skills:
      - name: physical-ai-datasets
        folder: physical-ai-datasets/
        upstream: https://huggingface.co/nvidia
      - name: ncore
        folder: ncore/
        upstream: https://github.com/NVIDIA/ncore
      - name: nre
        folder: nre/
        upstream: nvcr.io/nvidia/nre/nre
      - name: asset-harvester
        folder: asset-harvester/
        upstream: https://github.com/NVIDIA/asset-harvester
      - name: nurec-fixer
        folder: nurec-fixer/
        upstream: https://github.com/NVIDIA/harmonizer
        hf_model: https://huggingface.co/nvidia/DiffusionHarmonizer
  upstream_clone_path: "${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}/nurec-skills"
  upstream_override_env: NUREC_SKILLS_UPSTREAM_ROOT
---

# Physical AI Neural Reconstruction (NuRec) Router

## Purpose

This is a **thin router** for NVIDIA Neural Reconstruction (NuRec)
requests. It points at the upstream `nurec-index` skill at
`https://github.com/NVIDIA/nurec-skills` and its five sibling skills
(`physical-ai-datasets`, `ncore`, `nre`, `asset-harvester`,
`nurec-fixer`). Use this skill to:

- Identify which upstream sibling skill answers a NuRec question.
- Locate, clone, or refresh the canonical `nurec-skills` checkout.
- Order multi-step NuRec workflows (data → conversion → train →
  render → cleanup) before opening the upstream recipe.

The canonical recipes (training, rendering, data conversion, dataset
downloads, object harvesting, frame cleanup) live in the upstream
sibling skills. **Never copy or reconstruct their commands here.**

**Do NOT use this skill for:**

- SimReady packaging of CAD or source meshes → use
  `omniverse-cad-to-simready`.
- Generic USD performance tuning unrelated to NuRec → use
  `omniverse-usd-performance-tuning`.
- AKS / OSMO / NIM Operator infrastructure setup → use
  `physical-ai-infrastructure-setup-and-resilient-scaling`.

## When to Use

Read this skill **first** whenever a user mentions any of:

`nurec`, `nurec router`, `nurec index`, `neural reconstruction`,
`neural reconstruction engine`, `NRE`, `3DGUT`, `3DGRT`, `USDZ`,
`NCore V4`, `sensor sim`, `novel view synthesis`,
`PhysicalAI-Autonomous-Vehicles-NuRec`, `PhysicalAI-NuRec-PPISP`,
`Cosmos-Drive-Dreams`, `asset harvester`, `nurec fixer`,
`DiffusionHarmonizer`, `harmonizer`, `difix`, `difix3d`, `serve-grpc`,
`render-grpc`, `warm serve-grpc`, `nre thin client`, `batch_render_rgb`,
`nurec teardown`, "where do I start with NuRec", "which NuRec skill
should I use for X?".

Decide which upstream sibling skill answers the question, fetch it
(see [Locate and fetch the upstream skills](#locate-and-fetch-the-upstream-skills)),
then follow that skill's body.

## Prerequisites

Router skill itself has no runtime prerequisites beyond `git` for
fetching the upstream. Downstream sibling skills require:

- **Docker + NVIDIA Container Toolkit + GPU** — for `nre`, `nre-tools`,
  and `nurec-fixer` containers
  (`nvcr.io/nvidia/nre/nre`, `nvcr.io/nvidia/nre/nre-tools`,
  `nvcr.io/nvidia/cosmos/cosmos-predict2-container:1.2`).
- **NGC API key** (`NGC_API_KEY`) — for pulling NGC containers.
- **Hugging Face token** (`HF_TOKEN`) with the
  `nvidia/PhysicalAI-*`, `nvidia/DiffusionHarmonizer`, and
  `nvidia/asset-harvester` gated licenses **accepted in advance** on
  Hugging Face.
- **Python 3.10+** with `huggingface_hub` installed.
- **(Optional)** CARLA, Isaac Sim 5.1, or AlpaSim for simulator
  integration over `serve-grpc`.

Verify secrets safely (do not echo values):

```bash
hf auth whoami
[ -n "${HF_TOKEN:-}" ]      && echo "HF_TOKEN length=${#HF_TOKEN}"      || echo "HF_TOKEN unset"
[ -n "${NGC_API_KEY:-}" ]   && echo "NGC_API_KEY length=${#NGC_API_KEY}" || echo "NGC_API_KEY unset"
```

See [`references/secrets-handling.md`](references/secrets-handling.md)
for the bash anti-patterns to avoid.

## What is NuRec?

**NuRec** (NVIDIA Omniverse Neural Reconstruction) takes camera, LiDAR,
radar, or stereo recordings — typically from a self-driving car or a
robot — and turns them into a 3D scene you can re-render from any
viewpoint. Names that come up a lot:

- **NRE** — "Neural Reconstruction Engine". NuRec is the product; NRE
  is the engine that trains and renders. Both route to the upstream
  `nre` skill.
- **USDZ** — the file format of a trained scene. A zip archive that
  Omniverse, Isaac Sim, and CARLA can open.
- **NCore V4** — the input format NRE consumes. Raw recordings must be
  converted to NCore V4 before training.
- **3DGUT / 3DGRT** — the two 3D Gaussian Splatting flavours used
  internally by NRE. The default Hydra recipe picks one; most users
  never set it manually.

A typical NuRec project has three stages:

1. **Get the input** — convert your own recording to NCore V4
   (`ncore`), or download a pre-converted dataset
   (`physical-ai-datasets`).
2. **Train the reconstruction** — feed NCore V4 to NRE; out comes a
   USDZ (`nre`).
3. **Render new views** — render images, videos, or LiDAR sweeps from
   the USDZ (`nre`).

Projects that just want to *use* an existing NVIDIA-published scene
skip step 2.

## Pick a skill

Match the user's goal in the left column and open the named upstream
skill on the right. Arrows mean "do these in order".

| I want to… | Upstream skill |
|------------|----------------|
| Find or download a NuRec dataset NVIDIA has published | `physical-ai-datasets` |
| Convert my own camera / LiDAR / radar / depth / stereo recording into NCore V4 | `ncore` |
| Write a new converter for an unsupported sensor setup (drone, RGB-D, ROS 2 bag, COLMAP, ScanNet++) | `ncore` |
| Train a 3D reconstruction from an NCore clip | `ncore` → `nre` |
| Generate the extra inputs NRE needs (segmentation masks, depth, ego mask) | `nre` (uses the `nre-tools` container) |
| Render a USDZ along the original camera positions | `nre` |
| Render at full resolution / highest quality | `nre` (see "Quality presets") |
| Render along a shifted trajectory (e.g. car moved 3 m left) | `nre` |
| Render through a server so CARLA / Isaac Sim / AlpaSim / a custom simulator can ask for frames | `nre` (`serve-grpc`) |
| Render the same USDZ many times back-to-back from Python with minimal per-call latency | `nre` (warm `serve-grpc` + thin Python client / `batch_render_rgb`) |
| Render LiDAR sweeps (point clouds) from a USDZ | `nre` (`render-grpc --lidar`) |
| Skip training and just render a NuRec scene NVIDIA already built | `physical-ai-datasets` → `nre` |
| Extract individual 3D objects (cars, pedestrians) from a driving clip | `asset-harvester` |
| Add, remove, or replace cars / pedestrians in a NuRec scene | `asset-harvester` → `nre` |
| Clean up or harmonize rendered frames (ghosting, floaters, flicker, lighting/shadows) | `nurec-fixer`, **or** `--enable-difix` inside `nre` for inline rendering |
| Export the scene as a PLY, mesh, depth maps, ego mask, etc. | `nre` |
| Upgrade an old USDZ so newer NRE versions load it faster | `nre` (`upgrade-artifact`) |
| Open a USDZ or PLY in a browser viewer | `nre` (`viewer` / `ply_viewer`) |
| Measure rendering quality (PSNR, SSIM, LPIPS) against ground truth | `nre` (`eval-rendering-metrics`) |
| Benchmark different reconstruction methods on the same scenes | `physical-ai-datasets` (`PhysicalAI-NuRec-PPISP`) → `nre` |
| Train on multiple GPUs or on SLURM | `nre` (Workflow D) |

## Common workflows

Six end-to-end workflows are documented in
[`references/workflows.md`](references/workflows.md):

- **A.** Make a NuRec scene from your own recording.
- **B.** Use a NuRec scene NVIDIA has already trained.
- **C.** Add, remove, or replace 3D objects in a scene.
- **D.** Clean up rendered frames.
- **E.** Benchmark reconstruction quality.
- **F.** Connect NuRec to a simulator.

Open that file when the user's task spans more than one sibling skill.

## Sibling skills (upstream)

| Name | Upstream folder | What it does |
|------|-----------------|--------------|
| `physical-ai-datasets` | `.agents/skills/physical-ai-datasets/` | Catalog and download recipes for every NVIDIA Physical AI dataset on Hugging Face (driving, robotics, manipulation, NuRec scenes, benchmarks). |
| `ncore` | `.agents/skills/ncore/` | Converts any sensor recording to NCore V4 (the format NRE needs). Also covers writing a new converter. |
| `nre` | `.agents/skills/nre/` | The Neural Reconstruction Engine itself. Trains, renders (locally, via warm `serve-grpc` + thin Python client / `batch_render_rgb`, or to an external simulator), exports meshes / point clouds / depth, edits actors, evaluates quality. |
| `asset-harvester` | `.agents/skills/asset-harvester/` | Open-source Apache-2.0 pipeline that extracts individual 3D objects from sparse views in a driving clip and saves them as `.ply` Gaussian splats with metadata. |
| `nurec-fixer` | `.agents/skills/nurec-fixer/` | Standalone NVIDIA **DiffusionHarmonizer** workflow — public successor to the older Fixer / Difix3D+ recipes — that cleans rendered frames, harmonizes inserted actors, evaluates PSNR/LPIPS, and optionally fine-tunes the model. |

For naming overlaps (NRE vs Fixer, ncore vs nre, AV-NuRec vs
Cosmos-Drive-Dreams, NuRec vs SimReady) see
[`references/mix-ups.md`](references/mix-ups.md).

## Locate and fetch the upstream skills

Quick recipe (full version in
[`references/upstream-fetch.md`](references/upstream-fetch.md)):

```bash
UPSTREAM_ROOT="${NUREC_SKILLS_UPSTREAM_ROOT:-${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}}"
mkdir -p "$UPSTREAM_ROOT"
if [ -d "$UPSTREAM_ROOT/nurec-skills/.git" ]; then
  git -C "$UPSTREAM_ROOT/nurec-skills" fetch --tags
  git -C "$UPSTREAM_ROOT/nurec-skills" checkout main
  git -C "$UPSTREAM_ROOT/nurec-skills" pull --ff-only
else
  git clone --depth 1 https://github.com/NVIDIA/nurec-skills.git \
    "$UPSTREAM_ROOT/nurec-skills"
fi
test -f "$UPSTREAM_ROOT/nurec-skills/.agents/skills/SKILL.md"
```

Then read the upstream skill before running any mutating command:

```bash
cat "$UPSTREAM_ROOT/nurec-skills/.agents/skills/SKILL.md"          # router
cat "$UPSTREAM_ROOT/nurec-skills/.agents/skills/<folder>/SKILL.md" # sibling
```

Local lookup order (try in order before the upstream clone):

1. `.agents/skills/<name>/SKILL.md` (Cursor, Codex, NemoClaw)
2. `.claude/skills/<name>/SKILL.md` (Claude Code)
3. `.cursor/skills/<name>/SKILL.md` (project-scoped)
4. `~/.cursor/skills/<name>/SKILL.md` (personal skills)

## Hard Rules

- Router only — do not duplicate upstream NuRec recipes here. Read
  the upstream sibling skill body before running any mutating command.
- Refer to sibling skills by their `name:` (e.g. `nre`), not by repo
  path. Folder layouts can change; the name is portable.
- Clone or refresh `https://github.com/NVIDIA/nurec-skills` under the
  shared upstream root
  (`${NUREC_SKILLS_UPSTREAM_ROOT:-${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}}/nurec-skills`).
  Do not scan broad developer workspaces such as `~/Codes` or reuse
  unrelated old clones.
- `physical-ai-datasets` covers gated Hugging Face datasets. Do not
  bypass dataset license terms; the user must accept the
  `PhysicalAI-*` gated licenses on Hugging Face and provide a token
  before downloading.
- Asset Harvester runs **before** packaging into a USDZ. Do not call
  `nre`'s `export-external-assets` on hand-rolled `.ply` files unless
  the user explicitly asks to skip Asset Harvester.
- For artifact cleanup, prefer the built-in `--enable-difix` path in
  `nre`. Route to the standalone `nurec-fixer` only when the user
  needs the public code/model card, paired evaluation, fine-tuning,
  or fixes on previously rendered frames.
- Do not invent NRE / NCore / DiffusionHarmonizer commands from
  memory. Re-read the upstream sibling skill — versions move fast
  (NRE `release_26.04` is the current pinned tag).
- This router does not deploy infrastructure. Route AKS / OSMO /
  NIM Operator setup to
  `physical-ai-infrastructure-setup-and-resilient-scaling`.

## Limitations

- **Router only.** This skill never executes mutating NuRec commands.
  All training, rendering, conversion, and harmonization happens in
  upstream sibling skills.
- **Upstream-pinned.** Recipes live in
  `https://github.com/NVIDIA/nurec-skills`, which evolves outside
  this repo. Stale clones can drift; always `git pull` the upstream
  before relying on a sibling skill.
- **Gated content.** `nvidia/PhysicalAI-*`, `nvidia/DiffusionHarmonizer`,
  and `nvidia/asset-harvester` require the user to accept license
  terms on Hugging Face first. The router cannot bypass this.
- **Heavy footprint.** A complete NuRec workflow can leave 150 GB+
  on disk. See [`references/teardown.md`](references/teardown.md).
- **NVIDIA-only stack.** Requires an NVIDIA GPU plus the NVIDIA
  Container Toolkit. AMD / Intel / Apple Silicon are not supported.
- **Not a SimReady pipeline.** NuRec produces a renderable USDZ from
  a recording; SimReady packaging of CAD or source meshes is a
  different pipeline (see `omniverse-cad-to-simready`).

## Troubleshooting

| Error / symptom | Likely cause | Solution |
|-----------------|--------------|----------|
| `nurec-skills` clone missing or empty | Upstream not fetched yet | Run the clone block in [Locate and fetch the upstream skills](#locate-and-fetch-the-upstream-skills) |
| `403`/`401` pulling `nvidia/PhysicalAI-*` from HF | Gated license not accepted, or `HF_TOKEN` unset / wrong scope | Accept the gated license on Hugging Face, then `hf auth login` with a token that has `read` access |
| `denied: requested access to the resource is denied` from `nvcr.io/nvidia/nre/*` | Missing or expired `NGC_API_KEY` | `docker login nvcr.io` with `$oauthtoken` / `NGC_API_KEY`; rotate the key at `org.ngc.nvidia.com/setup/api-key` if needed |
| NRE refuses to load a clip ("not valid NCore V4") | Recording was not converted | Run the `ncore` skill before invoking `nre` |
| `serve-grpc` cold-start latency dominates a Python loop | One-shot Docker invocation per render | Use the `nre` warm `serve-grpc` + thin Python client (`batch_render_rgb`) recipe |
| Output files are owned by `root` after a `docker run` | `-u $(id -u):$(id -g)` was missing | `sudo chown -R "$(id -u):$(id -g)" <output_dir>`; add the `-u` flag next time |
| Frames have ghosting / floaters / flicker after rendering | Inline cleanup not enabled | Re-render with `nre --enable-difix`, or post-process with `nurec-fixer` (DiffusionHarmonizer) |
| Stale skill names (`ncore-data-conversion`, old `nvidia/Fixer`) in agent output | Out-of-date cached skill | Update references to `ncore` and `nurec-fixer` (DiffusionHarmonizer); see [`references/maintenance.md`](references/maintenance.md) |
| Bash anti-pattern `${HF_TOKEN:+yes}${HF_TOKEN:-no}` echoed token value | Misuse of bash parameter expansion | Rotate the token; use `hf auth whoami` or length-only checks (see [`references/secrets-handling.md`](references/secrets-handling.md)) |

## Cross-skill teardown

A complete NuRec workflow can leave **150 GB+** on disk between
container images, model weights, code clones, conda envs, and output
directories. Each sibling skill has its own dedicated `Teardown`
section — read them in the order documented in
[`references/teardown.md`](references/teardown.md) when the user no
longer needs the workflow.

## Keeping this router up to date

Procedure for adding new sibling skills, renames, or upstream URL
changes lives in [`references/maintenance.md`](references/maintenance.md).
Treat the upstream `nurec-index` at
<https://github.com/NVIDIA/nurec-skills/blob/main/.agents/skills/SKILL.md>
as authoritative; this skill mirrors only the picker tables, the
workflow ordering, and the upstream fetch recipe.
