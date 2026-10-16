// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readNativeExecutionLog } from "./bash-compat.mts";

function fixture(run: (file: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-log-control-"));
  try {
    const file = path.join(root, "native.log");
    fs.writeFileSync(file, "held native evidence");
    run(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("native execution evidence reads ordinary bytes through one closed descriptor", () => {
  fixture((file) => assert.equal(readNativeExecutionLog(file).toString(), "held native evidence"));
});

test("native execution evidence rejects absent, empty, oversized and directory inputs", () => {
  fixture((file) => {
    assert.throws(() => readNativeExecutionLog(file + ".absent"), { code: "ENOENT" });
    fs.writeFileSync(file, "");
    assert.throws(() => readNativeExecutionLog(file), /byte bounds/u);
    fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.throws(() => readNativeExecutionLog(file), /byte bounds/u);
    assert.throws(() => readNativeExecutionLog(path.dirname(file)));
  });
});

test("native execution evidence rejects an identity replacement before reading and closes", (t) => {
  fixture((file) => {
    const lstat = fs.lstatSync;
    const read = t.mock.method(fs, "readSync");
    const close = t.mock.method(fs, "closeSync");
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      if (args[0] === file) {
        fs.renameSync(file, file + ".held");
        fs.writeFileSync(file, "replacement");
      }
      return Reflect.apply(lstat, fs, args);
    });
    assert.throws(() => readNativeExecutionLog(file), /ordinary held file/u);
    assert.equal(read.mock.callCount(), 0);
    assert.equal(close.mock.callCount(), 1);
    t.mock.restoreAll();
  });
});

test("native execution evidence retains the opened identity after name substitution", (t) => {
  fixture((file) => {
    const lstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      const observed = Reflect.apply(lstat, fs, args);
      if (args[0] === file) {
        fs.renameSync(file, file + ".held");
        fs.writeFileSync(file, "replacement");
      }
      return observed;
    });
    assert.equal(readNativeExecutionLog(file).toString(), "held native evidence");
    t.mock.restoreAll();
  });
});

test("native execution evidence bounds growth after fstat and closes on read failure", (t) => {
  fixture((file) => {
    const lstat = fs.lstatSync;
    const close = t.mock.method(fs, "closeSync");
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      const observed = Reflect.apply(lstat, fs, args);
      if (args[0] === file) fs.appendFileSync(file, Buffer.alloc(4 * 1024 * 1024));
      return observed;
    });
    assert.throws(() => readNativeExecutionLog(file), /byte bounds/u);
    // appendFileSync also closes its own handle.
    assert.equal(close.mock.callCount(), 2);
    t.mock.restoreAll();
    fs.writeFileSync(file, "native evidence");
    const failedClose = t.mock.method(fs, "closeSync");
    t.mock.method(fs, "readSync", () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    assert.throws(() => readNativeExecutionLog(file), { code: "EACCES" });
    assert.equal(failedClose.mock.callCount(), 1);
    t.mock.restoreAll();
  });
});
