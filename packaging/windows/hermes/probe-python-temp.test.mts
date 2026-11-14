// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CommandResult } from "./probe-component-workload.mts";
import {
  COMPONENT_ADAPTER_SHA256,
  componentAdapterTargets,
  installComponentAdapter,
} from "./probe-official-python-adapter.mts";
import { tempControlPassed } from "./probe-python-temp-workload.mts";

const nonce = "0123456789abcdef01234567";
const moduleBytes = fs.readFileSync(
  fileURLToPath(new URL("./nemoclaw_native_windows.py", import.meta.url)),
);
const result = (changes: Partial<CommandResult>): CommandResult => ({
  executable: "owned-python.exe",
  args: [],
  exitCode: 1,
  signal: null,
  timedOut: false,
  outputExceeded: false,
  stdout: `TEMP_DIRECTORY_CREATED_${nonce}\n`,
  stderr: "PermissionError: [WinError 5] Access is denied",
  error: null,
  childClosed: true,
  elapsedMs: 1,
  ...changes,
});

test("the negative gate preserves the actual permission failure after directory creation", () => {
  assert.equal(tempControlPassed(result({}), "before", nonce), true);
  assert.equal(tempControlPassed(result({ exitCode: 0 }), "before", nonce), false);
});

test("an unrelated failure cannot substitute for the protected-temp negative control", () => {
  assert.equal(
    tempControlPassed(result({ stderr: "ModuleNotFoundError" }), "before", nonce),
    false,
  );
  assert.equal(tempControlPassed(result({ stdout: "" }), "before", nonce), false);
  assert.equal(tempControlPassed(result({ timedOut: true }), "before", nonce), false);
});

test("the adapted gate needs successful exact parent and child completion", () => {
  const success = result({ exitCode: 0, stderr: "", stdout: `TEMP_PARENT_CHILD_OK_${nonce}\n` });
  assert.equal(tempControlPassed(success, "after", nonce), true);
  assert.equal(tempControlPassed({ ...success, exitCode: 1 }, "after", nonce), false);
  assert.equal(tempControlPassed(success, "after", "different"), false);
});

test("component hook installation preserves the exact reviewed module and incomplete marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "python-adapter-layout-"));
  try {
    for (const directory of componentAdapterTargets(root))
      fs.mkdirSync(directory, { recursive: true });
    const records = installComponentAdapter(root, moduleBytes);
    assert.equal(records.length, 5);
    for (const directory of componentAdapterTargets(root)) {
      assert.equal(
        createHash("sha256")
          .update(fs.readFileSync(path.join(directory, "nemoclaw_native_windows.py")))
          .digest("hex"),
        COMPONENT_ADAPTER_SHA256,
      );
      assert.equal(
        fs.readFileSync(path.join(directory, "000_nemoclaw_native_windows.pth"), "utf8"),
        "import nemoclaw_native_windows; nemoclaw_native_windows.install()\n",
      );
    }
    const marker = JSON.parse(
      fs.readFileSync(path.join(root, "nemoclaw-windows-runtime.json"), "utf8"),
    );
    assert.equal(marker.classification, "component-startup-adapter-probe");
    assert.equal(marker.completeRuntime, false);
    assert.equal(marker.installedAcceptance, false);
    assert.throws(() => installComponentAdapter(root, moduleBytes), /unadapted/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a modified shim is rejected before writing any hook", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "python-adapter-hash-"));
  try {
    assert.throws(
      () => installComponentAdapter(root, Buffer.concat([moduleBytes, Buffer.from("\n")])),
      /frozen reviewed bytes/u,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a preexisting marker cannot be relabeled as an unadapted control", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "python-adapter-marker-"));
  try {
    fs.writeFileSync(path.join(root, "nemoclaw-windows-runtime.json"), '{"foreign":true}');
    assert.throws(() => installComponentAdapter(root, moduleBytes), /unadapted/u);
    assert.equal(
      fs.readFileSync(path.join(root, "nemoclaw-windows-runtime.json"), "utf8"),
      '{"foreign":true}',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
