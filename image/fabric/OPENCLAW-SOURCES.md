<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw Native Sources

The OpenClaw image retains these source archives in `/opt/nemoclaw/source/openclaw/`.
Their download URLs and SHA-256 values are pinned in `versions.json`.

| Archive | Source | Installed Component |
| --- | --- | --- |
| `ubrn-source.tgz` | The unmodified `uniffi-bindgen-react-native` 0.31.0-3 npm source package, Git revision `dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449` | `@ubjs/node-linux-arm64-gnu` or `@ubjs/node-linux-x64-gnu` 0.31.0-3, including `runtimes/core` and `runtimes/napi` under MPL-2.0 |
| `cua-driver-source.tar.gz` | `libs/cua-driver`, the repository license, and root package metadata from CUA revision `36987990b292537770fe2df3a9e6dee2ef43db2f` | `@trycua/cua-driver-linux-arm64-gnu` or `@trycua/cua-driver-linux-x64-gnu` 0.28.2, including the Rust SDK and modified MPL runtime |

The UBJS platform packages' npm metadata records the first revision.
Both CUA platform packages' npm provenance statements identify the second revision.
The CUA archive preserves its Rust workspace, Cargo.lock, TypeScript package and lock, build scripts, and runtime modification instructions.
It omits unrelated CUA applications and documentation.
Original source files and their notices are unmodified.

## Extracting and Building

Copy both archives from the same image into an empty directory, then extract them:

```sh
mkdir ubrn-source cua-source
tar -xzf ubrn-source.tgz -C ubrn-source --strip-components=1
tar -xzf cua-driver-source.tar.gz -C cua-source
```

The original UBJS runtime is under `ubrn-source/runtimes/napi`, with its shared runtime under `ubrn-source/runtimes/core`.
CUA's `libs/cua-driver/scripts/build-node-runtime.mjs` describes and applies the changes that make RustBuffer arguments and results use JavaScript-owned arrays.
The installed CUA platform package also retains `node-runtime-NOTICE.md`.

To use CUA's retained transformation script with the retained upstream runtime source, install Rust, Cargo, Node.js, and the native build prerequisites for the target, then run from this directory:

```sh
mkdir -p cua-source/libs/cua-driver/typescript/node_modules
cp -R ubrn-source cua-source/libs/cua-driver/typescript/node_modules/uniffi-bindgen-react-native
node cua-source/libs/cua-driver/scripts/build-node-runtime.mjs \
  --target aarch64-unknown-linux-gnu --output cua_driver_node_runtime.node
```

For AMD64, substitute `x86_64-unknown-linux-gnu`.
The script checks the source package version against CUA's retained package manifest before applying its edits.
Its Cargo build can download dependencies; these archives do not vendor all CUA or UBJS dependencies or promise an offline or byte-identical rebuild.
CUA's main SDK source is under `cua-source/libs/cua-driver/rust`.
Its Linux SDK library can be built with that workspace's retained lockfile and target prerequisites:

```sh
cargo build --locked --release --manifest-path cua-source/libs/cua-driver/rust/Cargo.toml \
  -p cua-driver-sdk --target aarch64-unknown-linux-gnu
```

For AMD64, substitute `x86_64-unknown-linux-gnu`.
The original repository's release workflows describe the upstream packaging environment; they are not part of the retained driver subtree.

These archives supply the named components' source and modification script.
They do not establish source coverage for every OpenClaw dependency, approve redistribution, or supply proprietary component source.
