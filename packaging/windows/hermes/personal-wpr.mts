// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileIdentity, errorDetail } from "./probe-component-workload.mts";
import { personalCommand } from "./probe-personal-workload.mts";

type Execution = Awaited<ReturnType<typeof personalCommand>>;
type Recorder = {
  directory: string;
  record: Record<string, any>;
  completion: Promise<void> | null;
};

function readReadyDocument(file: string): string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor);
    const named = fs.lstatSync(file);
    if (
      !opened.isFile() ||
      opened.size > 64 * 1024 ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw new Error("Recorder readiness is not an ordinary bounded file.");
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function startPersonalWpr(
  powershell: string,
  output: string,
  nonce: string,
  sourceRevision: string,
  policySha256: string,
  environment: NodeJS.ProcessEnv,
  command: typeof personalCommand = personalCommand,
): Promise<Recorder> {
  const directory = path.join(path.dirname(output), "primary-wpr");
  const state: Recorder = {
    directory,
    completion: null,
    record: {
      classification: "ordinary-Personal-primary-WPR",
      nonce,
      sourceRevision,
      partialPrefixOnly: true,
      coverageIncomplete: true,
      completeOperationTraceClaimed: false,
      debuggerAttached: false,
      measuredCommandLaunchedByRecorder: false,
      measuredPolicySha256: policySha256,
      maximumRecordingSeconds: 45,
      maximumObservedRecordingBytes: 256 * 1024 * 1024,
      recorderReadyTimeoutMs: 30_000,
      recorderOwnerTimeoutMs: 360_000,
      recorderDeadlinePurpose:
        "Recorder startup/finalization ownership only; the measured application keeps its120s deadline.",
      attempted: false,
      ready: null,
      execution: null,
      error: null,
    },
  };
  try {
    assert.match(nonce, /^[a-f0-9]{24}$/u);
    assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
    assert.match(policySha256, /^[a-f0-9]{64}$/u);
    fs.mkdirSync(directory);
    const request = path.join(directory, "request.json");
    fs.writeFileSync(
      request,
      JSON.stringify(
        {
          schemaVersion: 1,
          classification: "personal-primary-wpr-request",
          nonce,
          sourceRevision,
          policySha256,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    state.record.request = fileIdentity(request);
    state.record.powershell = fileIdentity(powershell);
    const sidecar = fileURLToPath(
      new URL("../performance/record-personal-wpr.ps1", import.meta.url),
    );
    state.record.sources = [
      sidecar,
      ...["wpr-trace.ps1", "measurement-tracing.ps1", "native-output-capture.ps1"].map((name) =>
        path.join(path.dirname(sidecar), name),
      ),
    ].map(fileIdentity);
    state.record.attempted = true;
    state.completion = command(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", sidecar, "-RequestFile", request],
      { ...environment, GITHUB_SHA: sourceRevision },
      output,
      360_000,
    ).then(
      (execution) => {
        state.record.execution = execution;
      },
      (error) => {
        state.record.error = errorDetail(error);
      },
    );
    const ready = path.join(directory, "ready.json"),
      until = performance.now() + 30_000;
    let readyDocument: string | null = null;
    while (
      readyDocument === null &&
      state.record.execution === null &&
      state.record.error === null &&
      performance.now() < until
    ) {
      readyDocument = readReadyDocument(ready);
      if (readyDocument !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (readyDocument === null)
      throw new Error(
        "Recorder readiness was not observed; primary retains its original deadline.",
      );
    state.record.ready = JSON.parse(readyDocument);
    assert.equal(state.record.ready.nonce, nonce);
    assert.equal(state.record.ready.sourceRevision, sourceRevision);
    if (state.record.ready.started !== true)
      state.record.error = {
        message: "WPR did not establish a recording; see owned recorder receipt.",
      };
  } catch (error) {
    state.record.error = errorDetail(error);
  }
  state.record.captureStartConfirmedBeforePrimary = state.record.ready?.started === true;
  return state;
}

export function requestPersonalWprStop(state: Recorder, primary?: Execution) {
  if (!state.record.attempted) return;
  try {
    const destination = path.join(state.directory, "stop.json");
    if (!fs.existsSync(destination)) {
      fs.writeFileSync(
        destination + ".tmp",
        JSON.stringify({
          sourceRevision: state.record.sourceRevision,
          nonce: state.record.nonce,
          primaryPid: primary?.pid ?? null,
          primaryChildClosed: primary?.childClosed ?? null,
          requestedAtUtc: new Date().toISOString(),
        }) + "\n",
        { flag: "wx" },
      );
      fs.renameSync(destination + ".tmp", destination);
    }
  } catch (error) {
    state.record.stopRequestError = errorDetail(error);
  }
}

export function validatePersonalWprCompletion(record: any, owner: any) {
  assert.equal(owner.schemaVersion, 1);
  assert.equal(owner.classification, "personal-primary-wpr-owner");
  assert.equal(owner.sourceRevision, record.sourceRevision);
  assert.equal(owner.nonce, record.nonce);
  assert.equal(owner.requestSha256, record.request.sha256);
  assert.equal(owner.measuredPolicySha256, record.measuredPolicySha256);
  assert.equal(owner.primaryLaunchedByRecorder, false);
  assert.equal(owner.debuggerAttached, false);
  assert.equal(owner.partialPrefixOnly, true);
  assert.equal(owner.maximumRecordingSeconds, 45);
  assert.equal(owner.maximumObservedRecordingBytes, 256 * 1024 * 1024);
  assert.equal(typeof owner.recordingAttempted, "boolean");
  if (owner.recordingAttempted === false) {
    assert.equal(owner.trace, null);
    assert.equal(owner.recordingStopped, true);
    assert(typeof owner.error === "string" && owner.error.length > 0);
  } else if (owner.recordingStopped === true) {
    assert.equal(owner.trace?.safeToContinue, true);
  }
  return record.execution?.childClosed === true && owner.recordingStopped === true;
}

export async function finishPersonalWpr(state: Recorder) {
  requestPersonalWprStop(state);
  if (state.completion) await state.completion;
  const record = state.record;
  record.ownerClosed = !record.attempted || record.execution?.childClosed === true;
  record.recordingStopped = !record.attempted;
  try {
    if (record.attempted) {
      const file = path.join(state.directory, "owner-result.json");
      const identity = fileIdentity(file);
      assert(identity.bytes <= 2 * 1024 * 1024);
      record.ownerReceipt = { ...identity, value: JSON.parse(fs.readFileSync(file, "utf8")) };
      record.recordingStopped = validatePersonalWprCompletion(record, record.ownerReceipt.value);
    }
  } catch (error) {
    record.receiptError = errorDetail(error);
  }
  // A recorder problem never throws across the original application's result.
  return record;
}
