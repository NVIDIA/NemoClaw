// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NATIVE_EXPRESS } from "./native-inference-manifest.mts";
import { readPrebuiltNativeModel } from "./native-prebuilt-inference.mts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prebuilt-model-metadata-"));
  const packRoot = path.join(root, "inference", NATIVE_EXPRESS.id);
  fs.mkdirSync(path.join(packRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packRoot, "model"));
  const executable = path.join(packRoot, "bin", "llama-server.exe");
  const weights = path.join(packRoot, "model", NATIVE_EXPRESS.weights.name);
  fs.writeFileSync(executable, "not-executed");
  fs.writeFileSync(weights, "metadata-fixture", { flag: "wx" });
  const weightsIdentity = fs.statSync(weights);
  const originalStat = fs.fstatSync;
  // Model contents/authority are not qualified by this unit test. Simulate only
  // its reported size instead of allocating a20GB file on Windows test runners.
  t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    const info = Reflect.apply(originalStat, fs, args);
    return Object.assign(info, {
      size:
        info.ino === weightsIdentity.ino &&
        info.dev === weightsIdentity.dev &&
        info.size === weightsIdentity.size
          ? NATIVE_EXPRESS.weights.bytes
          : info.size,
    });
  });
  const descriptor = {
    schemaVersion: 1,
    classification: "prebuilt-native-model-pack",
    id: NATIVE_EXPRESS.id,
    model: NATIVE_EXPRESS.model,
    modelRevision: NATIVE_EXPRESS.modelRevision,
    runtimeArchiveSha256: NATIVE_EXPRESS.runtime.sha256,
    cudaArchiveSha256: NATIVE_EXPRESS.cuda.sha256,
    server: { file: "bin/llama-server.exe", bytes: 12, sha256: "a".repeat(64) },
    weights: {
      file: "model/" + NATIVE_EXPRESS.weights.name,
      bytes: NATIVE_EXPRESS.weights.bytes,
      sha256: NATIVE_EXPRESS.weights.sha256,
    },
  };
  const save = () => fs.writeFileSync(path.join(packRoot, "pack.json"), JSON.stringify(descriptor));
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
  return {
    root,
    executable,
    weights,
    descriptor,
    save,
    lease,
    assertions: () => assertions,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("held-seal metadata reads do not read the20GB model or execute the server", (t) => {
  const f = fixture(t);
  t.after(f.close);
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    assert.notEqual(args[0], f.weights);
    assert.notEqual(args[0], f.executable);
    return Reflect.apply(original, fs, args);
  });
  const result = readPrebuiltNativeModel(f.lease);
  assert.equal(result.metadata.modelBytesRead, 0);
  assert.equal(result.modelPath, f.weights);
  assert.equal(result.metadata.weightsBytes, NATIVE_EXPRESS.weights.bytes);
  assert.equal(f.assertions(), 2);
});

test("a redirected pack path cannot replace the exact executable location", (t) => {
  const f = fixture(t);
  t.after(f.close);
  f.descriptor.server.file = "../../foreign.exe";
  f.save();
  assert.throws(() => readPrebuiltNativeModel(f.lease), /catalog identities/u);
});

test("changed model size or catalog identity prevents a prebuilt availability result", (t) => {
  const f = fixture(t);
  t.after(f.close);
  fs.truncateSync(f.weights, 1);
  assert.throws(() => readPrebuiltNativeModel(f.lease), /installed identity/u);
  f.descriptor.weights.sha256 = "e".repeat(64);
  f.save();
  assert.throws(() => readPrebuiltNativeModel(f.lease), /catalog identities/u);
});

test("a lost package authority is preserved as the primary failure", (t) => {
  const f = fixture(t);
  t.after(f.close);
  const primary = new Error("owned lease stopped");
  assert.throws(
    () =>
      readPrebuiltNativeModel({
        ...f.lease,
        assertHeld() {
          throw primary;
        },
      }),
    (error) => error === primary,
  );
});
