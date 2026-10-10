#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Verify and benchmark persistent native CPU/CUDA compilation on one GPU host.

Python controls requests and independently checks bitsets/program outputs. It
does not extract IR, solve production analysis, prune IR, or enter a measured
compilation path. Unavailable CUDA is blocked evidence, never a passing fallback.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import random
import selectors
import shutil
import statistics
import subprocess
import time

from benchmark_cuda import (GENERATOR_SEED, ORDER_SEED, hardware, related_evidence,
                            sha256, statistics_ms, synthetic_workloads)
from export_cuda import pack, read_result
from verify_cuda import (DEVICE_PROBE, oracle_words, require_success, run,
                         tool_identity, workloads as correctness_workloads)

ROOT = Path(__file__).resolve().parents[1]


class NativeSession:
    """One persistent Rust process; each response must identify that process."""
    def __init__(self, command, log_path):
        self.command = [str(value) for value in command]
        self.log = Path(log_path).open("w")
        self.process = subprocess.Popen(self.command, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log,
                                        text=True, bufsize=1)
        self.counter = 0
        self.pid = None

    def line(self, fields):
        if any("\t" in str(field) or "\n" in str(field) for field in fields):
            raise ValueError("Protocol field contains a delimiter")
        started = time.perf_counter()
        self.process.stdin.write("\t".join(str(field) for field in fields) + "\n")
        self.process.stdin.flush()
        selector = selectors.DefaultSelector()
        try:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(180):
                raise RuntimeError("Native request timed out")
            line = self.process.stdout.readline()
        finally:
            selector.close()
        elapsed = (time.perf_counter() - started) * 1000
        if not line:
            raise RuntimeError(f"Native process exited without a response: {self.command}")
        response = json.loads(line)
        pid = response.get("process_id")
        if pid is not None:
            if self.pid is not None and pid != self.pid:
                raise ValueError("Persistent process identity changed")
            self.pid = pid
        return response, elapsed

    def request(self, backend, algorithm, input_path, output_path,
                residency="update", cpu_mode="auto", expected_error=False):
        self.counter += 1
        identifier = str(self.counter)
        response, elapsed = self.line((identifier, backend, algorithm, input_path,
                                       output_path, residency, cpu_mode))
        if response.get("request_id") != identifier:
            raise ValueError("Native response has wrong request identity")
        if expected_error:
            if response.get("status") != "error":
                raise ValueError("Malformed request was accepted")
        elif response.get("status") != "ok":
            raise RuntimeError(response)
        return response, elapsed

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.stdin.write("quit\n")
                self.process.stdin.flush()
            self.process.communicate(timeout=20)
            if self.process.returncode:
                raise RuntimeError(f"Native session exited {self.process.returncode}")
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.log.close()


def validate_native(response, actual, expected, gpu_required=False, resident=False):
    if actual != expected:
        raise ValueError("Native output differs from independent set oracle")
    for key in ("analysis_ms", "total_recurrent_ms"):
        value = response.get(key)
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"Missing positive native timing: {key}")
    if not isinstance(response.get("cpu_pool_workers"), int):
        raise ValueError("Reusable CPU pool identity is missing")
    if gpu_required:
        stats = response.get("gpu_stats") or {}
        if (response.get("actual_gpu_functions", 0) < 1 or
                response.get("cuda_context_creations") != 1 or
                stats.get("gpu_ms", 0) <= 0 or
                stats.get("resident_input") != int(resident) or
                not response.get("capabilities", {}).get("device_name")):
            raise ValueError("Actual persistent CUDA execution evidence is missing")
        if resident and (stats.get("host_to_device_ms") != 0 or stats.get("staging_ms") != 0):
            raise ValueError("Resident timing includes hidden input transfers")


def changed_facts(workload, shift=17, erase=False):
    """Keep CFG shape while replacing facts, including facts that must disappear."""
    result = copy.deepcopy(workload)
    result["name"] += f"-changed-{shift}" if not erase else "-cleared"
    for function in result["functions"]:
        count = function["value_count"]
        for block in function["blocks"]:
            for name in ("use", "def"):
                block[name] = [] if erase or not count else [(value + shift) % count for value in block[name]]
        for edge in function["phi_edge_uses"]:
            edge["values"] = [] if erase or not count else [(value + shift) % count for value in edge["values"]]
    return result


def prepare_pack(directory, workload):
    path = directory / f"{workload['name']}.bin"
    path.write_bytes(pack(workload))
    return path, oracle_words(workload)


def build_library(args, report, directory):
    nvcc = shutil.which("nvcc")
    if not nvcc:
        report.update(status="blocked", blockers=["nvcc is unavailable; native CUDA library was not compiled."])
        return False
    report["nvcc_version"] = run([nvcc, "--version"])
    probe_source = directory / "native-device-probe.cu"
    probe = directory / "native-device-probe"
    probe_source.write_text(DEVICE_PROBE)
    report["device_probe_build"] = run([nvcc, "-std=c++17", probe_source, "-o", probe])
    require_success(report["device_probe_build"])
    report["device_probe_execution"] = run([probe])
    if report["device_probe_execution"]["exit_code"] == 3:
        report.update(status="blocked", blockers=[report["device_probe_execution"]["stderr"].strip()])
        return False
    require_success(report["device_probe_execution"])
    report["device"] = json.loads(report["device_probe_execution"]["stdout"])
    device = report["device"]
    architecture = args.cuda_arch or f"sm_{device['compute_major']}{device['compute_minor']}"
    args.cuda_library.parent.mkdir(parents=True, exist_ok=True)
    report["native_library_build"] = run([nvcc, "-std=c++17", "-O3", f"-arch={architecture}",
        "--shared", "-Xcompiler=-fPIC,-pthread", ROOT / "native/cuda_bridge.cu", "-o", args.cuda_library])
    require_success(report["native_library_build"])
    report["cuda_compiled"] = True
    report["build_options"] = {"nvcc": report["native_library_build"]["command"],
        "rust": "Hosted exact-head cargo build --locked --release; source identity and binary checksums retained by CI artifact."}
    return True


def driver_command(args, profile=None):
    command = [args.benchmark_binary, "--serve", "--threads", args.threads]
    if not args.cpu_only:
        command += ["--cuda-library", args.cuda_library]
    if profile:
        command += ["--route-profile", profile]
    return command


def verify_lifecycle(args, report, directory):
    session = NativeSession(driver_command(args), directory / "lifecycle.stderr.log")
    records = []
    try:
        # Grow, shrink and erase facts inside the same CUDA context/pinned buffers.
        base = correctness_workloads()[0]
        larger = synthetic_workloads()[2]
        smaller = synthetic_workloads()[0]
        tests = [base, changed_facts(base), larger, smaller,
                 changed_facts(smaller, erase=True), smaller]
        for workload in tests:
            path, expected = prepare_pack(directory, workload)
            for alg in ("dense", "sparse") if not args.cpu_only else ("dense",):
                output = directory / f"lifecycle-{len(records)}.result.bin"
                response, wall = session.request("cpu" if args.cpu_only else "cuda", alg, path, output)
                validate_native(response, read_result(output), expected, not args.cpu_only)
                if not args.cpu_only:
                    cap = response["capabilities"]
                    if (cap.get("device_name") != report["device"]["name"] or
                        cap.get("device_uuid") != report["device"]["uuid_hex"] or
                        cap.get("driver_version") != report["device"]["driver_version"] or
                        cap.get("runtime_version") != report["device"]["runtime_version"]):
                        raise ValueError("Native CUDA device identity differs from independent runtime probe")
                records.append({"name": workload["name"], "algorithm": alg,
                    "input_sha256": sha256(path), "output_sha256": sha256(output),
                    "verified_cells": len(expected), "external_request_ms": wall, "report": response})
                if not args.cpu_only:
                    replay, replay_wall = session.request("cuda", alg, path, output, "resident")
                    validate_native(replay, read_result(output), expected, True, True)
                    if replay["gpu_stats"].get("reused_context") != 1:
                        raise ValueError("CUDA resident replay failed to reuse context")
                    records.append({"name": workload["name"], "algorithm": alg, "residency": "resident",
                                    "external_request_ms": replay_wall, "report": replay})
            if not args.cpu_only and workload is smaller:
                for alg in ("dense", "sparse"):
                    checked, wall = session.request("abi-check", alg, path, output)
                    validate_native(checked, read_result(output), expected, True)
                    if (checked.get("second_pending_submit_rejected") is not True or
                        checked.get("input_snapshot_ownership_checked") is not True or
                        checked["gpu_stats"].get("device_allocations") != 0 or
                        checked["gpu_stats"].get("pinned_allocations") != 0):
                        raise ValueError("Pending/ownership/high-water buffer reuse contract failed")
                    records.append({"native_adapter_contract": True, "external_request_ms": wall,
                                    "report": checked})
        invalid = directory / "malformed.bin"
        invalid.write_bytes(b"GLC1\0")
        rejected = directory / "must-not-exist.result.bin"
        rejected.unlink(missing_ok=True)
        failure, _ = session.request("cuda" if not args.cpu_only else "cpu", "dense", invalid,
                                     rejected, expected_error=True)
        if rejected.exists():
            raise ValueError("Malformed request created a result file")
        path, expected = prepare_pack(directory, smaller)
        output = directory / "recovered.result.bin"
        recovered, _ = session.request("cpu" if args.cpu_only else "cuda", "sparse", path, output)
        validate_native(recovered, read_result(output), expected, not args.cpu_only)
        records += [{"malformed_request_rejected": failure}, {"recovery_report": recovered}]
        if not args.cpu_only:
            changed, _ = prepare_pack(directory, changed_facts(smaller))
            failure, _ = session.request("cuda", "dense", changed, rejected,
                                         "resident", expected_error=True)
            records.append({"changed_resident_request_rejected": failure})
            for mixed in (correctness_workloads()[1], synthetic_workloads()[-1]):
                path, expected = prepare_pack(directory, mixed)
                for alg in ("dense", "sparse"):
                    output = directory / f"forced-{mixed['name']}-{alg}.result.bin"
                    response, wall = session.request("forced-hybrid", alg, path, output)
                    validate_native(response, read_result(output), expected, True)
                    if (response.get("actual_cpu_functions", 0) == 0 or
                        response.get("gpu_submitted_before_cpu") is not True or
                        response.get("cpu_work_before_gpu_finish") is not True):
                        raise ValueError("Mixed CPU/GPU submission ordering was not proved")
                    records.append({"forced_mixed": True, "algorithm": alg,
                                    "external_request_ms": wall, "report": response})
            if not any(record.get("forced_mixed") and
                       record["report"].get("gpu_event_pending_before_cpu") is True
                       for record in records):
                raise ValueError("No forced mixed case proved GPU request unfinished when CPU work began")
        report["lifecycle"] = {"verified": True, "same_process_id": session.pid, "records": records,
            "checks": ["changed facts replace obsolete facts", "buffer growth/shrink", "dense/sparse equality",
                       "malformed request rejection and subsequent recovery", "CPU/GPU independent subset scatter"],
            "overlap_limit": "CUDA completion event is queried before and after CPU work; at least one mixed case remains unfinished when CPU work begins. No GPU timeline is collected to prove kernel/CPU overlap duration."}
    finally:
        session.close()


def summarize_requests(records):
    return {"external_request_ms": statistics_ms([record["external_request_ms"] for record in records]),
            "native_recurrent_ms": statistics_ms([record["report"]["total_recurrent_ms"] for record in records]),
            "native_analysis_ms": statistics_ms([record["report"]["analysis_ms"] for record in records]),
            "reports": records}


def benchmark_fresh_analysis(args, directory, input_path, expected, calibration):
    """Actual cold processes, including library/context and CPU-pool creation."""
    modes = [("cpu", "dense")]
    if not args.cpu_only:
        modes += [("cuda", "dense"), ("cuda", "sparse")]
    result = {}
    selected = calibration["cpu_calibration"]
    for backend, algorithm in modes:
        samples = []
        for repeat in range(args.fresh_repeats):
            output = directory / f"cold-{input_path.stem}-{backend}-{algorithm}-{repeat}.result.bin"
            started = time.perf_counter()
            session = NativeSession(driver_command(args), directory / "cold.stderr.log")
            try:
                response, request_wall = session.request(backend, algorithm, input_path, output,
                    "update", f"{selected['selected_mode']}@{selected['selected_workers']}")
                wall = (time.perf_counter() - started) * 1000
                validate_native(response, read_result(output), expected, backend == "cuda")
                samples.append({"external_process_to_response_ms": wall,
                                "external_request_ms": request_wall, "report": response})
            finally:
                session.close()
        result[f"{backend}/{algorithm}"] = {
            "cold_external_ms": statistics_ms([sample["external_process_to_response_ms"] for sample in samples]),
            "samples": samples, "scope": "Fresh Rust process, reusable CPU pool creation, input read/decode, library/context creation when CUDA, analysis and response serialization. Output checks and process shutdown outside timer."}
    return result


def benchmark_analysis(args, report, directory):
    session = NativeSession(driver_command(args), directory / "benchmark.stderr.log")
    profile = directory / "measured-route-profile.csv"
    profile.unlink(missing_ok=True)
    records = []
    rng = random.Random(ORDER_SEED)
    try:
        for workload in synthetic_workloads():
            if args.workloads and workload["name"] not in args.workloads:
                continue
            # Held-out requests rotate value IDs by a different fixed amount.
            # The graph stays identical; this does not test unseen graph shapes.
            variants = [workload, changed_facts(workload, 17), changed_facts(workload, 43)]
            packs = [prepare_pack(directory, variant) for variant in variants]
            path, expected = packs[0]
            output = directory / "analysis.result.bin"
            calibration, _ = session.request("calibrate", "dense", path, output)
            validate_native(calibration, read_result(output), expected)
            selected_cpu = calibration["cpu_calibration"]["selected_mode"]
            modes = ["cpu-serial", "cpu-function_pool", "cpu-word_pool"]
            if not args.cpu_only:
                modes += ["cuda-dense-update", "cuda-sparse-update",
                          "cuda-dense-resident", "cuda-sparse-resident"]
                if workload["name"] == "mixed-compact-and-long":
                    modes += ["mixed-dense-update", "mixed-sparse-update"]
            measured = {mode: [] for mode in modes}
            first = {}
            count_train = args.repeats // 2
            invocation_order = []
            for repeat in range(args.repeats + 1):
                fact_index = repeat % 2 if repeat <= count_train else 2
                path, expected = packs[fact_index]
                order = modes.copy()
                rng.shuffle(order)
                invocation_order.append(order)
                for mode in order:
                    if mode.startswith("cpu-"):
                        cpu_name = mode.removeprefix("cpu-")
                        response, wall = session.request("cpu", "dense", path, output, "update", cpu_name)
                        validate_native(response, read_result(output), expected)
                    else:
                        _, algorithm, residency = mode.split("-")
                        if residency == "resident":
                            # Seed immediately before replay; upload timing is
                            # retained separately by the update variant.
                            seeded, _ = session.request("cuda", algorithm, path, output)
                            validate_native(seeded, read_result(output), expected, True)
                        response, wall = session.request("forced-hybrid" if mode.startswith("mixed-") else "cuda",
                                                         algorithm, path, output, residency, selected_cpu)
                        validate_native(response, read_result(output), expected, True, residency == "resident")
                    detail = {"external_request_ms": wall, "report": response,
                              "facts_variant": fact_index,
                              "sample_set": "training" if repeat <= count_train else "heldout"}
                    if repeat == 0:
                        first[mode] = detail
                    else:
                        measured[mode].append(detail)
            record = {"name": workload["name"], "scope": "Synthetic native liveness pass, not a Rust crate.",
                "functions": len(workload["functions"]), "input_sha256": [sha256(path) for path, _ in packs],
                "cpu_selected_variant": selected_cpu, "cpu_calibration": calibration,
                "first_requests": first, "invocation_order": invocation_order,
                "results": {mode: summarize_requests(values) for mode, values in measured.items()}}
            record["fresh_processes"] = benchmark_fresh_analysis(args, directory, packs[0][0], packs[0][1], calibration)
            if not args.cpu_only:
                cpu_samples = measured[f"cpu-{selected_cpu}"]
                cpu_ms = statistics.median([sample["report"]["total_recurrent_ms"] for sample in cpu_samples])
                comparisons = {}
                for algorithm in ("dense", "sparse"):
                    update = measured[f"cuda-{algorithm}-update"]
                    resident = measured[f"cuda-{algorithm}-resident"]
                    update_ms = statistics.median([sample["report"]["total_recurrent_ms"] for sample in update])
                    resident_ms = statistics.median([sample["report"]["analysis_ms"] for sample in resident])
                    comparisons[algorithm] = {"cpu_native_recurrent_median_ms": cpu_ms,
                        "cuda_native_recurrent_median_ms": update_ms,
                        "cpu_over_cuda_recurrent_ratio": cpu_ms / update_ms,
                        "cuda_resident_analysis_median_ms": resident_ms,
                        "ratio_scope": "Update-inclusive request: input file read, native GLC decode/reverse-edge construction, native solve/pinned staging/transfers/synchronization/result assembly, and output file write. JSON/IPC overhead measured separately."}
                record["comparison"] = comparisons
                # Select algorithm using training only. The shared Rust profile
                # rejects noisy wins and requires a separate held-out margin.
                chosen = min(("dense", "sparse"), key=lambda alg: statistics.median(
                    [sample["report"]["total_recurrent_ms"] for sample in measured[f"cuda-{alg}-update"]
                     if sample["sample_set"] == "training"]))
                gpu_samples = measured[f"cuda-{chosen}-update"]
                arrays = []
                for samples, sample_set in ((cpu_samples, "training"), (gpu_samples, "training"),
                                             (cpu_samples, "heldout"), (gpu_samples, "heldout")):
                    arrays.append(",".join(str(sample["report"]["total_recurrent_ms"])
                                           for sample in samples if sample["sample_set"] == sample_set))
                response, _ = session.line(("profile", packs[0][0], selected_cpu, chosen, *arrays, profile))
                if response.get("status") != "ok":
                    raise RuntimeError(response)
                record["calibration_profile_record"] = response
                if workload["name"] == "mixed-compact-and-long":
                    chosen_mixed = min(("dense", "sparse"), key=lambda alg: statistics.median(
                        [sample["report"]["total_recurrent_ms"] for sample in measured[f"mixed-{alg}-update"]
                         if sample["sample_set"] == "training"]))
                    mixed_samples = measured[f"mixed-{chosen_mixed}-update"]
                    mixed_arrays = []
                    for samples, sample_set in ((cpu_samples, "training"), (mixed_samples, "training"),
                                                 (cpu_samples, "heldout"), (mixed_samples, "heldout")):
                        mixed_arrays.append(",".join(str(sample["report"]["total_recurrent_ms"])
                                                   for sample in samples if sample["sample_set"] == sample_set))
                    indices = ",".join(str(index) for index, function in enumerate(workload["functions"])
                                       if len(function["blocks"]) <= 64)
                    response, _ = session.line(("profile", packs[0][0], selected_cpu, chosen_mixed,
                                               *mixed_arrays, profile, indices))
                    if response.get("status") != "ok":
                        raise RuntimeError(response)
                    record["mixed_context_calibration"] = response
            records.append(record)
        report["analysis_workloads"] = records
        report["analysis_timing_scope"] = {
            "update": "Repeated native request including read, decode, predecessor packing, pool scheduling OR pinned staging/H2D/kernel/wait/D2H, assembly and result-file write; no Python analysis.",
            "resident": "Identical prior GPU input replay; no packing/staging/H2D. Result is reset from prior facts, returned and checked. Presented separately, never used as a routing-speedup claim.",
            "cpu": "Same-process native serial/function-parallel/word-parallel worklists with a reusable worker pool. Mode selected by independent calibration samples; worker startup recorded separately.",
            "verification": "Every result cell compared against independent set oracle after timing; input mutations include removal of old bits.",
            "routing": "Training and held-out arrays are separate; conservative profile requires GPU p90 below CPU p10 by 10% in both. Missing/noisy/unknown shapes fall back to CPU."}
        report["analysis_timing_scope"]["heldout_limit"] = (
            "Held-out timings use deterministic value-ID rotations on identical CFGs, "
            "not independent graph geometries. No broader generalization claim is made.")
        if not args.cpu_only:
            report["route_profile"] = {"path": str(profile), "sha256": sha256(profile),
                                      "text": profile.read_text()}
    finally:
        session.close()
    if not args.cpu_only:
        adaptive = NativeSession(driver_command(args, profile), directory / "adaptive.stderr.log")
        adaptive_records = []
        try:
            for workload in synthetic_workloads():
                if args.workloads and workload["name"] not in args.workloads:
                    continue
                changed = changed_facts(workload, 71)
                path, expected = prepare_pack(directory, changed)
                output = directory / "adaptive.result.bin"
                for _ in range(5):
                    response, wall = adaptive.request("hybrid", "dense", path, output)
                    validate_native(response, read_result(output), expected,
                                    response.get("actual_gpu_functions", 0) > 0)
                    adaptive_records.append({"name": workload["name"],
                        "external_request_ms": wall, "report": response})
            report["adaptive_routing"] = {"records": adaptive_records,
                "cpu_only_decisions": sum(record["report"]["actual_gpu_functions"] == 0 for record in adaptive_records),
                "gpu_decisions": sum(record["report"]["actual_gpu_functions"] > 0 for record in adaptive_records),
                "scope": "Additional held-out value facts. CPU-only is a valid measured result, not GPU acceleration."}
        finally:
            adaptive.close()
    return profile if not args.cpu_only else None


def verify_program_output(path, expected):
    execution = run([path], timeout=30)
    require_success(execution)
    if execution["stdout"] != expected or execution["stderr"]:
        raise ValueError(f"Compiled program differs from standard rustc reference: {execution}")


def compiler_command(args, mode, profile=None, serve=False, cpu_workers=None, objective="latency"):
    backend, algorithm = mode.split("/", 1)
    command = [args.compiler_binary, "--backend", backend]
    command += ["--cpu-workers", args.threads if cpu_workers is None else cpu_workers,
                "--mode", objective]
    if backend.startswith("cuda"):
        command += ["--cuda-algorithm", algorithm, "--cuda-library", args.cuda_library]
    if profile and backend == "cuda-hybrid":
        command += ["--route-profile", profile]
    if serve:
        command += ["--serve"]
    return command


def benchmark_compilation(args, report, directory, profile):
    if args.skip_compilation:
        report["complete_compilation"] = {"status": "skipped_explicitly"}
        return
    if not args.references.is_dir():
        raise RuntimeError(f"Standard rustc references unavailable: {args.references}")
    programs = (args.references / "programs.txt").read_text().splitlines()
    reference_files = [path for path in args.references.iterdir() if path.is_file()]
    report["standard_rust_references"] = {
        "rustc_identity": (args.references / "rustc-version.txt").read_text(),
        "sha256": {path.name: sha256(path) for path in sorted(reference_files)},
        "source": "Compiled and executed by pinned standard rustc on hosted CPU job; immutable artifact verified before GPU job."}
    modes = ["cpu/dense"]
    if not args.cpu_only:
        modes += ["cuda/dense", "cuda/sparse", "cuda-hybrid/dense"]
    workers = {mode: NativeSession(compiler_command(args, mode, profile, True),
                                  directory / f"compile-{mode.replace('/', '-')}.stderr.log") for mode in modes}
    rng = random.Random(ORDER_SEED + 2)
    results = []
    cold = []
    try:
        for name in programs:
            source = args.references / f"{name}.rs"
            expected = (args.references / f"{name}.expected.txt").read_text()
            output = directory / f"program-{name}"
            detail_path = directory / f"program-{name}.json"
            measured = {f"{mode}/{scope}": [] for mode in modes for scope in ("fresh", "persistent")}
            for mode in modes:
                response, wall = workers[mode].line(("compile", source, output, detail_path))
                if response.get("status") != "ok":
                    raise RuntimeError(response)
                verify_program_output(output, expected)
                cold.append({"program": name, "mode": mode, "external_request_ms": wall, "report": response})
            order = list(measured)
            for repeat in range(args.compile_repeats):
                rng.shuffle(order)
                for key in order:
                    backend, algorithm, scope = key.split("/")
                    mode = f"{backend}/{algorithm}"
                    if scope == "persistent":
                        response, wall = workers[mode].line(("compile", source, output, detail_path))
                        if response.get("status") != "ok":
                            raise RuntimeError(response)
                    else:
                        command = compiler_command(args, mode, profile) + [source, "--output", output,
                                                                            "--report", detail_path]
                        start = time.perf_counter()
                        compiled = run(command, timeout=180)
                        wall = (time.perf_counter() - start) * 1000
                        require_success(compiled)
                        response = json.loads(detail_path.read_text())
                    verify_program_output(output, expected)
                    if backend == "cuda":
                        if response.get("actual_gpu_functions", 0) < 1:
                            raise ValueError("Explicit native CUDA compilation did not execute GPU")
                        if scope == "persistent":
                            stats = response.get("cuda_stats") or {}
                            if (response.get("gpu_pipeline_creations") != 1 or
                                stats.get("reused_context") != 1 or
                                stats.get("device_allocations") != 0 or
                                stats.get("pinned_allocations") != 0):
                                raise ValueError("Complete compiler did not reuse native CUDA context/buffers")
                        # Root compiler emits lifecycle statistics using the same
                        # in-process context. Keep every report for exact proof.
                    measured[key].append({"external_compile_ms": wall, "report": response,
                                          "output_sha256": sha256(output), "expected_output": expected})
            results.append({"name": name, "source_sha256": sha256(source), "expected_output": expected,
                "results": {key: {"external_compile_ms": statistics_ms([sample["external_compile_ms"] for sample in samples]),
                                  "reports": samples} for key, samples in measured.items()}})
        report["complete_compilation"] = {"status": "verified", "programs": results, "initial_requests": cold,
            "scope": "Complete compilation of supported scalar Rust programs, including frontend, native analysis, pruning, LLVM emission, Clang codegen/link, reporting and IPC/process startup. Executable verification occurs outside timer. No Python analysis path.",
            "limitations": "Not a full Rust compiler or NemoClaw/Omarchy Cargo build. Standard rustc executes references on hosted CPU hardware, so its build time is not compared with GPU-runner compilation times."}
    finally:
        for worker in workers.values():
            worker.close()
    benchmark_compile_throughput(args, report, directory, programs, modes)


def benchmark_compile_throughput(args, report, directory, programs, modes):
    """Concurrent, persistent compiler processes with equal CPU thread budgets."""
    concurrency = args.concurrency
    available = report["analysis_workloads"][0]["cpu_calibration"]["cpu_pool_workers"]
    pool_budget = max(1, available // concurrency)
    cohort = programs * concurrency
    worker_sets = {}
    samples = {mode: [] for mode in modes}
    warmup = []
    seed = ORDER_SEED + 3
    rng = random.Random(seed)
    cohort_orders = []
    try:
        for mode in modes:
            workers = [NativeSession(compiler_command(args, mode, None, True, pool_budget, "throughput"),
                                      directory / f"throughput-{mode.replace('/', '-')}-{index}.stderr.log")
                       for index in range(concurrency)]
            worker_sets[mode] = workers
            # Warm every process/context at the largest supported fixture shape.
            for index, worker in enumerate(workers):
                for name in programs:
                    source = args.references / f"{name}.rs"
                    output = directory / f"throughput-warm-{mode.replace('/', '-')}-{index}-{name}"
                    detail = output.with_suffix(".json")
                    response, wall = worker.line(("compile", source, output, detail))
                    if response.get("status") != "ok":
                        raise RuntimeError(response)
                    verify_program_output(output, (args.references / f"{name}.expected.txt").read_text())
                    warmup.append({"mode": mode, "worker": index, "program": name,
                                   "external_request_ms": wall, "report": response})
        for repeat in range(args.throughput_repeats):
            order = list(modes)
            rng.shuffle(order)
            cohort_orders.append(order)
            for mode in order:
                workers = worker_sets[mode]
                def compile_partition(index):
                    completed = []
                    for job in range(index, len(cohort), concurrency):
                        name = cohort[job]
                        source = args.references / f"{name}.rs"
                        output = directory / f"throughput-{mode.replace('/', '-')}-{repeat}-{job}"
                        detail = output.with_suffix(".json")
                        response, elapsed = workers[index].line(("compile", source, output, detail))
                        if response.get("status") != "ok":
                            raise RuntimeError(response)
                        if response.get("cpu_worker_threads") != pool_budget:
                            raise ValueError("Concurrent compiler CPU budget differs between modes")
                        if mode.startswith("cuda/") and response.get("actual_gpu_functions", 0) < 1:
                            raise ValueError("Concurrent explicit CUDA compiler did not execute GPU")
                        if mode.startswith("cuda-hybrid/") and response.get("actual_gpu_functions") != 0:
                            raise ValueError("Throughput routing used uncalibrated GPU policy")
                        completed.append({"job": job, "program": name, "external_request_ms": elapsed,
                                          "report": response, "output": str(output)})
                    return completed
                with ThreadPoolExecutor(max_workers=concurrency) as executor:
                    start = time.perf_counter()
                    futures = [executor.submit(compile_partition, index) for index in range(concurrency)]
                    completed = [job for future in futures for job in future.result()]
                    wall = (time.perf_counter() - start) * 1000
                for job in completed:
                    expected = (args.references / f"{job['program']}.expected.txt").read_text()
                    verify_program_output(Path(job["output"]), expected)
                samples[mode].append({"cohort_wall_ms": wall, "jobs_per_second": len(cohort) * 1000 / wall,
                                      "request_ms": statistics_ms([job["external_request_ms"] for job in completed]),
                                      "jobs": completed, "all_outputs_match_standard_rustc": True})
    finally:
        for workers in worker_sets.values():
            for worker in workers:
                worker.close()
    records = []
    for mode, measured in samples.items():
        wall_stats = statistics_ms([sample["cohort_wall_ms"] for sample in measured])
        records.append({"mode": mode, "process_count": concurrency, "cpu_workers_per_process": pool_budget,
                        "jobs_per_cohort": len(cohort), "cohort_wall_ms": wall_stats,
                        "jobs_per_second_at_median_wall": len(cohort) * 1000 / wall_stats["median_ms"],
                        "samples": measured})
    report["complete_compile_throughput"] = {"results": records,
        "order_seed": seed, "cohort_invocation_order": cohort_orders,
        "warmup_requests": warmup,
        "scope": "Same cohort, same machine, concurrent persistent native compiler processes, equal CPU worker budgets. Includes compilation/reporting; output execution checked after cohort timer.",
        "routing": "No concurrent throughput calibration exists. No latency profile is supplied to throughput mode; cuda-hybrid must visibly use CPU fallback.",
        "limits": "Supported scalar programs only; process/GPU contention measured here does not establish full NemoClaw build throughput."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler-binary", type=Path, default=ROOT / ".build/compiler/release/gpu-rust-compiler")
    parser.add_argument("--benchmark-binary", type=Path, default=ROOT / ".build/compiler/release/gpu-native-benchmark")
    parser.add_argument("--cuda-library", type=Path, default=ROOT / ".build/cuda/libgpu_cuda.so")
    parser.add_argument("--references", type=Path, default=ROOT / ".build/ci-native/references")
    parser.add_argument("--repeats", type=int, default=21)
    parser.add_argument("--compile-repeats", type=int, default=9)
    parser.add_argument("--fresh-repeats", type=int, default=3)
    parser.add_argument("--throughput-repeats", type=int, default=5)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--threads", type=int, default=0,
                        help="Reusable native CPU pool size; 0 uses all available CPUs")
    parser.add_argument("--report", type=Path, default=ROOT / "results/native-cuda-verification.json")
    parser.add_argument("--cuda-arch")
    parser.add_argument("--cpu-only", action="store_true")
    parser.add_argument("--skip-compilation", action="store_true")
    parser.add_argument("--workloads", nargs="+", choices=[case["name"] for case in synthetic_workloads()])
    args = parser.parse_args()
    if not 11 <= args.repeats <= 1000:
        parser.error("--repeats must be 11..=1000 to retain independent training and held-out samples")
    if not 1 <= args.compile_repeats <= 100 or not 0 <= args.threads <= 256:
        parser.error("--compile-repeats must be 1..=100; --threads must be 0..=256")
    if not 1 <= args.throughput_repeats <= 100 or not 1 <= args.concurrency <= 16:
        parser.error("--throughput-repeats must be 1..=100; --concurrency must be 1..=16")
    if not 1 <= args.fresh_repeats <= 100:
        parser.error("--fresh-repeats must be 1..=100")
    directory = ROOT / ".build/verification/native-cuda"
    directory.mkdir(parents=True, exist_ok=True)
    report = {"status": "not_run", "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_revision": os.environ.get("CANDIDATE_SHA") or os.environ.get("GITHUB_SHA"),
        "hardware": hardware(), "repeats": args.repeats, "compile_repeats": args.compile_repeats,
        "gpu_executed": False, "cuda_compiled": False, "generator_seed": GENERATOR_SEED,
        "order_seed": ORDER_SEED, "threads": args.threads, "related_evidence": related_evidence(),
        "scope": "Non-shipping persistent native CUDA compiler experiment; supported scalar programs and synthetic analyses only.",
        "tools": {name: tool_identity(name) for name in ("nvcc", "clang", "nvidia-smi")}}
    exit_code = 1
    try:
        if not args.cpu_only and not build_library(args, report, directory):
            exit_code = 3
        else:
            binaries = {"compiler": args.compiler_binary, "benchmark": args.benchmark_binary}
            if not args.cpu_only:
                binaries["native_cuda_library"] = args.cuda_library
            report["binaries"] = {name: {"path": str(path.resolve()), "sha256": sha256(path)}
                                  for name, path in binaries.items()}
            sources = list((ROOT / "compiler/src").rglob("*.rs")) + [ROOT / "native/cuda_bridge.cu",
                        ROOT / "native/cuda_bridge.h", Path(__file__).resolve()]
            report["implementation_sha256"] = {str(path.relative_to(ROOT)): sha256(path)
                                                for path in sources if path.is_file()}
            verify_lifecycle(args, report, directory)
            report.update(gpu_executed=not args.cpu_only, native_lifecycle_verified=True)
            profile = benchmark_analysis(args, report, directory)
            benchmark_compilation(args, report, directory, profile)
            report.update(status="cpu_only_verified" if args.cpu_only else "verified_native_cuda",
                          gpu_executed=not args.cpu_only, all_outputs_independently_verified=True)
            exit_code = 0
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        report.update(status="failed", error=str(error))
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "report": str(args.report),
                      "gpu_executed": report["gpu_executed"], "error": report.get("error"),
                      "blockers": report.get("blockers", [])}, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
