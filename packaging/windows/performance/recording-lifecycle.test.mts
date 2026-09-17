// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  measuredCommand,
  createCommandOutputRecorder,
  assertMeasurementDeadline,
  installedOpenClawReplayDeadline,
} from "./measurement.mts";

for (const mode of ["success", "failure", "timeout"] as const) {
  test(`real ${mode} child output is durable before its receipt and retains the actual outcome`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-output-"));
    const output = createCommandOutputRecorder(root);
    try {
      const pending = measuredCommand({
        executable: process.execPath,
        args: [
          "-e",
          `process.stdout.write('early-out');process.stderr.write('early-err');setTimeout(()=>process.exit(${mode === "failure" ? 37 : 0}),${mode === "timeout" ? 5000 : 500});`,
        ],
        environment: process.env,
        cwd: root,
        timeoutMs: mode === "timeout" ? 250 : 3000,
        onOutput: output.write,
      });
      await delay(150);
      assert.equal(fs.readFileSync(path.join(root, "command-stdout.log"), "utf8"), "early-out");
      assert.equal(fs.readFileSync(path.join(root, "command-stderr.log"), "utf8"), "early-err");
      const result = await pending;
      assert.equal(result.stdout, "early-out");
      assert.equal(result.stderr, "early-err");
      assert.equal(result.timedOut, mode === "timeout");
      assert.equal(result.rootTerminationConfirmed, true);
      if (mode !== "timeout") assert.equal(result.exitCode, mode === "failure" ? 37 : 0);
    } finally {
      output.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
test("output retention is capped while a real verbose child can finish", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-output-cap-"));
  const output = createCommandOutputRecorder(root);
  try {
    const result = await measuredCommand({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2*1024*1024));process.stderr.write('done');"],
      environment: process.env,
      cwd: root,
      timeoutMs: 3000,
      onOutput: output.write,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputExceeded, true);
    assert.equal(
      fs.statSync(path.join(root, "command-stdout.log")).size +
        fs.statSync(path.join(root, "command-stderr.log")).size,
      1024 * 1024,
    );
  } finally {
    output.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("an output save failure is retained without killing the measured command", async () => {
  const result = await measuredCommand({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('out');setTimeout(()=>process.exit(37),200)"],
    environment: process.env,
    cwd: os.tmpdir(),
    timeoutMs: 3000,
    onOutput: () => {
      throw new Error("controlled-output-failure");
    },
  });
  assert.equal(result.exitCode, 37);
  assert.equal(result.timedOut, false);
  assert.equal(result.observerError, "controlled-output-failure");
});
test("the extended observer allowance is restricted and never changes a product deadline", () => {
  assert.throws(() => assertMeasurementDeadline(900001), /outside its bound/u);
  assert.throws(() => assertMeasurementDeadline(1350000, "unknown"), /outside its bound/u);
  assert.doesNotThrow(() =>
    assertMeasurementDeadline(
      installedOpenClawReplayDeadline.applicationMs,
      installedOpenClawReplayDeadline.contract,
    ),
  );
  assert.throws(
    () => assertMeasurementDeadline(1350001, installedOpenClawReplayDeadline.contract),
    /outside its bound/u,
  );
  assert.equal(
    installedOpenClawReplayDeadline.applicationMs,
    installedOpenClawReplayDeadline.existingControllerMs +
      installedOpenClawReplayDeadline.diagnosticIdleMs +
      installedOpenClawReplayDeadline.cleanupAndHarvestMs,
  );
});
