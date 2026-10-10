<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Prototype import

Imported from the local `gpu-rustc-lab` prototype developed for this experiment.
The source has no published repository revision; the hashes below identify the
original files before this PR adapted them. The originals contain no third-party
copyright notices. This import adds the repository SPDX notices.

Changes: isolate the Cargo workspace; retain the native frontend and Metal adapter;
remove workstation capture and downloaded tool benchmarks; replace the CUDA
bridge's Swift dependency with the portable set oracle; allow an explicit frontend
artifact; limit bridge choices to CPU/CUDA; remove the legacy driver from the
native benchmark; make existing adapter tests run CPU checks on Linux.

No generated binaries, build trees, personal paths, or prior benchmark results
are imported. The compiler frontend, liveness kernels, and code generation semantics
are unchanged.

| Original file | SHA-256 |
|---|---|
| `.gitignore` | `ffb551f742928f3156f648ef4053b6f77c124a078e5ce2062fee7369c6a4278e` |
| `ARCHITECTURE.md` | `233b396b064b76eb31090fe9e5c9c25288c0f9d56f6226fa0c5a88ea1fa1c4c5` |
| `README.md` | `817648a074510fe23af1ef09cd1dfe86ad2ad35e0b859d4da94465f4023d4996` |
| `compiler/Cargo.lock` | `1a049088308b5ce9c13cbca60eecbbd06c7976365e503343aebee65525aee7df` |
| `compiler/Cargo.toml` | `cf766cde51b1b8be89b15ea6ecfa7c38e3696d4ecc2ce6602c5805d41952afe4` |
| `compiler/build.rs` | `732701160e6ed7c8e82fe6e77d81be94f5bfcbae30ce59f9102531a81ec30464` |
| `compiler/src/analysis.rs` | `01c1b6ef8730b7dd41819f5a6af1e6d4639e2f13482ed1c4d700363bf7814a3f` |
| `compiler/src/frontend.rs` | `2b491a0b2ede8812856b16a0c6203df4f0bc0c497bcf205eb3ba3e7d65088473` |
| `compiler/src/ir.rs` | `c1e204c305e1e8727fa1ed4f10eca9c6a2a6ceccc88ff6203a6eba33df0b755c` |
| `compiler/src/llvm.rs` | `ddd7804f5c960d07c6a5f801a0817cb05dcf00ab541d1be2c06d71362d27aa9b` |
| `compiler/src/main.rs` | `96a9ede287b8007e9f7250e3484bbe816f9f0a3485ac0860dd3958b97c84ed20` |
| `compiler/src/metal.rs` | `9fb57049d6976ee0f5c140d496009b3328332cbaca0b2b9fde8c42ac6cdf46a4` |
| `cuda/CMakeLists.txt` | `5b839e40cf3eb2fc58d9af6b73f6bdb3fd350c38eba6547aa2c538ad57de962b` |
| `cuda/liveness.cu` | `6a58f20414317684416920d8352185117308f677fd6954a2e8a3247a82b01e60` |
| `fixtures/compiler_demo.rs` | `cf5d7480a466dbc181314284d36c30324cdd2bf6b8a0b1717651617c93a497b0` |
| `native/metal_bridge.h` | `523231b12386b5479ab1947eff8679fbe4715530fb3286e54fe5f1b1087ddd25` |
| `native/metal_bridge.mm` | `dd318c71f8a0654f88a6e21a3165f266a769821cd21e1943ae3f1a37aa250fb2` |
| `scripts/benchmark_native.py` | `b62e2dcfe3fde236f64cd4b583a0d57fcdbc9e4de674186918799e410765c86e` |
| `scripts/build_native.sh` | `c56b7e90e07c5b75e951d914ff23f043ab15020ef1f817857ea3a8f7b353b935` |
| `scripts/compile.py` | `0e4a5c0ef482bf956f80b4b9fbf6f8c04bd7aa569c88e1a0717071075c171e9d` |
| `scripts/export_cuda.py` | `e869d19956a01e5b11ce21ba74abef0aaa03f7fec308231462cfe67c75298fd7` |
| `scripts/liveness_reference.py` | `467e2361f8cc02a76ac916ec29a136ba8b319c7618ce47ed4c99a713c0be3721` |
| `scripts/optimize_ir.py` | `c45135cf1ca0c6f54148fcc6a61c7159bc583d0c8767d7845a519bd403e19715` |
| `scripts/prepare_workload.py` | `6fa899a24b7c1d3ea983ebeb2fd9bfd9f2d289ebe317ebaa6cba4a7797da818c` |
| `scripts/verify_cuda.py` | `1493ae34cbc6bbef4378cfe9bc3fc14492424ff77095985fd8bfe87da017ef35` |
| `src/liveness.metal` | `38e94e0e0fa8ebaeb1a86cce4b3eb622b5e4397af40e8b91027cc97d1aee9770` |
| `tests/test_liveness_reference.py` | `80edac08b9985f228ed272fb955bdeab4891a1cd94781fcc7ac3613797561520` |
| `tests/test_native_adapter.py` | `7cee490374c094e39bbfc9c3032dd3226149228b826bef1770cff569a9fc524a` |
| `tests/test_prepare_workload.py` | `0ebcfc8922eacaad3a141a48302a0a1c39166092cdc80e919d864645c6adeda0` |
