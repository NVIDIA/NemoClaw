# Qwen3.8 Spark runtime sources and notices

This artifact contains separately licensed components. NemoClaw's build and
supervision code is Apache-2.0. Its license does not replace the upstream licenses.

- The recipe is MiaAI Lab's `Qwen3.8-Flash-Next-Single-DGX-Spark`, revision
  `d03809008834124e80223c3482f2ddb59577a48f`, copyright 2026 MiaAI Lab,
  AGPL-3.0-or-later. The complete pinned source archive, extracted source, and
  license are under `/opt/nemoclaw/source/recipe*`. This includes the launcher,
  downloader, preparation tools, patches, watchdog, and their attribution notices.
- The recipe's QSA patch credits the Apache-2.0 FP8 KV approach from
  `lancelind/qwen3.8-Flash-DGX`. Its PLE patch identifies the upstream vLLM work it
  ports. Those notices remain in the original patch sources.
- vLLM and the runtime's dependencies retain the licenses and notices in the
  pinned base image. Original vLLM files and their patched versions are retained
  under the recipe's `files` directory. `patched-files.json` records their hashes.
- The model snapshot is `Mia-AiLab/Qwen3.8-Flash-Next-NVFP4` revision
  `925d7be6c14c6c9442ef83e8f05b5a3c39304f69`. Its model card declares Apache-2.0
  and credits `local-inference-lab/Qwen3.8-Flash-Next-NVFP4` and the Qwen base model.
  The complete snapshot, including that card, is retained in persistent storage.

`apply_patches.py` adds one fail-closed change after applying the upstream patches:
a missing packed PLE artifact raises an error instead of loading the table into
anonymous RAM. The build recipe, original sources, modified sources, licenses,
and immutable input pins remain available inside the image for inspection and
source retrieval. Nothing from this experiment is published automatically.
