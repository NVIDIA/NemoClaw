#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Compile the supported Rust subset through a portable CPU or CUDA bridge.

CPU uses the independent Python set oracle. CUDA uses a separate native process;
it is not the native compiler's persistent Metal adapter.
"""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path
from prepare_workload import parse_llvm_ir
from export_cuda import pack, read_result
from optimize_ir import optimize
from liveness_reference import solve_reference

ROOT = Path(__file__).resolve().parents[1]


def needs_rebuild(binary, sources):
    return not binary.exists() or any(path.stat().st_mtime_ns > binary.stat().st_mtime_ns for path in sources)


def invoke(command):
    completed = subprocess.run([str(part) for part in command], capture_output=True, text=True)
    if completed.returncode:
        raise SystemExit(completed.stderr.strip() or completed.stdout.strip() or f"Command failed: {command[0]}")
    return completed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--backend", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compiler-binary", type=Path,
                        help="Use an existing native frontend without rebuilding; must match this source revision")
    parser.add_argument("--cuda-binary", type=Path, default=ROOT / ".build/cuda/cuda-liveness")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    compiler = args.compiler_binary or ROOT / ".build/compiler/release/gpu-rust-compiler"
    sources = list((ROOT / "compiler/src").glob("*.rs"))
    sources += [ROOT / "compiler/Cargo.toml", ROOT / "compiler/Cargo.lock", ROOT / "compiler/build.rs"]
    sources += list((ROOT / "native").glob("*"))
    if args.compiler_binary is not None:
        compiler = compiler.resolve()
        if not compiler.is_file():
            raise SystemExit("Explicit compiler binary is unavailable")
    elif needs_rebuild(compiler, sources):
        invoke(["cargo", "build", "--locked", "--release", "--manifest-path", ROOT / "compiler/Cargo.toml", "--target-dir", ROOT / ".build/compiler"])
    source = args.source.resolve()
    workdir = ROOT / ".build/compilations" / hashlib.sha256(str(source).encode()).hexdigest()[:12]
    workdir.mkdir(parents=True, exist_ok=True)
    raw_ir, final_ir = workdir / "raw.ll", workdir / "optimized.ll"
    pack_path, solution_path, pass_report = workdir / "workload.json", workdir / "solution.json", workdir / "pass.json"
    start = time.perf_counter()
    stage_start = start
    invoke([compiler, source, "--emit-llvm", raw_ir])
    frontend_ms = (time.perf_counter() - stage_start) * 1000
    stage_start = time.perf_counter()
    workload = parse_llvm_ir(raw_ir.read_text(), source.name)
    pack_path.write_text(json.dumps(workload))
    extraction_ms = (time.perf_counter() - stage_start) * 1000
    stage_start = time.perf_counter()
    reference = solve_reference(workload)
    if args.backend == "cuda":
        if not args.cuda_binary.exists():
            raise SystemExit("CUDA backend binary unavailable. Run scripts/verify_cuda.py on an NVIDIA GPU runner first. CUDA was not executed.")
        binary_input, binary_output = workdir / "cuda-input.bin", workdir / "cuda-output.bin"
        binary_input.write_bytes(pack(workload))
        completed = invoke([args.cuda_binary, binary_input, binary_output, "1"])
        values = read_result(binary_output)
        if values != reference["live_in_words"]:
            raise ValueError("CUDA result differs from CPU reference")
        metrics = json.loads(completed.stdout)
        if (metrics.get("backend") != "cuda" or metrics.get("converged") is not True or
            metrics.get("repeat_outputs_equal") is not True or
            metrics.get("gpu_execution_ms", {}).get("median_ms", 0) <= 0):
            raise ValueError("CUDA execution evidence is incomplete")
        metrics["verified_against_cpu"] = True
        reference["live_in_words"] = values
        reference["requested_backend"] = "cuda"
        reference["actual_gpu_functions"] = len(workload["functions"])
        solution_path.write_text(json.dumps(reference))
        pass_report.write_text(json.dumps(metrics))
    else:
        solution_path.write_text(json.dumps(reference))
        pass_report.write_text(json.dumps({"backend": "cpu-reference", "gpu_executed": False}))
    analysis_ms = (time.perf_counter() - stage_start) * 1000
    stage_start = time.perf_counter()
    solution = json.loads(solution_path.read_text())
    optimized, removed = optimize(raw_ir.read_text(), workload, solution)
    final_ir.write_text(optimized)
    optimization_ms = (time.perf_counter() - stage_start) * 1000
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    stage_start = time.perf_counter()
    invoke(["clang", "-Wno-override-module", "-O0", final_ir, "-o", args.output])
    machine_code_ms = (time.perf_counter() - stage_start) * 1000
    report = {"compiler": "new scalar Rust-subset frontend, not rustc", "backend": args.backend,
              "actual_gpu_functions": solution["actual_gpu_functions"] if "actual_gpu_functions" in solution else 0,
              "source": str(source), "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "output": str(args.output), "total_compile_ms": (time.perf_counter() - start) * 1000,
              "frontend_and_ir_ms": frontend_ms, "ir_extraction_ms": extraction_ms,
              "analysis_with_cpu_verification_including_startup_ms": analysis_ms, "dead_code_pruning_ms": optimization_ms,
              "native_codegen_and_link_ms": machine_code_ms, "dead_scalar_instructions_removed": removed,
              "pass_report": json.loads(pass_report.read_text()),
              "scope": "Supported scalar subset only; verified liveness feeds dead scalar code pruning; no full Rust compatibility."}
    report_path = args.report or args.output.with_suffix(".compile.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
