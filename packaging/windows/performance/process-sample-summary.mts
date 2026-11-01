// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
export type ProcessSample = {
  measurement: {
    processId: number;
    creationFileTime: string;
    executable: string;
    capturedMs: number;
    cpuMs: number;
    readOperations: string;
    writeOperations: string;
    readTransferBytes: string;
    writeTransferBytes: string;
    otherOperations: string;
    fileGrowth: { incomplete: boolean; observedFootprintBytes: number } | null;
  };
  observerCaptureMs: number;
  observerCpuMs: number;
  observerProcessId: number;
};

export function summarizeProcessSamples(samples: ProcessSample[], logicalProcessors: number) {
  if (
    samples.length < 2 ||
    samples.length > 4096 ||
    !Number.isSafeInteger(logicalProcessors) ||
    logicalProcessors < 1
  )
    throw new Error("At least two bounded samples and a recorded processor count are required.");
  const first = samples[0],
    last = samples.at(-1)!;
  let previous = first;
  for (const sample of samples) {
    const value = sample.measurement,
      prior = previous.measurement;
    if (
      value.processId !== first.measurement.processId ||
      value.creationFileTime !== first.measurement.creationFileTime ||
      value.executable.toLowerCase() !== first.measurement.executable.toLowerCase() ||
      sample.observerProcessId !== first.observerProcessId
    )
      throw new Error("Process sample creation identity changed.");
    if (
      !Number.isFinite(value.capturedMs) ||
      !Number.isFinite(value.cpuMs) ||
      value.capturedMs < prior.capturedMs ||
      value.cpuMs < prior.cpuMs ||
      !Number.isFinite(sample.observerCaptureMs) ||
      sample.observerCaptureMs < 0 ||
      !Number.isFinite(sample.observerCpuMs) ||
      sample.observerCpuMs < previous.observerCpuMs
    )
      throw new Error("Process counters are not finite monotonic samples.");
    previous = sample;
  }
  const elapsedMs = last.measurement.capturedMs - first.measurement.capturedMs;
  if (elapsedMs <= 0) throw new Error("The sampled interval is empty.");
  const delta = (
    field:
      | "readOperations"
      | "writeOperations"
      | "readTransferBytes"
      | "writeTransferBytes"
      | "otherOperations",
  ) => {
    let previousValue = -1n;
    for (const sample of samples) {
      const raw = sample.measurement[field];
      if (!/^[0-9]{1,20}$/u.test(raw)) throw new Error("An I/O counter is invalid.");
      const value = BigInt(raw);
      if (value < previousValue) throw new Error("An I/O counter moved backwards.");
      previousValue = value;
    }
    return (BigInt(last.measurement[field]) - BigInt(first.measurement[field])).toString();
  };
  const cpuMs = last.measurement.cpuMs - first.measurement.cpuMs;
  return {
    schemaVersion: 1,
    processId: first.measurement.processId,
    creationFileTime: first.measurement.creationFileTime,
    executable: first.measurement.executable,
    sampledIntervalMs: elapsedMs,
    sampleCount: samples.length,
    cpuMs,
    cpuPercentOfOneLogicalProcessor: (100 * cpuMs) / elapsedMs,
    cpuPercentOfMachineCapacity: (100 * cpuMs) / elapsedMs / logicalProcessors,
    readOperations: delta("readOperations"),
    writeOperations: delta("writeOperations"),
    readTransferBytes: delta("readTransferBytes"),
    writeTransferBytes: delta("writeTransferBytes"),
    otherOperations: delta("otherOperations"),
    ioScope: "general process I/O; file-only attribution requires ETW",
    processScope: "exact held root process, not automatically descendants",
    observerCpuMs: last.observerCpuMs - first.observerCpuMs,
    summedObserverCaptureMs: samples.reduce((sum, row) => sum + row.observerCaptureMs, 0),
    fileGrowthIncomplete: samples.some((row) => row.measurement.fileGrowth?.incomplete === true),
    runtimeBytesCopied: null,
    intervalIsIdle:
      "only if the reviewed scenario driver held an actual idle session for this interval",
  };
}
