# PhysicsNeMo Taxonomy — Navigation Hints

This file is a **navigation scaffold**, not an inventory. It tells you which top-level folder(s) to search given the user's problem shape. The actual class and file names come from the **live repo** via Glob/Grep/Read — never cite from this file.

All paths are relative to the repo root (resolve per SKILL.md).

---

## Top-level package map (high-stability)

These package directories change only at major releases. Use them as entry points; search inside for current contents.

| Package | Covers |
|---|---|
| `physicsnemo/core/` | Base `Module`, model registry, metadata, function specs. |
| `physicsnemo/models/` | Complete model architectures (FNO, GNN, diffusion, transformers, etc.). Each family in its own subdirectory. |
| `physicsnemo/experimental/` | Provisional models and utilities. **Flag as experimental** when citing. |
| `physicsnemo/nn/` | Reusable layers and functionals (torch.nn-style). |
| `physicsnemo/datapipes/` | Data loading: readers, transforms, datasets, benchmarks, domain-specific pipes. |
| `physicsnemo/distributed/` | Multi-GPU / multi-node setup (DistributedManager, process groups, collectives). |
| `physicsnemo/domain_parallel/` | Sample-too-large-for-one-GPU (ShardTensor). |
| `physicsnemo/optim/` | Custom optimizers / schedulers. |
| `physicsnemo/metrics/` | Evaluation metrics (general + domain-specific). |
| `physicsnemo/utils/` | Checkpointing, logging, profiling, CUDA-graph capture, misc utilities. |
| `physicsnemo/mesh/` | GPU-accelerated mesh data structure + operations. |
| `physicsnemo/diffusion/` | Diffusion framework: preconditioners, samplers, guidance, metrics. |
| `physicsnemo/active_learning/` | Active learning driver, protocols, registry. |
| `physicsnemo/deploy/` | Model export (ONNX). |
| `physicsnemo/compat/` | Backward-compatibility aliases. |

Folders may be added, graduated out of `experimental/`, or removed between releases. Glob `physicsnemo/*/` at the start of discovery and trust that over this table.

---

## Data shape → candidate model families (primary routing axis)

The data shape is the primary routing axis. Multiple model families typically apply to a given shape — this table lists the subdirectories worth searching. Exact class names come from `__init__.py` at search time.

| User's data shape | Candidate subfolders under `physicsnemo/models/` |
|---|---|
| Regular Cartesian grid (1D / 2D / 3D / 4D image-like) | Spectral operators, conv networks, super-resolution nets, recurrent nets, diffusion UNets, diffusion transformers, MLPs |
| Lat-lon or spherical or cubed-sphere | Weather-specific architectures |
| Unstructured mesh, variable topology | Graph-network families, mesh transformers, mesh-reduced variants |
| Point cloud with geometry | Geometry-aware operators (DoMINO-style), point transformers, boundary-element operators (likely in `experimental/`) |
| Time-series on a grid | Recurrent, spatiotemporal transformer variants |
| Time-series on a graph | Auto-regressive graph networks |
| Tabular / coordinate-based | MLP |

**Enumerate ALL candidate families listed for the row that matches the user's data shape — not just the first.** When translating to concrete classes, read every relevant `physicsnemo/models/<family>/__init__.py`. The output skeleton in SKILL.md expects a *menu*, not a single recommendation.

### Cross-example reuse patterns

Datapipes and problems are often shared across model families — that shared structure is what makes the framework composable. Worth checking whether the same datapipe is used by multiple families:

- Darcy-style 2D regression data typically feeds multiple model families (e.g. spectral operators and attention-based operators on the same `Darcy2D`).
- ERA5 climate data underlies several weather architectures simultaneously.
- VTK / point-cloud geometry inputs are consumed by more than one geometry-aware operator family.

These are **hints to verify live**, not ground truth: grep the candidate datapipe class across `examples/` to confirm current reuse, then surface that reuse in the output so the user sees model ↔ datapipe decoupling explicitly.

---

## Example domain map (secondary navigation)

Domains are a secondary navigation layer — useful for finding concrete reference instantiations once the model-family and datapipe menus are known. Subfolder names inside these may change — always Glob the current contents.

| User domain | Look in |
|---|---|
| CFD, fluid dynamics, aerodynamics | `examples/cfd/` |
| Weather, climate, forecasting | `examples/weather/` |
| Structural / solid mechanics, crash | `examples/structural_mechanics/` |
| Healthcare, medical, biomechanics | `examples/healthcare/` |
| Molecular dynamics, chemistry | `examples/molecular_dynamics/` |
| Additive manufacturing, 3D printing | `examples/additive_manufacturing/` |
| Geophysics, seismic, FWI | `examples/geophysics/` |
| Reservoir, subsurface, multiphase | `examples/reservoir_simulation/` |
| Generative design, topology | `examples/generative/` |
| Active learning | `examples/active_learning/` |
| Minimal / scaffolding tutorials | `examples/minimal/` |
| Multi-storage / cloud-data patterns | `examples/multi_storage_client/` |

If the user's domain isn't listed, Glob `examples/*/` and read top-level READMEs to find the closest.

---

## Data format → how to find a datapipe

Do **not** hardcode format-to-subfolder mappings here — the datapipes layout changes. Instead:

1. Glob `physicsnemo/datapipes/*/__init__.py` to enumerate current subpackages.
2. Read each `__init__.py` to see what it exports and what formats its docstrings mention.
3. If no subpackage looks right, grep by format keyword across `physicsnemo/datapipes/`:
   `Grep -l "<format>" physicsnemo/datapipes/ --type py` (e.g. `"HDF5"`, `"zarr"`, `"xarray"`, `"pyvista"`, `"tfrecord"`, `"healpix"`).
4. For custom / unsupported formats, point users at the contractual base classes: `physicsnemo/datapipes/readers/base.py`, `physicsnemo/datapipes/datapipe.py`, `physicsnemo/datapipes/transforms/base.py`. Confirm these files still exist before citing them.

---

## Task type → relevant concepts to search

| User task | Where to look |
|---|---|
| Surrogate modeling (sim → ML approximation) | `examples/<domain>/` + `physicsnemo/models/` matching data shape |
| Temporal forecasting (t_{i-k..i-1} → t_{i..i+n}) | Auto-regressive and recurrent families; weather examples |
| Super-resolution / downscaling | Diffusion models (`physicsnemo/diffusion/` + `physicsnemo/models/diffusion_unets/`-style folders), SR-specific CNNs |
| Inverse problem / data assimilation | Diffusion-based inverse methods; specific examples in `weather/` and `geophysics/` |
| Generative modeling | `physicsnemo/diffusion/` + generative examples |
| Physics-informed (data + PDE residuals) | Examples ending in `_pino` or `_physics_informed` under `examples/cfd/`; `PhysicsInformer` utilities |
| Multi-GPU / multi-node scaling | `physicsnemo/distributed/` |
| Sample-too-large-for-one-GPU | `physicsnemo/domain_parallel/` |
| Checkpoint save/load | `physicsnemo/utils/checkpoint.py` |
| Logging, MLflow, wandb | `physicsnemo/utils/logging/` |
| Model export / deployment | `physicsnemo/deploy/` |
| Active learning | `physicsnemo/active_learning/` + `examples/active_learning/` |

---

## Documentation map

| User intent | Relevant docs folder(s) |
|---|---|
| Getting started / install | Root `README.md`, `docs/index.rst`, `FAQ.md`, `docs/examples_introductory.rst` |
| Choose a model | `docs/api_models.rst`, `docs/api/models/` |
| Data loading | `docs/api/datapipes/` |
| Scale training | `docs/api/physicsnemo.distributed.rst`, `docs/api/physicsnemo.domain_parallel.rst` |
| Meshes | `docs/api/mesh/` |
| Diffusion | `docs/api_diffusion.rst`, `docs/api/diffusion/` |
| Neural network layers | `docs/api/physicsnemo.nn.rst`, `docs/api/physicsnemo.nn.layers.rst`, `docs/api/physicsnemo.nn.functionals.rst` |
| Migration (v1 → v2, modulus → physicsnemo, DGL → PyG) | Root `*MIGRATION*` (glob to find), `README.md` migration section, the DGL→PyG migration markdown under `examples/` (glob `examples/**/*pyg*.md` or `examples/**/*migration*.md` — exact path is not stable) |
| Contributing | Root `CONTRIBUTING.md`, `CODING_STANDARDS/`, `.cursor/rules/` |
| Examples by domain | `docs/examples_<domain>.rst`, `docs/examples_index.rst` |

Always Glob `docs/` before citing — the RST layout evolves.

---

## External resources and companion packages

URLs for hosted docs, the dev blog, the pretrained-model catalog, the Jupyter collection, the forum, and companion repos (CFD inference, Curator, Symbolic, Earth-2 Studio) rot and should not be hardcoded here. Look them up from the canonical sources in the repo itself:

- Root `README.md` — links section and companion-package mentions.
- Root `FAQ.md` — hosts current URLs for forum, NGC catalog, and related repos.

Grep these two files for `https://` when you need a URL, and cite what you find — don't recite from memory.

---

## Decision hints (axes of choice, not class names)

Use these to ask the right disambiguating question. Do **not** emit a concrete class or family name from this section — resolve current names via live discovery in `physicsnemo/models/` and the relevant `examples/<domain>/`.

- **Super-resolution / downscaling**: deterministic vs stochastic (diffusion-based). Ask which.
- **Surrogate for a CFD sim on a geometry**: surface-only vs surface+volume input. Ask which, then search `physicsnemo/models/` for operators that take the right input shape.
- **Global weather forecasting**: multiple architecture families coexist (spectral, mesh-graph, 3D transformer). Read `examples/weather/` and `physicsnemo/models/` `__init__.py` files to see the current options.
- **Regional km-scale weather**: typically different from global — confirm scope, then discover candidates in `examples/weather/`.
- **PDE with arbitrary geometry**: point-cloud / transformer operators; some may still live in `experimental/`.
- **Molecular / particle dynamics**: graph networks with nearest-neighbor or radius-based connectivity.
- **Learn a solution operator for a PDE**: regular-grid vs irregular-geometry is the splitting axis; the current operator families differ on each side.

These hints are deliberately vague on class names — the skill must confirm against the live repo before emitting any.

---

## Common axis-collapse traps to flag

Axes of choice users frequently collapse. Surface the distinction; let live discovery name the current candidates — do not hardcode family names.

- **Grid vs mesh conflation.** Cartesian grid and triangulated mesh need different model families.
- **Weather scope.** Global vs regional km-scale forecasting typically route to different architectures.
- **CFD with geometry + fields.** Surface-only vs surface+volume is the splitting axis.
- **Super-resolution / downscaling.** Deterministic vs stochastic (diffusion-based) is the user's call.
- **Physics-informed ≠ PINN.** Physics loss on a neural operator, coordinate MLP + PDE residuals, or hybrid map to different parts of the repo.
- **GNN backend migration.** PhysicsNeMo is moving from DGL to PyG. Locate the migration doc by globbing — `Glob examples/**/*pyg*.md` or `Glob examples/**/*migration*.md`. Do not cite a path from memory.
- **modulus → physicsnemo rename.** If snippets import `modulus`, point at the migration guide by globbing `*MIGRATION*`.

## Stability of what you cite

- **High stability**: top-level folders directly under `physicsnemo/`, the `examples/<domain>/` split, the `docs/` Sphinx layout. Use as navigation anchors; Glob current contents at the start of discovery.
- **Medium stability**: subdirectories inside top-level folders, example folder names.
- **Low stability**: specific class names, specific file paths inside subdirectories, anything under `experimental/`.

When citing from a medium- or low-stability area, confirm it exists now before returning it.
