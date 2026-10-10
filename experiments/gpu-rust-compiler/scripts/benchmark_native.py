#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Compare subset compilation with fresh and persistent native workers."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import platform
import statistics
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / ".build/compiler/release/gpu-rust-compiler"


def command(arguments):
    result = subprocess.run([str(value) for value in arguments], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return result


class Worker:
    def __init__(self, backend):
        self.process = subprocess.Popen([str(BINARY), "--serve", "--backend", backend, "--verify"],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, bufsize=1)
    def compile(self, source, output, report):
        fields = (source, output, report)
        if any('\t' in str(value) or '\n' in str(value) for value in fields):
            raise ValueError("Worker paths contain protocol delimiters")
        self.process.stdin.write("compile\t" + '\t'.join(str(value) for value in fields) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Native worker ended without a response")
        value = json.loads(line)
        if value.get("status") != "ok":
            raise RuntimeError(value)
        return value
    def close(self):
        if self.process.poll() is None:
            self.process.stdin.write("quit\n"); self.process.stdin.flush()
        self.process.communicate(timeout=20)
        if self.process.returncode:
            raise RuntimeError(f"Worker exited {self.process.returncode}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=15)
    parser.add_argument("--backends", nargs="+", choices=("cpu", "metal", "hybrid"),
                        default=["cpu", "metal", "hybrid"] if platform.system() == "Darwin" else ["cpu"])
    parser.add_argument("--report", type=Path, default=ROOT / "results/native-adapter.json")
    args = parser.parse_args()
    if args.repeats < 1:
        raise ValueError("repeats must be positive")
    # Build outside the measured interval, including the in-process Metal dylib.
    command(["cargo", "build", "--locked", "--release", "--manifest-path", ROOT / "compiler/Cargo.toml", "--target-dir", ROOT / ".build/compiler"])
    directory = ROOT / ".build/native-benchmark"
    directory.mkdir(parents=True, exist_ok=True)
    source = ROOT / "fixtures/compiler_demo.rs"
    reference = directory / "reference.rs"
    reference.write_text(f'mod p{{include!("{source}");pub fn run(){{println!("{{}}",main());}}}}fn main(){{p::run();}}')
    expected = "1460\n"
    invocations = {"rustc_process": ["rustc", "--edition=2021", "-Awarnings", "-C", "overflow-checks=off", "-C", "opt-level=0", reference, "-o", directory / "rustc_process"]}
    for mode in dict.fromkeys(args.backends):
        invocations[f"native_{mode}_process"] = [BINARY, source, "--backend", mode, "--verify", "--output", directory / f"native_{mode}_process", "--report", directory / f"native_{mode}_process.json"]
    workers = {f"native_{mode}_worker": Worker(mode) for mode in dict.fromkeys(args.backends)}
    names = list(invocations) + list(workers)
    samples = {name: [] for name in names}
    details = {name: [] for name in names}
    cold_workers = {}

    def compile_one(name):
        if name in workers:
            return workers[name].compile(source, directory / name, directory / f"{name}.json")
        result = command(invocations[name])
        return json.loads(result.stdout) if name.startswith("native_") else {}

    def verify_output(name):
        if command([directory / name]).stdout != expected:
            raise RuntimeError(f"Native program output differs: {name}")

    try:
        # Initial requests expose pipeline creation; all timed worker requests are hot.
        for name in names:
            start = time.perf_counter(); detail = compile_one(name)
            elapsed = (time.perf_counter() - start) * 1000
            verify_output(name)
            if name in workers:
                cold_workers[name] = {"external_elapsed_ms": elapsed, "report": detail}
        for repetition in range(args.repeats):
            for offset in range(len(names)):
                name = names[(repetition + offset) % len(names)]
                start = time.perf_counter(); detail = compile_one(name)
                samples[name].append((time.perf_counter() - start) * 1000)
                details[name].append(detail)
                verify_output(name)  # Outside compilation timing.
        if "native_metal_worker" in details:
            metal_reports = details["native_metal_worker"]
            if not all(report["gpu_pipeline_reused"] and report["gpu_pipeline_creations"] == 1
                       and report["gpu_buffer_allocations"] == 0 and report["actual_gpu_functions"] > 0
                       for report in metal_reports):
                raise RuntimeError("Persistent Metal reuse was not established")
        for name in workers:
            if len({report["process_id"] for report in details[name]}) != 1:
                raise RuntimeError("Worker process changed during measurement")
    finally:
        for worker in workers.values():
            worker.close()
    paths = [path for folder in (ROOT / "compiler", ROOT / "native") for path in folder.rglob('*')
             if path.is_file() and path.suffix in ('.rs', '.toml', '.mm', '.h') and 'target' not in path.parts]
    report = {
        "scope": "Complete supported-subset compilation; not full Rust language equivalence or NemoClaw acceleration.",
        "recorded_at_utc": datetime.now(timezone.utc).isoformat(), "repeats": args.repeats,
        "hardware": platform.platform(), "rustc": command(["rustc", "--version"]).stdout.strip(),
        "clang": command(["clang", "--version"]).stdout.strip(),
        "source": str(source), "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "implementation_sha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(paths)},
        "measurement": "External process elapsed or persistent write-request-to-read-response time, including codegen/linking/reporting, excluding build setup and executing output. Persistent-worker initialization is reported separately. Verification is enabled for native paths.",
        "remaining_codegen_subprocess": "clang", "all_native_outputs_verified": True,
        "cold_worker_initial_requests": cold_workers,
        "results": {name: {"median_ms": statistics.median(values), "samples_ms": values, "reports": details[name],
                            "command": [str(value) for value in invocations[name]] if name in invocations else [str(BINARY), "--serve", "--backend", name.split('_')[1], "--verify"]}
                    for name, values in samples.items()},
    }
    destination = args.report
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(destination), "medians_ms": {name: round(result["median_ms"], 3) for name, result in report["results"].items()}}, indent=2))


if __name__ == "__main__":
    main()
