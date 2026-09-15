# Inline model recipes

An ordinary vLLM service needs a pinned image and model snapshot. Add
`service.recipe` when the model needs preparation or serving features supplied
by its runtime image. The CLI does not load recipe code. Recipe authors package
their executables, patches, licenses and source notices in that image; the YAML
declares their contract.

See [the inline Qwen example](../examples/spark-inline.yaml). Build its local image
with `cargo run -p nemoclaw-build -- spark-runtime`; the example pins the resulting
OCI manifest. This experiment does not publish the image. Its model-specific
adapters live in `runtimes/qwen38`, outside the generic execution path. The old
`vllm-qwen38-spark-v1` backend remains readable for established deployment state
and older pinned images. New recipes use `backend: vllm` and do not require an
entry in a Rust recipe registry.

## Declaration

The initial contract is inline, with `apiVersion:
nemoclaw.nvidia.com/recipe/v1`. It contains:

- `compatibility`: target architecture, GPU name, minimum driver and host memory,
  and required image labels. Images must declare `org.nemoclaw.recipe.protocol:
  v1`. Other labels describe the features the recipe requires.
- `preparation` and `verification`: absolute executable paths inside the image
  and SHA-256 hashes. They are executable files, not shell command strings.
- `resources`: maximum total prepared bytes, preparation memory in GiB, total
  serving GPU budget in bytes, and startup memory headroom in GiB. The serving
  GPU budget includes the recipe's model, caches and other GPU allocations.
- `serving`: the served model name, parser names, cache dtypes, lazy-loading and
  chunked-prefill settings, optional typed compilation settings, and `VLLM_`
  environment values. `preparedEnvironment` maps environment names to paths
  relative to the verified preparation directory; `.` selects that directory.
- `licenses` and `sourceNotices`: paths to retained files inside the pinned image.

Recipe memory requirements are checked against measurements from the execution
host. The runtime rechecks preparation and startup headroom. The shared resident
watchdog continues enforcing the service's memory protection policy after the
CLI exits. Declaring a new hardware combination does not constitute live
qualification; the current inline Qwen example targets the Spark.

An optional `snapshot` carries the exact model file manifest, including sizes
and hashes. Otherwise the shared downloader resolves the pinned repository and
revision. An optional `reuse` names an existing snapshot directory relative to
`/data` and a previous preparation key. It is an explicit cache import, not
permission to accept old verification evidence. The inline Qwen example uses
these fields to reuse its earlier snapshot and packed bytes.

## Execution protocol

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
Preparation owns how to resume its unpublished output. It must leave previous
published data intact. Preparation exits successfully after producing candidate
files. Verification independently checks those candidates and returns JSON on
stdout:

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

Names are relative to the staging directory. Duplicate names, traversal,
symlinked output paths, incomplete hashes, and output beyond the declared byte
budget fail verification. The runtime independently hashes the listed files,
records their metadata, and publishes a completion receipt through a directory
rename. It limits protocol output to 1 MiB and each tool invocation to eight
hours. Tool logs belong on stderr. Cancellation terminates the owned process
group and retains staged data.

The preparation key includes the pinned model identity and inline recipe
contract. Unchanged apply checks the existing completion receipt and file
metadata without invoking the tools. Changed or incomplete published data fails
observation; it is not treated as absent or silently rebuilt.

## Plan, apply and retention

Plan validates declarations and observes hardware, state, and retained files.
It never runs preparation or verification executables. Apply checks the pinned
image capabilities and packaged files, downloads or reuses the snapshot, prepares
and verifies data, then starts vLLM through the shared supervisor.

The Qwen adapter can hard-link earlier packed data into staging and verify it
before accepting a new receipt. This avoids repacking while preserving the old
published files. The model-specific orphan-recovery rule remains in that adapter,
not the generic Rust preparation lifecycle.

Changing to a recipe-capable image can replace the inference container. Existing
ownership, generation and storage checks still apply; this does not authorize
adopting another deployment's volume. Destroy retains model and prepared storage
as before. Recipe execution adds no exception to the distinction between failed
observation and confirmed resource absence.

The legacy backend compatibility does not migrate deployment state from the
removed native OpenClaw schema. That state must remain available for its original
CLI; the inline live experiment uses a separate Fabric deployment. Current runtime
container limits and live hardware qualification still target the Spark.
