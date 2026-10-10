#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Verify the CUDA pass on a real CUDA device; retain explicit blocked evidence.

The host format checker can run without CUDA. It excludes all CUDA code and is
never CUDA compilation, GPU execution, or end-to-end Rust compilation evidence.
Exit codes: 0 verified CUDA pass, 1 verification failure, 3 CUDA unavailable.
"""
import argparse
import hashlib
import json
import platform
import random
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from export_cuda import pack, read_result

ROOT = Path(__file__).resolve().parents[1]

DEVICE_PROBE = r'''
#include <cuda_runtime.h>
#include <iomanip>
#include <iostream>
int main() {
    int count = 0;
    auto error = cudaGetDeviceCount(&count);
    if (error != cudaSuccess || count == 0) {
        std::cerr << "cudaGetDeviceCount: " << cudaGetErrorString(error)
                  << "; device_count=" << count << '\n';
        return 3;
    }
    cudaDeviceProp device{};
    error = cudaGetDeviceProperties(&device, 0);
    if (error != cudaSuccess) { std::cerr << cudaGetErrorString(error); return 1; }
    char pci[32]{};
    error = cudaDeviceGetPCIBusId(pci, sizeof(pci), 0);
    if (error != cudaSuccess) { std::cerr << cudaGetErrorString(error); return 1; }
    int driver = 0, runtime = 0;
    if (cudaDriverGetVersion(&driver) != cudaSuccess ||
        cudaRuntimeGetVersion(&runtime) != cudaSuccess) return 1;
    std::cout << "{\"device_count\":" << count << ",\"device_ordinal\":0,\"name\":"
              << std::quoted(device.name) << ",\"pci_bus_id\":" << std::quoted(pci)
              << ",\"compute_major\":" << device.major << ",\"compute_minor\":" << device.minor
              << ",\"driver_version\":" << driver << ",\"runtime_version\":" << runtime
              << ",\"global_memory_bytes\":" << device.totalGlobalMem
              << ",\"uuid_hex\":\"";
    for (unsigned char byte : device.uuid.bytes)
        std::cout << std::hex << std::setw(2) << std::setfill('0') << unsigned(byte);
    std::cout << "\"}\n";
}
'''


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(command, timeout=120):
    try:
        done = subprocess.run([str(value) for value in command], capture_output=True,
                              text=True, timeout=timeout)
        return {"command": [str(value) for value in command], "exit_code": done.returncode,
                "stdout": done.stdout, "stderr": done.stderr}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"command": [str(value) for value in command], "exit_code": None,
                "stdout": "", "stderr": str(error)}


def require_success(result):
    if result["exit_code"] != 0:
        raise RuntimeError(result["stderr"] or result["stdout"] or "command failed")


def tool_identity(name):
    path = shutil.which(name)
    return {"path": path, "resolved_path": str(Path(path).resolve()) if path else None,
            "sha256": sha256(path) if path else None}


def oracle_words(workload):
    """Independent set fixed point, without backend bitsets or group layouts."""
    result = []
    for function in workload["functions"]:
        blocks = function["blocks"]
        phi = [set() for _ in blocks]
        for edge in function["phi_edge_uses"]:
            phi[edge["from"]].update(edge["values"])
        live = [set() for _ in blocks]
        for _ in range(len(blocks) + 2):
            following = []
            for index, block in enumerate(blocks):
                out = phi[index].union(*(live[target] for target in block["successors"]))
                following.append(set(block["use"]) | (out - set(block["def"])))
            if following == live:
                break
            live = following
        else:
            raise RuntimeError("independent set oracle did not converge")
        width = max(1, (function["value_count"] + 31) // 32)
        for values in live:
            row = [0] * width
            for value in values:
                row[value // 32] |= 1 << (value % 32)
            result.extend(row)
    return result


def workloads():
    rng = random.Random(1709)
    functions = []
    for values in (0, 1, 31, 32, 33, 65, 129):
        for count in (1, 7, 35):
            blocks = []
            for index in range(count):
                blocks.append({"name": str(index),
                    "successors": sorted({rng.randrange(count) for _ in range(rng.randrange(4))}),
                    "use": rng.sample(range(values), min(values, 4)),
                    "def": rng.sample(range(values), min(values, 3))})
            edges = [{"from": index, "to": target,
                      "values": rng.sample(range(values), min(values, 2))}
                     for index, block in enumerate(blocks) for target in block["successors"]]
            functions.append({"name": f"seeded_{values}_{count}", "value_count": values,
                              "blocks": blocks, "phi_edge_uses": edges})
    path = {"name": "long_path_cycle", "value_count": 65,
            "blocks": [{"name": str(index), "successors": [index + 1] if index < 255 else [128],
                        "use": [32, 64] if index == 255 else [], "def": []}
                       for index in range(256)], "phi_edge_uses": []}
    functions.append(path)
    small = {"name": "small", "value_count": 33,
             "blocks": [{"name": "entry", "successors": [1], "use": [], "def": [0]},
                        {"name": "exit", "successors": [], "use": [0, 32], "def": []}],
             "phi_edge_uses": [{"from": 0, "to": 1, "values": [32]}]}
    mixed = [dict(small, name=f"small_{index}") for index in range(1024)]
    mixed += [dict(path, name=f"path_{index}") for index in range(4)]
    return [{"version": 1, "name": "seeded-correctness", "functions": functions},
            {"version": 1, "name": "mixed-small-and-long", "functions": mixed}]


def host_format_check(report, directory, packs):
    compiler = report["tools"]["clang++"]["path"] or report["tools"]["g++"]["path"]
    if compiler is None:
        report["host_format_check"] = {"status": "unavailable", "gpu_executed": False}
        return
    binary = directory / "cuda-format-check"
    build = run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
                 "-DGLC_FORMAT_CHECK_ONLY", "-x", "c++", ROOT / "cuda/liveness.cu", "-o", binary])
    report["host_format_check"] = {"build": build, "gpu_executed": False,
        "cuda_code_compiled": False,
        "scope": "Only binary input parsing and dimension/CFG validation; CUDA code excluded."}
    require_success(build)
    checks = []
    for path in packs:
        checked = run([binary, path])
        checks.append(checked)
        require_success(checked)
        if json.loads(checked["stdout"])["gpu_executed"] is not False:
            raise RuntimeError("host parser checker reported GPU execution")
    original = packs[0].read_bytes()
    for name, data in (("truncated", original[:-1]), ("wrong-magic", b"XXXX" + original[4:])):
        path = directory / f"invalid-{name}.bin"
        path.write_bytes(data)
        checked = run([binary, path])
        checks.append(checked)
        if checked["exit_code"] != 1:
            raise RuntimeError(f"host format checker did not reject {name}")
    report["host_format_check"].update(status="passed", checks=checks, binary_sha256=sha256(binary))


def verify(report, args):
    directory = ROOT / ".build/verification/cuda"
    directory.mkdir(parents=True, exist_ok=True)
    test_workloads = workloads()
    packs = []
    report["workpacks"] = []
    for workload in test_workloads:
        json_path = directory / f"{workload['name']}.json"
        json_path.write_text(json.dumps(workload, indent=2) + "\n")
        path = directory / f"{workload['name']}.bin"
        path.write_bytes(pack(workload))
        packs.append(path)
        report["workpacks"].append({"name": workload["name"], "functions": len(workload["functions"]),
            "source_json_sha256": sha256(json_path), "binary_input_sha256": sha256(path),
            "scope": "Generated analysis workload; not a full Rust crate or build."})
    host_format_check(report, directory, packs)
    nvcc = report["tools"]["nvcc"]["path"]
    if nvcc is None:
        cmake = report["tools"]["cmake"]["path"]
        if cmake:
            report["cmake_configuration"] = run([cmake, "-S", ROOT / "cuda", "-B", directory / "cmake"])
        report.update(status="blocked", blockers=["nvcc is absent; CUDA source was not compiled.",
            "No CUDA runtime device probe could run; no NVIDIA GPU execution is verified."])
        return 3
    report["nvcc_version"] = run([nvcc, "--version"])
    probe_source, probe_binary = directory / "device-probe.cu", directory / "device-probe"
    probe_source.write_text(DEVICE_PROBE)
    report["device_probe_build"] = run([nvcc, "-std=c++17", probe_source, "-o", probe_binary])
    require_success(report["device_probe_build"])
    report["device_probe_source_sha256"] = sha256(probe_source)
    report["device_probe_binary_sha256"] = sha256(probe_binary)
    report["device_probe_execution"] = run([probe_binary])
    probe = report["device_probe_execution"]
    if probe["exit_code"] == 3:
        report.update(status="blocked", blockers=[probe["stderr"].strip()])
        return 3
    require_success(probe)
    report["device"] = json.loads(probe["stdout"])
    nvidia_smi = report["tools"]["nvidia-smi"]["path"]
    if nvidia_smi:
        report["nvidia_smi_identity"] = run([nvidia_smi,
            "--query-gpu=index,name,uuid,pci.bus_id,driver_version", "--format=csv,noheader"])
    architecture = args.cuda_arch or f"sm_{report['device']['compute_major']}{report['device']['compute_minor']}"
    binary = ROOT / ".build/cuda/cuda-liveness"
    binary.parent.mkdir(parents=True, exist_ok=True)
    report["cuda_build"] = run([nvcc, "-std=c++17", "-O2", f"-arch={architecture}",
                                ROOT / "cuda/liveness.cu", "-o", binary])
    require_success(report["cuda_build"])
    report["cuda_compiled"] = True
    report["cuda_binary_sha256"] = sha256(binary)
    for workload, path, record in zip(test_workloads, packs, report["workpacks"]):
        output = path.with_suffix(".result.bin")
        output.unlink(missing_ok=True)
        record["cuda_execution"] = run([binary, path, output, args.repeats])
        require_success(record["cuda_execution"])
        actual, expected = read_result(output), oracle_words(workload)
        metrics = json.loads(record["cuda_execution"]["stdout"])
        if (metrics["backend"] != "cuda" or metrics["device_name"] != report["device"]["name"] or
            metrics["device_ordinal"] != 0 or metrics["converged"] is not True or
            metrics["repeat_outputs_equal"] is not True or
            metrics["gpu_execution_ms"]["median_ms"] <= 0):
            raise RuntimeError("CUDA execution evidence is incomplete or inconsistent")
        report["gpu_executed"] = True
        if actual != expected:
            raise RuntimeError(f"{workload['name']}: CUDA output differs from independent set oracle")
        record.update(verified_against_independent_cpu_oracle=True,
                      verified_cells=len(actual), result_sha256=sha256(output), metrics=metrics)
    report.update(status="verified_cuda_pass", cuda_compiled=True, gpu_executed=True,
                  verified_all_workpacks=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=ROOT / "results/cuda-verification.json")
    parser.add_argument("--repeats", type=int, default=7)
    parser.add_argument("--cuda-arch", help="Override detected nvcc target, e.g. sm_89")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10000:
        parser.error("--repeats must be between 1 and 10000")
    report = {"recorded_at_utc": datetime.now(timezone.utc).isoformat(),
        "platform": {"system": platform.system(), "release": platform.release(),
                     "machine": platform.machine(), "python": platform.python_version()},
        "status": "not_run", "cuda_compiled": False, "gpu_executed": False,
        "verified_all_workpacks": False,
        "scope": "CUDA liveness analysis only. Does not verify a CUDA Rust compiler, its persistent adapter, full Cargo/NemoClaw builds, or speedups.",
        "tools": {name: tool_identity(name) for name in ("nvcc", "nvidia-smi", "clang++", "g++", "cmake")},
        "sources_sha256": {str(path.relative_to(ROOT)): sha256(path) for path in
            (ROOT / "cuda/liveness.cu", ROOT / "cuda/CMakeLists.txt",
             ROOT / "scripts/export_cuda.py", Path(__file__).resolve())},
        "required_environment": "An authorized NVIDIA CUDA GPU host, compatible NVIDIA driver, nvcc toolkit, Python 3.9+, and a host C++ compiler. No remote host is selected or contacted by this script."}
    try:
        exit_code = verify(report, args)
    except (RuntimeError, ValueError, KeyError, OSError) as error:
        report.update(status="failed", error=str(error))
        exit_code = 1
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "cuda_compiled": report["cuda_compiled"],
        "gpu_executed": report["gpu_executed"], "report": str(args.report),
        "blockers": report.get("blockers", []), "error": report.get("error")}, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
