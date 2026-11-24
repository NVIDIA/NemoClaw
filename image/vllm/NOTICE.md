<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# vLLM Runtime

This artifact adds the NemoClaw runtime supervisor to the immutable multi-platform upstream vLLM image named in its Dockerfile, built for the Linux ARM64 or AMD64 host that builds it.
It does not apply model-specific patches or embed model weights.
The selected model is downloaded into retained storage when the deployment is applied.

`supervisor-source.tar.gz` retains the supervisor's source and locked dependency sources, including their original license files.
The runtime policy credit remains in `crates/nemoclaw-runtime/NOTICE.md` inside the archive.
`rust-COPYRIGHT-library.html` retains the notices of the Rust standard library the supervisor links.
`/opt/nemoclaw/source/Dockerfile` and `supervisor.Dockerfile` retain this image's and the supervisor's build instructions.
The upstream image retains its vLLM and installed dependency notices.

`uv-source.tar.gz` retains uv 0.13.8's original release source, including its workspace notices.
`uv-cargo-source.tar.gz` retains every external package in that release's Cargo lock, its vendor configuration, and recovered original notices from crate-recorded revisions and a difflib revision whose Rust files match the published crate.
This includes astral-pubgrub 0.7.1, astral-version-ranges 0.2.3, option-ext 0.2.0, and priority-queue 2.7.0, which offer MPL-2.0 terms.
With Rust 1.100.0 installed, to resolve those sources offline, extract the original source into a directory, extract the Cargo archive into that same root, and run `RUSTUP_TOOLCHAIN=1.100.0 cargo metadata --locked --offline --format-version 1` there.
`RUSTUP_TOOLCHAIN=1.100.0 cargo build --locked --offline --release -p uv` uses those sources and also needs the upstream build prerequisites.
These materials do not establish a byte-identical rebuild or resolve the remaining notice provenance and redistribution decisions in #14815.

`tokenizers/tokenizers-source.tar.gz` retains Tokenizers 0.23.3's original source distribution and Apache-2.0 notice, which its installed wheel omits.
`mooncake/mooncake-LICENSE` retains Mooncake 0.3.14's original Apache-2.0 notice.
`mooncake/go/` retains the original module source ZIPs, with license and notice files, for the 17 versioned Go dependencies identified in Mooncake's installed `libetcd_wrapper.so`.
Their Go module hashes match the binary's SBOM records and were verified through the public Go checksum database; the image source pins additionally verify each ZIP's SHA-256.
These named inputs do not establish complete native linkage or license clearance for the upstream vLLM image.
Model license and notice files present at the selected repository root are downloaded with the model snapshot.

The [AMD64 Nemotron example](../../examples/platforms/podman/vllm/remote/amd64/nemotron-amd64.yaml) adapts its configuration from NemoClaw main revision `97745a7ad9649f851704493e4b670b3674f875aa`:

- [Serving recipe](https://github.com/NVIDIA/NemoClaw/blob/97745a7ad9649f851704493e4b670b3674f875aa/managed-inference/recipes/vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1.yaml).
- [Model identity](https://github.com/NVIDIA/NemoClaw/blob/97745a7ad9649f851704493e4b670b3674f875aa/managed-inference/models/vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.v1.yaml).

The example preserves that model revision, served name, GPU minimums, native serving flags, bearer authentication, IPC selection, and startup timeout in v1's service fields, and declares driver major 580 as its minimum.
This adaptation does not establish live qualification on AMD64 hardware.
