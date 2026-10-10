#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Benchmark native CPU and CUDA on identical synthetic liveness workpacks.

Independent Python set results are correctness oracles, never CPU performance
baselines. Complete compilation measures only the supported scalar demo, using
fresh processes and including CUDA initialization on every compilation.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
import platform
import random
import statistics
import struct
import subprocess
import sys
import time
from pathlib import Path

from export_cuda import pack, read_result
from verify_cuda import oracle_words

ROOT = Path(__file__).resolve().parents[1]
GENERATOR_SEED = 10091709
ORDER_SEED = 10090031


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def statistics_ms(samples):
    values = list(samples)
    if not values or any(not isinstance(value, (int, float)) or
                         not math.isfinite(value) or value <= 0 for value in values):
        raise ValueError("Timing samples must be finite positive milliseconds")
    return {"median_ms": statistics.median(values), "min_ms": min(values),
            "max_ms": max(values), "samples_ms": values}


def synthetic_workloads():
    """Fixed seeded compact CFGs and adversarial long dependency chains."""
    rng = random.Random(GENERATOR_SEED)

    def compact(name, blocks=16, values=256, uses=4, definitions=3):
        rows = []
        for index in range(blocks):
            targets = ([index + 1] if index + 1 < blocks else [])
            if index > 1 and rng.random() < 0.35:
                targets.append(rng.randrange(index))
            rows.append({"name": str(index), "successors": sorted(set(targets)),
                         "use": rng.sample(range(values), min(values, uses)),
                         "def": rng.sample(range(values), min(values, definitions))})
        edges = [{"from": index, "to": target,
                  "values": rng.sample(range(values), min(values, 2))}
                 for index, row in enumerate(rows) for target in row["successors"]]
        return {"name": name, "value_count": values, "blocks": rows,
                "phi_edge_uses": edges}

    patterns = [compact(f"pattern_{index}") for index in range(16)]

    def batch(count, prefix):
        # Repeated shapes model a batch of small independent functions. Sharing
        # immutable Python objects only affects untimed workload generation.
        return [dict(patterns[index % len(patterns)], name=f"{prefix}_{index}")
                for index in range(count)]

    def chain(index):
        return {"name": f"chain_{index}", "value_count": 65,
                "blocks": [{"name": str(block),
                            "successors": [block + 1] if block < 255 else [],
                            "use": [0, 32, 64] if block == 255 else [], "def": []}
                           for block in range(256)], "phi_edge_uses": []}

    cases = [("tiny", [compact(f"tiny_{index}", blocks=5, values=65) for index in range(4)]),
             ("compact-batch-64", batch(64, "compact")),
             ("compact-batch-512", batch(512, "compact")),
             ("compact-batch", batch(4096, "compact")),
             ("few-wide", [compact(f"wide_{index}", blocks=32, values=8192,
                                   uses=128, definitions=64) for index in range(8)]),
             ("long-chain", [chain(index) for index in range(64)]),
             ("mixed-compact-and-long", batch(2048, "mixed") +
              [chain(index) for index in range(16)])]
    return [{"version": 1, "name": name, "functions": functions}
            for name, functions in cases]


def invoke(arguments, timeout=600):
    command = [str(value) for value in arguments]
    started = time.perf_counter()
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    elapsed_ms = (time.perf_counter() - started) * 1000
    if completed.returncode:
        raise RuntimeError(f"Command exited {completed.returncode}: {command[0]}\n"
                           f"{completed.stderr or completed.stdout}")
    return completed, elapsed_ms


def validate_pass(metrics, backend, actual, expected, repeats):
    if actual != expected:
        raise ValueError(f"{backend} output differs from the independent set oracle")
    if (metrics.get("backend") != backend or metrics.get("repeat_outputs_equal") is not True
            or metrics.get("repeats") != repeats):
        raise ValueError(f"{backend} repetition evidence is incomplete")
    statistics_ms(metrics.get("warm_pass_end_to_end_ms", {}).get("samples_ms", []))
    if len(metrics["warm_pass_end_to_end_ms"]["samples_ms"]) != repeats:
        raise ValueError(f"{backend} sample count differs from requested repeats")
    if backend == "cuda":
        if (metrics.get("converged") is not True or not metrics.get("device_name") or
                not metrics.get("gpu_execution_ms", {}).get("samples_ms")):
            raise ValueError("GPU execution evidence is incomplete")
        statistics_ms(metrics["gpu_execution_ms"]["samples_ms"])


def comparisons(cpu, cuda):
    cpu_ms = cpu["warm_pass_end_to_end_ms"]["median_ms"]
    resident_ms = cuda["warm_pass_end_to_end_ms"]["median_ms"] if cuda else None
    update = cuda.get("warm_input_update_end_to_end_ms") if cuda else None
    update_ms = update["median_ms"] if update else None
    return {"cpu_selected_variant": cpu.get("selected_variant"),
            "cpu_warm_median_ms": cpu_ms,
            "cuda_status": "verified" if cuda else "unavailable",
            "cuda_resident_input_median_ms": resident_ms,
            "cuda_input_update_median_ms": update_ms,
            "cpu_over_cuda_resident_input_ratio": cpu_ms / resident_ms if resident_ms else None,
            "cpu_over_cuda_input_update_ratio": cpu_ms / update_ms if update_ms else None,
            "ratio_definition": "CPU median divided by CUDA median; above 1 means CUDA was faster for this scope.",
            "cpu_scope": "Fastest measured native serial/function-parallel/word-parallel solver; includes allocation/reset, result scatter and thread startup; excludes input file parsing.",
            "resident_input_scope": "CUDA input already resident; includes launch/wait, convergence checks and device-to-host copies; excludes host-to-device input upload, context/allocations and file IO.",
            "input_update_scope": "CUDA context and buffers already allocated; includes complete host-to-device input updates plus launch/wait, convergence checks and device-to-host copies; excludes file IO and context/allocations."}


def hardware():
    info = {"platform": platform.platform(), "machine": platform.machine(),
            "python": platform.python_version(), "logical_cpu_count": os.cpu_count()}
    if hasattr(os, "sched_getaffinity"):
        info["cpu_affinity_count"] = len(os.sched_getaffinity(0))
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        info["cpu_models"] = sorted({line.split(":", 1)[1].strip()
                                     for line in cpuinfo.read_text().splitlines()
                                     if line.startswith("model name") and ":" in line})
    for name in ("cpu.max", "cpuset.cpus.effective"):
        path = Path("/sys/fs/cgroup") / name
        if path.is_file():
            info[f"cgroup_{name}"] = path.read_text().strip()
    return info


def related_evidence():
    result = {}
    for name in ("ci-provenance.json", "cuda-verification.json"):
        path = ROOT / "results" / name
        if not path.is_file():
            result[name] = {"status": "absent", "path": str(path)}
            continue
        source = json.loads(path.read_text())
        detail = {"status": "present", "path": str(path), "sha256": sha256(path)}
        if name == "ci-provenance.json":
            detail["provenance"] = source
        else:
            detail.update(verification_status=source.get("status"),
                          device=source.get("device"),
                          cuda_compiled=source.get("cuda_compiled"),
                          gpu_executed=source.get("gpu_executed"),
                          nvcc_version=source.get("nvcc_version"))
        result[name] = detail
    return result


def benchmark_passes(args, report, directory):
    report["analysis_workloads"] = []
    rng = random.Random(ORDER_SEED)
    for workload in synthetic_workloads():
        if args.workloads and workload["name"] not in args.workloads:
            continue
        path = directory / f"{workload['name']}.bin"
        path.write_bytes(pack(workload))
        counts = struct.unpack_from("<6I", path.read_bytes(), 4)
        record = {"name": workload["name"],
                  "functions": counts[0], "blocks": counts[1], "cells": counts[2],
                  "groups": counts[3], "max_blocks": counts[4], "edges": counts[5],
                  "input_sha256": sha256(path), "input_file": str(path),
                  "generator_seed": GENERATOR_SEED, "scope": "Synthetic liveness pass, not a Rust crate."}
        if workload["name"] == "mixed-compact-and-long":
            record["cuda_shared_memory_scope"] = "The existing CUDA kernel reserves shared memory using the largest function in the pack for every group; long functions can reduce compact-group occupancy."
        report["analysis_workloads"].append(record)
        # Oracle work happens before either native timing and is never a CPU
        # performance sample. All output words are compared after each process.
        expected = oracle_words(workload)
        backends = [("cpu-native", args.cpu_binary)]
        if not args.cpu_only:
            backends.append(("cuda", args.cuda_binary))
        rng.shuffle(backends)
        record["invocation_order"] = [name for name, _ in backends]
        for backend, binary in backends:
            output = directory / f"{workload['name']}-{backend}.result.bin"
            output.unlink(missing_ok=True)
            command = [binary, path, output, args.repeats]
            completed, elapsed = invoke(command)
            metrics = json.loads(completed.stdout)
            validate_pass(metrics, backend, read_result(output), expected, args.repeats)
            update = metrics.get("warm_input_update_end_to_end_ms")
            if backend == "cuda" and update is None:
                raise ValueError("CUDA input-update-inclusive timing evidence is absent")
            if update is not None:
                statistics_ms(update["samples_ms"])
                if len(update["samples_ms"]) != args.repeats:
                    raise ValueError("CUDA input-update sample count differs from requested repeats")
            record[backend] = {"metrics": metrics,
                               "external_invocation_wall_ms": elapsed,
                               "command": [str(value) for value in command],
                               "output_sha256": sha256(output),
                               "verified_cells": len(expected),
                               "verified_against_independent_oracle": True,
                               "external_wall_scope": "One process initialization, one first pass, all repeated warm passes, binary input/output IO and JSON output; not a single compilation."}
            if backend == "cuda":
                report.update(gpu_executed=True, cuda_status="analysis_verified")
        record["comparison"] = comparisons(record["cpu-native"]["metrics"],
                                            record["cuda"]["metrics"] if "cuda" in record else None)


def benchmark_compilations(args, report, directory):
    source = ROOT / "fixtures/compiler_demo.rs"
    backends = ["native_cpu", "cpu_reference_bridge"]
    if not args.cpu_only:
        backends.append("cuda_bridge")
    samples = {backend: [] for backend in backends}
    rng = random.Random(ORDER_SEED + 1)
    invocation_order = []

    def compile_one(backend):
        output = directory / f"demo-{backend}"
        detail_path = directory / f"demo-{backend}.json"
        output.unlink(missing_ok=True)
        detail_path.unlink(missing_ok=True)
        if backend == "native_cpu":
            command = [args.compiler_binary, source, "--backend", "cpu",
                       "--output", output, "--report", detail_path]
        else:
            command = [sys.executable, ROOT / "scripts/compile.py", source,
                       "--backend", "cuda" if backend == "cuda_bridge" else "cpu",
                       "--compiler-binary", args.compiler_binary, "--cuda-binary", args.cuda_binary,
                       "--output", output, "--report", detail_path]
        _, elapsed = invoke(command)
        detail = json.loads(detail_path.read_text())
        execution, _ = invoke([output], timeout=30)
        if execution.stdout != "1460\n":
            raise ValueError(f"{backend} produced unexpected demo output: {execution.stdout!r}")
        if backend == "cuda_bridge":
            cuda = detail.get("pass_report", {})
            if (detail.get("actual_gpu_functions", 0) < 1 or cuda.get("backend") != "cuda"
                    or cuda.get("converged") is not True
                    or cuda.get("verified_against_cpu") is not True):
                raise ValueError("CUDA compilation did not provide verified GPU execution evidence")
        if detail.get("total_compile_ms", 0) <= 0:
            raise ValueError("Complete compilation timing is absent")
        return {"external_process_wall_ms": elapsed, "report": detail,
                "command": [str(value) for value in command], "output_verified": "1460\n"}

    # Warm file/Clang caches once. Subsequent CUDA processes still initialize a
    # fresh CUDA context each time; this is not persistent-adapter evidence.
    warmup = {backend: compile_one(backend) for backend in backends}
    for repetition in range(args.compile_repeats):
        order = list(backends)
        rng.shuffle(order)
        invocation_order.append(order)
        for backend in order:
            sample = compile_one(backend)
            sample["repetition"] = repetition
            samples[backend].append(sample)
    results = {}
    for backend, observations in samples.items():
        stages = sorted({key for sample in observations for key, value in sample["report"].items()
                         if key.endswith("_ms") and isinstance(value, (int, float)) and value > 0})
        results[backend] = {
            "external_process_wall_ms": statistics_ms(sample["external_process_wall_ms"]
                                                       for sample in observations),
            "reported_total_compile_ms": statistics_ms(sample["report"]["total_compile_ms"]
                                                        for sample in observations),
            "reported_stage_ms": {stage: statistics_ms(sample["report"][stage]
                                                      for sample in observations) for stage in stages},
            "samples": observations}
    comparison = {"cuda_status": "unavailable" if args.cpu_only else "verified",
                  "native_cpu_over_cuda_external_wall_ratio": None,
                  "cpu_reference_bridge_over_cuda_external_wall_ratio": None}
    if not args.cpu_only:
        cuda_ms = results["cuda_bridge"]["external_process_wall_ms"]["median_ms"]
        comparison.update(
            native_cpu_over_cuda_external_wall_ratio=results["native_cpu"]["external_process_wall_ms"]["median_ms"] / cuda_ms,
            cpu_reference_bridge_over_cuda_external_wall_ratio=results["cpu_reference_bridge"]["external_process_wall_ms"]["median_ms"] / cuda_ms)
    report["complete_compilation"] = {
        "scope": "Supported scalar demo only; no full Rust/Cargo, NemoClaw or Omarchy build compatibility or acceleration evidence.",
        "source": str(source), "source_sha256": sha256(source),
        "compile_repeats": args.compile_repeats, "order_seed": ORDER_SEED + 1,
        "invocation_order": invocation_order, "untimed_warmup": warmup,
        "lifecycle": "Every sample starts a fresh compiler/bridge process. CUDA starts its separate analysis process and initializes a fresh context on every compilation. Filesystem and Clang caches are warmed once.",
        "external_wall_scope": "Compiler/bridge process launch through process exit, including frontend, analysis, transfers, verification, pruning, Clang code generation/linking and reporting; executable validation occurs afterward.",
        "reported_total_scope": "Compiler/bridge internal timing; excludes Python interpreter or native process launch and final report serialization. Stage timing boundaries differ between native and bridge paths.",
        "native_cpu_scope": "Native structured IR and bitset CPU analysis; no Python extraction or cross-backend oracle verification.",
        "bridge_scope": "CPU and CUDA bridges share Python textual IR extraction, set oracle and pruning. CUDA additionally launches the CUDA process and verifies its output against that oracle. Python CPU reference is a correctness baseline, not an optimized CPU solver.",
        "comparison": comparison, "results": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler-binary", type=Path,
                        default=ROOT / ".build/compiler/release/gpu-rust-compiler")
    parser.add_argument("--cpu-binary", type=Path,
                        default=ROOT / ".build/compiler/release/gpu-cpu-liveness")
    parser.add_argument("--cuda-binary", type=Path, default=ROOT / ".build/cuda/cuda-liveness")
    parser.add_argument("--repeats", type=int, default=31)
    parser.add_argument("--compile-repeats", type=int, default=9)
    parser.add_argument("--report", type=Path, default=ROOT / "results/cuda-benchmark.json")
    parser.add_argument("--cpu-only", action="store_true",
                        help="Validate CPU measurements locally; record CUDA unavailable without speedup claims")
    parser.add_argument("--workloads", nargs="+",
                        choices=("tiny", "compact-batch-64", "compact-batch-512", "compact-batch",
                                 "few-wide", "long-chain", "mixed-compact-and-long"),
                        help="Run a selected subset for local validation; default benchmarks all workloads")
    args = parser.parse_args()
    for field in ("repeats", "compile_repeats"):
        if not 1 <= getattr(args, field) <= 10000:
            parser.error(f"--{field.replace('_', '-')} must be between 1 and 10000")
    report = {"status": "not_run", "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
              "scope": "Synthetic compiler-pass and supported scalar-subset compilation benchmark only.",
              "hardware": hardware(), "source_revision": os.environ.get("CANDIDATE_SHA") or os.environ.get("GITHUB_SHA"),
              "generator_seed": GENERATOR_SEED, "analysis_order_seed": ORDER_SEED,
              "repeats": args.repeats, "compile_repeats": args.compile_repeats,
              "gpu_executed": False, "cuda_status": "unavailable" if args.cpu_only else "not_run"}
    directory = ROOT / ".build/benchmarks/cuda"
    directory.mkdir(parents=True, exist_ok=True)
    exit_code = 1
    try:
        binaries = {"compiler": args.compiler_binary, "cpu": args.cpu_binary}
        if not args.cpu_only:
            binaries["cuda"] = args.cuda_binary
        for name, binary in binaries.items():
            if not binary.is_file():
                raise RuntimeError(f"{name} binary unavailable: {binary}")
        report["binaries"] = {name: {"path": str(path.resolve()), "sha256": sha256(path)}
                              for name, path in binaries.items()}
        implementation = [ROOT / "scripts/benchmark_cuda.py", ROOT / "scripts/compile.py",
                          ROOT / "scripts/verify_cuda.py", ROOT / "cuda/liveness.cu"]
        implementation += sorted((ROOT / "compiler/src").rglob("*.rs"))
        report["implementation_sha256"] = {str(path.relative_to(ROOT)): sha256(path)
                                            for path in implementation}
        report["related_evidence"] = related_evidence()
        clang, _ = invoke(["clang", "--version"], timeout=30)
        report["clang_version"] = clang.stdout.strip()
        benchmark_passes(args, report, directory)
        benchmark_compilations(args, report, directory)
        report.update(status="cpu_only_verified" if args.cpu_only else "verified",
                      gpu_executed=not args.cpu_only,
                      cuda_status="unavailable" if args.cpu_only else "verified")
        exit_code = 0
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        report.update(status="failed", error=str(error))
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(args.report), "status": report["status"],
                      "analysis_comparisons": {record["name"]: record.get("comparison")
                                               for record in report.get("analysis_workloads", [])},
                      "complete_compilation_comparison": report.get("complete_compilation", {}).get("comparison"),
                      "error": report.get("error")}, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
