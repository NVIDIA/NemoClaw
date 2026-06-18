# Cross-Skill Teardown

A complete NuRec workflow can leave **150 GB+ on disk** between
container images, model weights, code clones, conda envs, and output
directories. Each sibling skill has its own dedicated "Teardown"
section — read them in this order when the user no longer needs the
workflow:

| Sibling skill | Approximate footprint | Where the cleanup lives |
|---------------|------------------------|--------------------------|
| `nre` | ~120 GB images + caches + per-run outputs | `Teardown` section + `references/teardown.md` in the pinned NRE version |
| `nurec-fixer` | 100 GB+ possible (Cosmos image / build cache, HF model + dataset, checkout, outputs) | `Teardown` section + `references/teardown.md` in the pinned DiffusionHarmonizer version |
| `asset-harvester` | ~30 GB conda envs + checkpoints + outputs | `Teardown` section in the pinned Asset Harvester version |
| `ncore` | clip-dependent | NCore shards live under `<dataset_dir>/`; delete after `nre` training is done |
| `physical-ai-datasets` | dataset-dependent | HF caches under `${HF_HOME:-$HOME/.cache/huggingface}/hub/`; remove the per-dataset directory |

Two practical rules that apply across every container-based sibling:

1. Pin `-u $(id -u):$(id -g)` on every `docker run` so outputs land
   owned by the user, not by `root`. If outputs end up `root`-owned
   anyway, recover with
   `sudo chown -R "$(id -u):$(id -g)" <output_dir>` before deleting.
2. Do **not** revoke `NGC_API_KEY` / `HF_TOKEN` as part of teardown
   unless they were leaked — they are per-user and shared across
   every NVIDIA workflow on the host.
