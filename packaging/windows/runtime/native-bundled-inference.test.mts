// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readBundledNativeEngine } from "./native-bundled-inference.mts";
import { NATIVE_LOCAL_ENGINE } from "./native-local-models.mts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-engine-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managed = path.join(root, "inference", "managed");
  fs.mkdirSync(path.join(managed, "bin"), { recursive: true });
  const files = [
    "llama-server.exe",
    "llama-server-impl.dll",
    "llama.dll",
    "ggml-cuda.dll",
    "cudart64_13.dll",
  ].map((name) => {
    fs.writeFileSync(path.join(managed, "bin", name), "not-executed");
    return { path: `bin/${name}`, bytes: 12, sha256: "a".repeat(64) };
  });
  const receipt = {
    schemaVersion: 1,
    classification: "candidate-native-inference-runtime",
    modelsBundled: false,
    engine: { ...NATIVE_LOCAL_ENGINE },
    files,
  };
  const save = () => fs.writeFileSync(path.join(managed, "runtime.json"), JSON.stringify(receipt));
  save();
  let assertions = 0;
  const lease = {
    runtimeRoot: root,
    runtimeId: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    sourceRevision: "d".repeat(40),
    assertHeld() {
      assertions++;
    },
  };
  return { managed, receipt, save, lease, assertions: () => assertions };
}

test("bundled engine metadata binds only the held sealed package without executing it", (t) => {
  const f = fixture(t);
  const result = readBundledNativeEngine(f.lease);
  assert.equal(result.executable, path.join(f.managed, "bin", "llama-server.exe"));
  assert.match(result.packSha256, /^[a-f0-9]{64}$/u);
  assert.equal(f.assertions(), 2);
});

test("a changed source bundle is rejected before executable use", (t) => {
  const f = fixture(t);
  f.receipt.engine.bundleSha256 = "f".repeat(64);
  f.save();
  assert.throws(() => readBundledNativeEngine(f.lease), /differs from its catalog/u);
});

test("missing, redirected and duplicate engine inventory paths are rejected", (t) => {
  const f = fixture(t);
  const original = f.receipt.files[0].path;
  for (const wrong of ["../foreign.exe", f.receipt.files[1].path, "bin/missing.exe"]) {
    f.receipt.files[0].path = wrong;
    f.save();
    assert.throws(() => readBundledNativeEngine(f.lease));
  }
  f.receipt.files[0].path = original;
  f.receipt.files.pop();
  f.save();
  assert.throws(() => readBundledNativeEngine(f.lease), /incomplete/u);
});

test("file size changes and hard links cannot satisfy sealed engine metadata", (t) => {
  const f = fixture(t);
  const executable = path.join(f.managed, f.receipt.files[0].path);
  fs.appendFileSync(executable, "changed");
  assert.throws(() => readBundledNativeEngine(f.lease), /sealed identity/u);
  fs.writeFileSync(executable, "not-executed");
  fs.linkSync(executable, path.join(f.managed, "second-name.exe"));
  assert.throws(() => readBundledNativeEngine(f.lease), /sealed identity/u);
});

test("lost runtime authority is propagated without hiding the failure", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      readBundledNativeEngine({
        ...f.lease,
        assertHeld() {
          throw new Error("lease lost");
        },
      }),
    /lease lost/u,
  );
});
