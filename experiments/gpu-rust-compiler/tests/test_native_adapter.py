# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Native adapter correctness, persistent GPU reuse, and request isolation."""
import json
import platform
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / ".build/compiler/release/gpu-rust-compiler"


class NativeAdapterTests(unittest.TestCase):
    def test_native_backends_match_standard_rust(self):
        sources = [
            (ROOT / "fixtures/compiler_demo.rs").read_text(),
            """fn danger(n:i64)->bool { return 1/n>0; }
               fn main()->i64 { let mut r:i64=17;
                 if false && danger(0) { r=99; }
                 if true || danger(0) { r=r+3; }
                 return r; }""",
            """fn main()->bool { let mut i:i64=0; let mut n:i64=0;
                 while i<9 { if (i&1)==0 { n=n+i; } else { n=n-1; } i=i+1; }
                 return n==16; }""",
        ]
        with tempfile.TemporaryDirectory(dir=ROOT / ".build") as directory:
            directory = Path(directory)
            for index, text in enumerate(sources):
                source = directory / f"source{index}.rs"
                source.write_text(text)
                reference = directory / f"reference{index}.rs"
                reference.write_text(f'mod p {{ include!("{source}");pub fn run(){{println!("{{}}",main() as i64);}}}}fn main(){{p::run();}}')
                reference_bin = directory / f"reference{index}"
                built = subprocess.run(["rustc", "-Awarnings", "-C", "overflow-checks=off", str(reference), "-o", str(reference_bin)], capture_output=True, text=True)
                self.assertEqual(built.returncode, 0, built.stderr)
                expected = subprocess.check_output([str(reference_bin)], text=True)
                backends = ("cpu", "metal", "hybrid") if platform.system() == "Darwin" else ("cpu",)
                for backend in backends:
                    output = directory / f"{backend}{index}"
                    built = subprocess.run([str(BINARY), str(source), "--backend", backend, "--verify", "--output", str(output)], capture_output=True, text=True)
                    self.assertEqual(built.returncode, 0, built.stderr)
                    report = json.loads(built.stdout)
                    self.assertTrue(report["verified_against_cpu"])
                    self.assertEqual(subprocess.check_output([str(output)], text=True), expected)
                    if backend == "metal":
                        self.assertGreater(report["actual_gpu_functions"], 0)
                        self.assertGreater(report["gpu_execution_ms"], 0)
                    else:
                        self.assertEqual(report["gpu_pipeline_creations"], 0)

    @unittest.skipUnless(platform.system() == "Darwin", "Metal requires macOS")
    def test_worker_reuses_pipeline_and_recovers_from_bad_requests(self):
        with tempfile.TemporaryDirectory(dir=ROOT / ".build") as directory:
            directory = Path(directory)
            source = directory / "changing.rs"
            output = directory / "program"
            report_path = directory / "report.json"
            process = subprocess.Popen([str(BINARY), "--serve", "--backend", "metal", "--verify"],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
            def request(line):
                process.stdin.write(line + "\n"); process.stdin.flush()
                response = process.stdout.readline()
                self.assertTrue(response, "Worker ended without a response")
                return json.loads(response)
            try:
                source.write_text("fn main()->i64 { 18*22; return 7; }")
                first = request(f"compile\t{source}\t{output}\t{report_path}")
                self.assertEqual(first["status"], "ok")
                self.assertEqual(subprocess.check_output([str(output)], text=True), "7\n")
                self.assertFalse(first["gpu_pipeline_reused"])
                self.assertGreater(first["gpu_buffer_allocations"], 0)
                # Invalid source cannot poison the persistent compiler state.
                source.write_text("fn main(){let a=vec![1];}")
                invalid = request(f"compile\t{source}\t{output}\t{report_path}")
                self.assertEqual(invalid["status"], "error")
                self.assertEqual(request("wrong request")["status"], "error")
                source.write_text("fn main()->i64 { 18*22; return 19; }")
                second = request(f"compile\t{source}\t{output}\t{report_path}")
                self.assertEqual(second["status"], "ok")
                self.assertEqual(subprocess.check_output([str(output)], text=True), "19\n")
                self.assertEqual(first["process_id"], second["process_id"])
                self.assertEqual(second["gpu_pipeline_creations"], 1)
                self.assertEqual(second["gpu_submissions_total"], 2)
                self.assertTrue(second["gpu_pipeline_reused"])
                self.assertEqual(second["gpu_buffer_allocations"], 0)
                self.assertGreater(second["dead_scalar_instructions_removed"], 0)
                self.assertEqual(json.loads(report_path.read_text())["request_number"], second["request_number"])
                source.write_text("""fn bump(n:i64)->i64 {let mut y:i64=0;let mut i:i64=0;
                    while i<n {if i%2==0 {y=y+i;}else {y=y+2;}i=i+1;}return y;}
                    fn main()->i64 {return bump(6);}""")
                larger = request(f"compile\t{source}\t{output}\t{report_path}")
                self.assertEqual(larger["status"], "ok")
                self.assertEqual(subprocess.check_output([str(output)], text=True), "12\n")
                self.assertEqual(larger["gpu_pipeline_creations"], 1)
                self.assertTrue(larger["gpu_pipeline_reused"])
                self.assertGreater(larger["gpu_buffer_allocations"], 0)
                source.write_text("fn main()->i64 {return 19;}")
                smaller = request(f"compile\t{source}\t{output}\t{report_path}")
                self.assertEqual(smaller["status"], "ok")
                self.assertEqual(subprocess.check_output([str(output)], text=True), "19\n")
                self.assertEqual(smaller["gpu_buffer_allocations"], 0)
                self.assertEqual(smaller["gpu_submissions_total"], 4)
            finally:
                if process.poll() is None:
                    process.stdin.write("quit\n"); process.stdin.flush()
                process.communicate(timeout=20)
            self.assertEqual(process.returncode, 0)

    @unittest.skipUnless(platform.system() == "Darwin", "Metal requires macOS")
    def test_missing_shader_is_reported_without_gpu_fallback(self):
        process = subprocess.run([str(BINARY), str(ROOT / "fixtures/compiler_demo.rs"), "--backend", "metal",
                                  "--shader", str(ROOT / ".build/not-a-shader.metal"), "--output", str(ROOT / ".build/missing-shader-output")],
                                 capture_output=True, text=True)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("Could not read Metal shader", process.stderr)

    def test_unsupported_rust_is_rejected_without_emitting_ir(self):
        with tempfile.TemporaryDirectory(dir=ROOT / ".build") as directory:
            directory = Path(directory)
            source = directory / "unsupported.rs"
            source.write_text("fn main() { let v = vec![1, 2, 3]; }")
            output = directory / "output.ll"
            process = subprocess.run([str(BINARY), str(source), "--emit-llvm", str(output)],
                                     capture_output=True, text=True)
            self.assertNotEqual(process.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
