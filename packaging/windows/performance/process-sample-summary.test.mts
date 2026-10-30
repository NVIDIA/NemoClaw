// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeProcessSamples, type ProcessSample } from "./process-sample-summary.mts";
const first: ProcessSample = {
  measurement: {
    processId: 12,
    creationFileTime: "12345678",
    executable: "C:\\app\\node.exe",
    capturedMs: 100,
    cpuMs: 50,
    readOperations: "9007199254740993",
    writeOperations: "10",
    readTransferBytes: "100",
    writeTransferBytes: "200",
    otherOperations: "3",
    fileGrowth: null,
  },
  observerCaptureMs: 2,
  observerCpuMs: 4,
  observerProcessId: 20,
};
const last: ProcessSample = {
  ...first,
  measurement: {
    ...first.measurement,
    capturedMs: 1100,
    cpuMs: 1050,
    readOperations: "9007199254740998",
    writeTransferBytes: "400",
    fileGrowth: { incomplete: true, observedFootprintBytes: 500 },
  },
  observerCpuMs: 6,
};
test("computes exact held-process CPU/general-I/O deltas without a copy-byte claim", () => {
  const result = summarizeProcessSamples([first, last], 8);
  assert.equal(result.sampledIntervalMs, 1000);
  assert.equal(result.cpuPercentOfOneLogicalProcessor, 100);
  assert.equal(result.cpuPercentOfMachineCapacity, 12.5);
  assert.equal(result.readOperations, "5");
  assert.equal(result.writeTransferBytes, "200");
  assert.equal(result.observerCpuMs, 2);
  assert.equal(result.summedObserverCaptureMs, 4);
  assert.equal(result.fileGrowthIncomplete, true);
  assert.equal(result.runtimeBytesCopied, null);
});
test("rejects reused PIDs with different creation identity", () => {
  assert.throws(
    () =>
      summarizeProcessSamples(
        [first, { ...last, measurement: { ...last.measurement, creationFileTime: "987" } }],
        8,
      ),
    /identity/u,
  );
});
test("rejects counter reset rather than reporting negative throughput", () => {
  assert.throws(
    () =>
      summarizeProcessSamples(
        [first, { ...last, measurement: { ...last.measurement, readOperations: "1" } }],
        8,
      ),
    /backwards/u,
  );
});
