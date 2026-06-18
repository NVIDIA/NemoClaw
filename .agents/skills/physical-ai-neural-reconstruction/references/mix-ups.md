# Easy Mix-Ups

These pairs sound similar but are different things. When in doubt,
come back to the router.

- **NuRec vs NRE.** NuRec is the product name; NRE is the engine
  inside it. Both map to the upstream `nre` skill.
- **NRE's built-in Fixer vs standalone DiffusionHarmonizer.** `nre`'s
  `--enable-difix` flag is an inline NRE rendering feature that runs
  a built-in Fixer / Difix3D+ variant inside the NRE container as it
  renders. The `nurec-fixer` skill now wraps the standalone public
  **NVIDIA DiffusionHarmonizer** release — code at
  <https://github.com/NVIDIA/harmonizer>, model at
  <https://huggingface.co/nvidia/DiffusionHarmonizer>, paired data at
  `nvidia/DiffusionHarmonizer-Dataset`, paper
  <https://arxiv.org/abs/2602.24096>, container
  `nvcr.io/nvidia/cosmos/cosmos-predict2-container:1.2`. Default to
  the built-in `--enable-difix` for live rendering; reach for
  `nurec-fixer` when you need the public code/model card, paired
  evaluation, fine-tuning, or fixes on frames that were rendered
  earlier without re-running NRE. Do not assume the two paths share
  cache layout or weights unless the NRE tag's own docs say so.
- **`ncore` vs `nre`.** They run **in order**, never as alternatives.
  `ncore` produces the input format; `nre` reads it. (Older
  snapshots called this skill `ncore-data-conversion`; update any
  stale links to `ncore`.)
- **`asset-harvester` vs `nre`'s `export-external-assets`.** Asset
  Harvester **produces** the per-object `.ply` files; `nre`'s
  `export-external-assets` **packages** them into a USDZ. Always
  Asset Harvester first.
- **`Cosmos-Drive-Dreams` vs `PhysicalAI-Autonomous-Vehicles-NuRec`.**
  Both are AV datasets on Hugging Face, both managed by
  `physical-ai-datasets`, but they are different things.
  Cosmos-Drive-Dreams is **synthetic** weather-augmented video
  (CC-BY-4.0). The NuRec dataset is **real** driving scenes turned
  into renderable USDZs under the gated AV License.
- **NuRec vs SimReady.** NuRec produces a renderable USDZ from a
  recording. SimReady packaging of CAD or source meshes is a
  different pipeline — route those requests to the
  `omniverse-cad-to-simready` skill in this repo.
