<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GEM1 LLVM leaf packet

`tpde-rust-bridge --export-leaf INPUT OUTPUT` reads and verifies an LLVM text,
bitcode, or bitcode-wrapper input without modifying it. It exports a whole module
only when every defined function satisfies the initial scalar contract. A
rejection returns status 20 without opening the output; invalid LLVM input returns
21/22. The caller must check status and use fresh output paths.

This is an adapter over LLVM emitted by the Rust frontend. It does not parse Rust
source or bypass Rust's macros, type checking, borrow checking or ABI lowering.
Exporting a packet does not establish GPU execution; the selected device emitter
must produce and execute the corresponding native object separately.

## Initial eligibility

- Identified Rust **1.98.1** producer, original x86-64/AArch64 Linux or macOS target,
  little-endian layout, input and output at most 2 MiB.
- No global variables, aliases, ifuncs, module assembly or unknown named metadata.
  The accepted module flags are PIC/PIE level, unwind tables, frame pointers and
  `RtLibUseGOT` (which has no effect on bodies without runtime calls).
- Every definition has external linkage, default visibility/storage and address
  space zero; C calling convention; no varargs; zero or one i64 argument and i64
  return; one basic block. Declarations may remain because accepted bodies cannot
  call or reference them.
- Constants, wrapping i64 add/sub/mul and return only. `nsw`/`nuw`, undef/poison,
  memory operations, calls/intrinsics, control flow and other instructions reject
  the entire module. COPY is reserved in the contract but this exporter emits no
  copy instruction.
- No personality, COMDAT, explicit section/alignment, prologue/prefix data,
  function/instruction/debug metadata or ABI-special parameter/return attributes.
  Normal `noundef`/range facts and optimization hints can accompany the accepted
  arithmetic without changing its emitted behavior.
- Unknown function attributes reject. Return signing, BTI/PAC/CET/retpoline
  requirements, sanitizer/instrumentation and stack-protector attributes are not
  represented by this packet and must use a compatible CPU backend.
- Normal Rust `probe-stack=inline-asm` is accepted only with its default 4096-byte
  threshold, or an explicit `stack-probe-size` of at least 4096, and a fixed frame
  of `align16(value_count * 8) <= 2048`. No stack allocas/calls are permitted. Each
  function has at most 256 values.

`requires_unwind` is true when the function or module requires unwind tables.
The device/object emitter must generate valid fixed-frame unwind information,
including prologue and epilogue transitions for asynchronous unwinding. A
`nounwind` attribute does not cancel an unwind-table requirement.

Rust wrapping helper methods can leave an unused personality on a pure function
after inlining; that function intentionally falls back. `fixtures/leaf.rs` uses
plain arithmetic under an explicit matched release contract with overflow checks
and debug assertions disabled. Changing quality/hardware selection must not
silently change those semantic flags.

## Binary layout

All integers are little endian; strings contain UTF-8 bytes without a terminator.
No host pointers or source AST are serialized.

| Field | Encoding |
| --- | --- |
| Magic | Four bytes `GEM1` |
| Target triple | u32 byte length, then original UTF-8 bytes |
| Function count | u32 |
| Each function name | u32 byte length, then UTF-8 bytes |
| Parameters / requires_unwind / values / instructions | Four u32 values |
| Each instruction | u32 opcode, u32 result, u32 a, u32 b, i64 immediate bits |

Value IDs are local to the function, densely assigned in definition order. An
argument uses value zero; constants are materialized before their uses and
deduplicated within the function. All unused operands/immediates are zero.

| Opcode | Meaning | Fields |
| ---: | --- | --- |
| 0 | ARGUMENT | result 0, a/b/immediate 0; emitted only for one parameter |
| 1 | CONST | result value ID; a/b zero; immediate contains all 64 bits |
| 2 | COPY | Reserved; result and source a; b/immediate zero |
| 3 | ADD | result, a, b; immediate zero |
| 4 | SUB | result, a, b; immediate zero |
| 5 | MUL | result, a, b; immediate zero |
| 6 | RETURN | result `0xffffffff`, a returned value, b/immediate zero |

The consumer must enforce bounds, unique/ordered definitions, defined operands,
signature/frame limits, one terminal return and the original target. It must
reject unknown versions/opcodes and truncated/trailing bytes.

## Native contract tests

The tests use handcrafted LLVM fixtures to check exact packet bytes and strict
rejection. They are ignored by default because they require the compiled LLVM
22.1.8 bridge. Run them explicitly:

```sh
NEMO_FAST_BACKEND_BRIDGE=/absolute/path/to/tpde-rust-bridge \
  cargo +1.98.1 test --locked --offline \
  --manifest-path experiments/gpu-rust-compiler/fast-backend/Cargo.toml \
  --target-dir experiments/gpu-rust-compiler/fast-backend/.build/controller \
  --test leaf_export -- --ignored
```

Capture `fixtures/leaf.rs` through the real frontend with `-Copt-level=1
-Cpanic=unwind -Coverflow-checks=no -Cdebug-assertions=no`, then export its module
with the original target. Actual native/device execution belongs to the compiler
integration qualification, independently of these protocol tests.
