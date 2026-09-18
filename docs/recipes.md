<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inline Model Recipes

An [ordinary vLLM service](../examples/spark/vllm.yaml) needs a pinned image and model snapshot.
Use [the ordinary vLLM image build](build.md#build-a-runtime-image).
Add `service.recipe` when the model needs preparation or serving features supplied by its runtime image.

The CLI does not load recipe code.
Recipe authors package their executables, patches, licenses and source notices in that image; the YAML declares their contract.

See [the inline Qwen example](../examples/spark/spark-inline.yaml).
Use [the Qwen3.8 image build](build.md#build-a-runtime-image) and CLI bundle from this checkout, and replace the example's runtime image reference with your build's digest.
The example's existing image pin belongs to an earlier [validation run](validation/rust-recipe-removal-linux-arm64.json).
Model storage must use the [current manifest format](models.md#retained-model-files); `reuse` does not migrate an older model manifest.

The build loads the image locally without publishing it.
Its model-specific adapters, model manifest, and semantic verifier live in `runtimes/qwen38`, outside the generic execution path.
All vLLM services use `backend: vllm`.
Model-specific backend names and the built-in recipe registry have been removed.

## Declaration

The contract is inline, with `apiVersion: nemoclaw.nvidia.com/recipe/v1`.
It contains:

- `compatibility`: target architecture, GPU name, minimum driver and host memory, and required image labels.
  Images must declare `org.nemoclaw.recipe.protocol: v1`.
  Other labels describe required features.
- `preparation` and `verification`: absolute executable paths inside the image and SHA-256 hashes.
  These are executable files, not shell command strings.
- `resources`: maximum prepared bytes, preparation memory in GiB, serving GPU budget in bytes, and startup headroom in GiB.
  The serving GPU budget includes the model, caches, and other GPU allocations.
- `serving`: model name, parser names, cache dtypes, lazy loading, chunked prefill, optional typed compilation settings, and `VLLM_` environment values.
  `preparedEnvironment` maps environment names to paths relative to the verified preparation directory; `.` selects that directory.
- `licenses` and `sourceNotices`: paths to retained files inside the pinned image.

Recipe memory requirements are checked against measurements from the execution host.
The runtime rechecks preparation and startup headroom.
The shared resident watchdog continues enforcing the service's memory protection policy after the CLI exits.

Declaring a new hardware combination does not constitute live qualification; the current inline Qwen example targets the DGX Spark.

An optional `snapshot` carries the exact model file manifest, including sizes and hashes.
Otherwise the shared downloader resolves the pinned repository and revision.
An optional `reuse` names an existing snapshot directory relative to `/data` and a previous preparation key.

The runtime verifies imported files again before recording the new preparation as complete.
The inline Qwen example uses these fields to reuse its earlier snapshot and packed bytes.

## Execution Protocol

Both executables receive one JSON request on stdin:

```json
{
  "apiVersion": "nemoclaw.nvidia.com/recipe-execution/v1",
  "modelDirectory": "/data/models/selected-snapshot",
  "outputDirectory": "/data/prepared/KEY.preparing",
  "previousDirectory": null
}
```

`previousDirectory` is a candidate from `reuse`, if declared; it may not exist.
Preparation owns how to resume its unpublished output.
It must leave previous published data intact.

Preparation exits successfully after producing candidate files.
Verification independently checks those candidates and returns JSON on stdout:

```json
{
  "files": [
    {
      "name": "packed.bin",
      "size": 12,
      "sha256": "REPLACE_WITH_64_HEX_DIGITS"
    }
  ]
}
```

Names are relative to the staging directory.
Duplicate names, traversal, symlinked output paths, incomplete hashes, and output beyond the declared byte budget fail verification.
The runtime independently hashes the listed files and writes `manifest.json` with the preparation key, file names, sizes, hashes, and modification times.
It then atomically renames the staging directory into place.
`manifest.json` is reserved for the runtime and cannot be a recipe output path.

It limits protocol output to 1 MiB and each tool invocation to eight hours.
Tool logs belong on stderr.
Cancellation terminates the owned process group and retains staged data.

The preparation key includes the pinned model identity and inline recipe contract.
Unchanged apply checks the existing output manifest and file metadata without invoking the tools.
Changed or incomplete published data fails observation; it is not treated as absent or silently rebuilt.

## Plan, Apply and Retention

Plan validates declarations and observes hardware, state, and retained files.
It never runs preparation or verification executables.
Apply checks the pinned image capabilities and packaged files, downloads or reuses the snapshot, prepares and verifies data, then starts vLLM through the shared supervisor.

The Qwen adapter can hard-link earlier packed data into staging for verification before the runtime saves a new output manifest.
This avoids repacking while preserving the old published files.
The model-specific orphan-recovery rule remains in that adapter, not the shared preparation lifecycle.

Changing to a recipe-capable image can replace the inference container.
Existing ownership, generation and storage checks still apply; this does not authorize adopting another deployment's volume.
Destroy retains model and prepared storage as before.

Recipe execution adds no exception to the distinction between failed observation and confirmed resource absence.

Old model-specific backend configurations and native-agent state are unsupported.
The current container limits and live hardware qualification still target DGX Spark.
Removing model-specific code does not qualify another GPU.

Recipe declarations are trusted deployment input, and the pinned runtime image must be reviewed with its tools and dependencies.
The executable hash is an additional identity check, not a sandbox for recipe code.
Recipe authors must version the contract when preparation semantics change, including changes to helper code used by their executable.

The complete declaration participates in the preparation key, so even serving-only edits currently change that key.
