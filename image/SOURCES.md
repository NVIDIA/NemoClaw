<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Retained Rust Sources

These images carry the following Rust sources and dependency notices.
The archives include Cargo's source-replacement configuration, so Cargo does not need a registry or Git checkout after extraction.
Install the required Rust toolchain, target standard libraries, Python, and native build tools before building offline.
These instructions rebuild the named Rust components; they do not reproduce the entire image or supply the source of every operating-system, Python, frontend, or inference-engine component.

| Image | Source Location | Contents |
| --- | --- | --- |
| Every Fabric agent | `/opt/nemoclaw/source/fabric.tar.gz` and `/opt/nemoclaw/source/fabric-vendor.tar.gz` | Pinned upstream Fabric source and its Cargo.lock dependency sources, including original notices and relative vendor configuration |
| Ollama proxy | `/usr/share/doc/nemoclaw-ollama-proxy/proxy-source.tar.gz` | Packaged proxy source, lockfile, Rust toolchain pin, dependency sources and notices, and relative vendor configuration |
| vLLM, Ollama, and llama.cpp runtimes | `/opt/nemoclaw/source/supervisor-source.tar.gz` | Supervisor source, lockfile, Rust toolchain pin, dependency sources and notices, and relative vendor configuration |

The vendor trees can include build dependencies and dependencies for other platforms.
Their presence does not mean every package is linked into the executable.
The images separately retain the Rust standard-library notices; the standard-library source and toolchain are not included in these archives.

## Deep Agents' orjson Extension

The Deep Agents image retains orjson 3.11.9's original source distribution at `/opt/nemoclaw/source/deepagents/orjson-source.tar.gz`.
It includes the extension's Rust and C sources, build metadata, and original Apache, MIT, and MPL license texts.
The installed wheel separately retains these notices in its `orjson-3.11.9.dist-info/licenses/` directory.
Extract the archive and build a wheel with Python 3.10 or newer, Rust 1.95 or newer, and a C compiler:

```sh
tar -xzf orjson-source.tar.gz
python -m pip wheel --no-deps ./orjson-3.11.9
```

The Python build backend and toolchains are prerequisites; the archive is not an offline build environment.

## mini-swe-agent's hf_xet Extension

The mini-swe-agent image retains `colored-source.crate` (3.1.1) and `option-ext-source.crate` (0.2.0) under `/opt/nemoclaw/source/hf-xet/`.
These original registry archives include their MPL-2.0 license text and source files; their checksums match the dependency records in the installed hf_xet 1.5.1 wheel's SBOM.
Extract them with `tar -xzf ARCHIVE`.
They supplement the wheel's own Apache license and cover these named dependencies, not the entire extension's transitive source closure or an offline rebuild environment.

## Rebuilding Fabric's Native Library

Use Rust 1.100.0, Python 3.11 or newer, and a C toolchain on Linux.
Copy both Fabric archives from the same image to an empty working directory, then run:

```sh
mkdir fabric-source
tar -xzf fabric.tar.gz -C fabric-source --strip-components=1
tar -xzf fabric-vendor.tar.gz -C fabric-source
cd fabric-source
cargo build --locked --offline --release -p fabric-python --features pyo3/extension-module
```

The native library is under `target/release/`.
The image uses the same vendor configuration when compiling its native Python wheel.
The original archive also retains Fabric's Python sources, lock, build metadata, and attribution documents.
Producing a Python wheel additionally needs the Python build backend and its dependencies; those are not installed by the offline Cargo command.

## Rebuilding the Proxy or Supervisor

Copy the relevant archive to an empty working directory and extract it:

```sh
mkdir component-source
tar -xzf proxy-source.tar.gz -C component-source
cd component-source
cargo build --locked --offline --release
```

For the supervisor, substitute `supervisor-source.tar.gz` for the archive name.
Use the toolchain in the extracted `rust-toolchain.toml`.
The proxy requires Linux; the shipped proxy is compiled with musl using the Rust Alpine image pinned in its Dockerfile.
Install the native tools and target libraries appropriate to the platform you rebuild for.
The proxy and supervisor Dockerfiles compile from their retained archives with Cargo offline.

Original license files remain inside each vendor directory.
Image filesystem changes and different toolchain or platform inputs can change the resulting binary; these commands do not promise identical binary hashes.
