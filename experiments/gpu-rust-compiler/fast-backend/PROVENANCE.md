<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Backend provenance

The Rust controller and `bridge.cpp` are original experiment code. The bridge uses
TPDE's public `tpde_llvm::LLVMCompiler` API; no upstream implementation is copied.

- TPDE repository: <https://github.com/tpde2/tpde>
- Revision: `9779acf4ada3736e779391da1e4b3369dba08024`
- API declaration: `tpde-llvm/include/tpde-llvm/LLVMCompiler.hpp`
- Upstream CLI inspected for invocation and ownership behavior:
  `tpde-llvm/tools/tpde-llc.cpp` at that revision.
- Upstream license: Apache-2.0 WITH LLVM-exception. Fetched source and submodules
  retain their notices and license files. Nothing is republished here.
- Required LLVM version: `22.1.8`, matching the experiment's Rust `1.98.1` report.
- Expected Rust producer: `1.98.1`; observed `llvm.ident` is retained in receipts.

CMake fetches the exact TPDE revision and its recorded submodule revisions.
The bridge reports its compiled TPDE revision and LLVM version; the controller
refuses a mismatch. This is build provenance, not binary signing or authentication.

The bridge exchanges serialized IR and emitted bytes. It does not pass LLVM
pointers across library builds, replace rustc through a Clang plugin, or preserve
the complete set of rustc code-generation flags automatically. Qualification must
inventory target features, code models, debug data, instrumentation, intrinsics,
unwind behavior, and calling conventions before integrating it into Cargo.
