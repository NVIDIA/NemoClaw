# Common NuRec Workflows

Each workflow lists the upstream skills to read in order, with a one-line
summary of what to do in each one. Open the named skill for the full
recipe — never reconstruct the steps from the router page alone.

## A. Make a NuRec scene from your own recording

Use this when the user has a fresh sensor log and wants a renderable
3D scene at the end.

1. `ncore` — convert the recording to NCore V4. The skill ships
   built-in converters for PAI, Waymo, NuScenes, PandaSet, COLMAP,
   and ScanNet++; for anything else it walks you through writing a
   new converter.
2. `nre` — generate the auxiliary inputs (depth, segmentation, ego
   mask), train, and validate. Output is a USDZ. Render it three ways:
   with the local `nre render` CLI; with a warm `serve-grpc` server
   driven by the bundled thin Python gRPC client (`batch_render_rgb`
   for repeated / multi-camera renders); or by handing the USDZ to a
   simulator over the public gRPC API.

## B. Use a NuRec scene NVIDIA has already trained

Use this when the user just wants to see NuRec working without
training anything.

1. `physical-ai-datasets` — accept the gated AV license on Hugging
   Face, then download **one** scene (~1.5–2 GB) from
   `PhysicalAI-Autonomous-Vehicles-NuRec`. The full dataset is
   ~1.5 TB, so don't pull all of it.
2. `nre` — render the USDZ. The "highest quality" preset renders at
   original resolution along the original camera positions; ask for
   new camera positions through the gRPC server.

## C. Add, remove, or replace 3D objects in a scene

1. `ncore` — make sure the original NCore clip is still on disk;
   Asset Harvester needs it to crop the object views.
2. `asset-harvester` — point it at the object IDs you care about.
   For each one, it produces a `.ply` (3D Gaussian model) plus a
   `metadata.yaml` (size, position, label).
3. `nre` — package those `.ply` files into the USDZ and edit the
   scene with `serve-grpc --enable-editing-actors` plus
   `render-grpc --edit-assets`. The skill ships a JSON schema for the
   add / remove / replace operations.

## D. Clean up rendered frames

NuRec sometimes leaves visible artifacts (floating dots, ghosting,
frame-to-frame flickering) or object-insertion mismatches (lighting,
shadows, color). Two ways to fix this — pick one:

- **Quick path** — turn on `--enable-difix` when starting the gRPC
  server in `nre`. NRE owns this inline rendering integration. Default
  for users who are already rendering through NRE.
- **Standalone path** — render frames first with `nre`, then run
  `nurec-fixer` (NVIDIA DiffusionHarmonizer) on the folder of frames.
  Use this when you want the public DiffusionHarmonizer code / model
  card, paired evaluation, fine-tuning, or fixes for frames that were
  rendered earlier without re-running NRE.

## E. Benchmark reconstruction quality

1. `physical-ai-datasets` — download `PhysicalAI-NuRec-PPISP` (~15 GB
   of outdoor scenes captured at three exposure levels for fair
   comparisons).
2. `ncore` — only needed when re-building the NCore shards. The
   dataset ships with both COLMAP and NCore V4 versions, so usually
   skip this.
3. `nre` — train, then run `eval-rendering-metrics` against the
   ground-truth frames the dataset includes.

## F. Connect NuRec to a simulator

CARLA, Isaac Sim, AlpaSim, or any custom simulator can ask NRE for
frames over a network API.

1. `physical-ai-datasets` — pick a USDZ if you don't already have one.
2. `nre` — start the server with `serve-grpc`. The simulator sends a
   camera position and timestamp; NRE returns an image (or a LiDAR
   sweep). The server also supports adding / removing actors and the
   built-in Fixer.
3. If you don't already have a simulator and just want a Python
   driver loop, `nre` ships a thin host-side gRPC client
   (`references/NRE_RenderClient/SKILL.md`,
   `scripts/session_warm_server.sh`, `thin_client.py`,
   `batch_render_rgb`) that keeps one warm `serve-grpc` container up
   for the session and avoids the per-call Docker / Python / CUDA
   cold start.
4. If you're writing a new client and need to convert between map
   coordinates and NuRec's coordinate system, `nre`'s
   `physical-ai-render` reference has the recipe.
