# Build local artifacts

Use Rust 1.98.1, the toolchain pinned in `rust-toolchain.toml`, and Protocol Buffers
compiler 36.1. Set `PROTOC` to that compiler's path if it is outside `PATH`.
Native builds require a C toolchain for the TLS dependencies.

From the repository root:

```sh
cargo run -p nemoclaw-build -- bundle
```

The builder verifies the OpenTofu archive from `versions.json`, builds the CLI
and production provider with the lockfile, and writes `dist/<platform>`.
The manifest records every shipped file hash, including the OpenTofu license.
The provider version includes a source hash so a changed provider gets a new
OpenTofu installation identity. The SDK verifies the bundle before use.

`--platform` selects `linux_arm64`, `linux_amd64`, `darwin_arm64`,
`darwin_amd64`, or `windows_amd64`. Building a different target requires its Rust
standard library, linker, and native SDK. Platform selection does not establish
runtime qualification; the retained validation records identify tested hosts.

Build the Spark runtime on Linux ARM64 with Docker and Buildx:

```sh
cargo run -p nemoclaw-build -- spark-runtime
```

The fixed recipe downloads a checksum-verified source archive, builds the Rust
supervisor, vendors locked dependencies and their licenses, and assembles a
source archive with normalized timestamps. It compiles the supervisor offline
from that exact archive, including OpenShell protobuf inputs that Cargo vendoring
does not collect. Dependency paths and parent Git metadata are excluded from
the compiler inputs. The Dockerfile applies the pinned
patches to the pinned base image and retains the original and modified sources.
It exports `.build/spark/runtime.tar` and loads the image locally as
`nc-prototype-qwen38:spark-rust-v1`. This command does not launch inference or
publish the image. Configuration must use the resulting immutable image digest.

Generated bundles, build inputs and images are ignored by Git. The model snapshot
and prepared PLE data belong to the deployment's persistent volume, not the build
context. See [the runtime notice](../runtimes/qwen38/NOTICE.md) for provenance and
source locations inside the image.

Keep a bundle immutable while a deployment operation uses it. The development
builder replaces `dist/<platform>`; copy it to a dedicated location for a long
live experiment before rebuilding. Repository text uses LF on every platform so
source-derived provider versions do not change with checkout newline conversion.

The image contains the shared `nemoclaw-runtime` executable. Its preparation
adapter selects the pinned Qwen recipe, the vLLM backend, and the Spark hardware
profile. The old `nemoclaw-spark` path is a symlink, and `NEMOCLAW_SPARK_SPEC`
remains an accepted environment name alongside `NEMOCLAW_RUNTIME_SPEC`.
Conflicting specifications fail before work begins. Managed containers continue
using the legacy entrypoint/environment contract so existing pinned images and
resource bindings remain valid; the image's default entrypoint uses the new name.

For native safetensors models, build the model-independent image instead:

```sh
cargo run -p nemoclaw-build -- vllm-runtime
```

This uses the same pinned vLLM base and source-retaining supervisor build, without
Qwen3.8 patches or preparation tools. It exports `.build/vllm/runtime.tar`, loads
`nc-prototype-vllm:rust-v1` locally, and prints the immutable digest to use in YAML.
The image is not published. Select the model separately as described in
[model configuration](models.md).
