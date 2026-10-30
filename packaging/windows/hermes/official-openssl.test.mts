// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const source = fileURLToPath(new URL("./prepare-official-openssl.py", import.meta.url));
const python = process.env.NEMOCLAW_TEST_PYTHON ?? "python3";
const invoke = String.raw`
import importlib.util,json,sys,pathlib,os,zipfile
spec=importlib.util.spec_from_file_location('sdk',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);mode=sys.argv[3]
try:
 if mode=='library':result=m.verify_static_arm64_library(root/'input.lib')
 elif mode=='archive':
  with zipfile.ZipFile(root/'input.zip','w') as z:
   z.writestr('LICENSE.txt','official-license');z.writestr('include/openssl/header.h','complete-header');z.writestr('tool/dynamic.dat',b'opaque')
  m.extract(root/'input.zip',root/'extracted');result=sorted(p.relative_to(root/'extracted').as_posix() for p in (root/'extracted').rglob('*') if p.is_file())
 elif mode=='escape':
  with zipfile.ZipFile(root/'input.zip','w') as z:z.writestr('../outside','bad')
  m.extract(root/'input.zip',root/'extracted');result=None
 elif mode in ('success','failure','timeout'):
  code={'success':"print('child-output')",'failure':"import sys;print('primary-error',file=sys.stderr);sys.exit(37)",'timeout':"import time;time.sleep(60)"}[mode]
  result=m.run(sys.executable,['-c',code],root,os.environ.copy(),root,mode,0.1 if mode=='timeout' else 3)
 elif mode=='receipt-failure':
  def denied(*args):raise OSError('secondary-receipt-denied')
  m.write_json=denied
  result=m.run(sys.executable,['-c','import sys;sys.exit(37)'],root,os.environ.copy(),root,mode,3)
 print(json.dumps({'ok':True,'result':result}))
except BaseException as error:print(json.dumps({'ok':False,'error':str(error),'type':type(error).__name__,'notes':getattr(error,'__notes__',[])}))
`;
function run(mode: string, root: string) {
  const child = spawnSync(python, ["-I", "-c", invoke, source, root, mode], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  return JSON.parse(lines.at(-1)!);
}
function temporary(fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openssl-sdk-control-"));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function member(data: Buffer) {
  const header = Buffer.from(
    "object.obj/".padEnd(16) +
      "0".padEnd(12) +
      "0".padEnd(6) +
      "0".padEnd(6) +
      "100644".padEnd(8) +
      String(data.length).padEnd(10) +
      "`\n",
  );
  return Buffer.concat([
    Buffer.from("!<arch>\n"),
    header,
    data,
    ...(data.length % 2 ? [Buffer.from("\n")] : []),
  ]);
}
for (const row of [
  { name: "ordinary ARM64 object", machine: 0xaa64, big: false, version: 0, pass: true },
  { name: "ARM64 bigobj", machine: 0xaa64, big: true, version: 2, pass: true },
  { name: "foreign x64 object", machine: 0x8664, big: false, version: 0, pass: false },
  { name: "dynamic import object", machine: 0xaa64, big: true, version: 0, pass: false },
])
  test(`static SDK admission: ${row.name}`, () =>
    temporary((root) => {
      const object = Buffer.alloc(32);
      object.writeUInt16LE(row.machine, 0);
      if (row.big) {
        object.writeUInt16LE(0, 0);
        object.writeUInt16LE(0xffff, 2);
        object.writeUInt16LE(row.version, 4);
        object.writeUInt16LE(row.machine, 6);
      }
      fs.writeFileSync(path.join(root, "input.lib"), member(object));
      const result = run("library", root);
      assert.equal(result.ok, row.pass);
      if (row.pass) assert.equal(result.result.arm64Objects, 1);
    }));
test("a truncated COFF archive cannot become an SDK receipt", () =>
  temporary((root) => {
    fs.writeFileSync(path.join(root, "input.lib"), member(Buffer.alloc(32)).subarray(0, -1));
    assert.equal(run("library", root).ok, false);
  }));
test("complete build input extraction keeps headers, licenses and dynamic data", () =>
  temporary((root) => {
    assert.deepEqual(run("archive", root).result, [
      "LICENSE.txt",
      "include/openssl/header.h",
      "tool/dynamic.dat",
    ]);
  }));
test("build archive parent traversal is rejected", () =>
  temporary((root) => {
    assert.match(run("escape", root).error, /escapes/u);
    assert.equal(fs.existsSync(path.join(root, "outside")), false);
  }));
for (const mode of ["success", "failure", "timeout"] as const)
  test(`owned real ${mode} child retains its outcome`, () =>
    temporary((root) => {
      const result = run(mode, root);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, mode + ".process.json"), "utf8"));
      assert.equal(result.ok, mode === "success");
      assert.equal(receipt.passed, mode === "success");
      assert.notEqual(receipt.exitCode, null);
      if (mode === "success")
        assert.equal(
          fs.readFileSync(path.join(root, "success.stdout.log"), "utf8").trim(),
          "child-output",
        );
      if (mode === "failure") {
        assert.equal(receipt.exitCode, 37);
        assert.match(
          fs.readFileSync(path.join(root, "failure.stderr.log"), "utf8"),
          /primary-error/u,
        );
      }
      if (mode === "timeout") {
        assert.equal(result.type, "TimeoutError");
        assert(receipt.elapsedSeconds < 5);
      }
    }));
test("receipt failure preserves the original native child exit", () =>
  temporary((root) => {
    const result = run("receipt-failure", root);
    assert.equal(result.ok, false);
    assert.match(result.error, /exited 37/u);
    assert.match(result.notes.join(" "), /secondary-receipt-denied/u);
  }));
