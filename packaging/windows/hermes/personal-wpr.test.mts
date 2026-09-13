// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { personalCommand } from "./probe-personal-workload.mts";
import {
  startPersonalWpr,
  requestPersonalWprStop,
  finishPersonalWpr,
  validatePersonalWprCompletion,
} from "./personal-wpr.mts";

// Actual owned Node child and control files; recorder outcomes are fixture data.
const fixture = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const file=process.argv[1],failed=process.argv[2]==='failed',raw=fs.readFileSync(file),r=JSON.parse(raw),dir=path.dirname(file);
if(process.env.GITHUB_SHA!==r.sourceRevision)throw Error('recorder environment lacks exact source');
const write=(name,value)=>{fs.writeFileSync(path.join(dir,name+'.tmp'),JSON.stringify(value));fs.renameSync(path.join(dir,name+'.tmp'),path.join(dir,name));};
write('ready.json',{nonce:r.nonce,sourceRevision:r.sourceRevision,started:!failed});
const timer=setInterval(()=>{
 if(!fs.existsSync(path.join(dir,'stop.json')))return;
 clearInterval(timer);
 write('owner-result.json',{schemaVersion:1,classification:'personal-primary-wpr-owner',fixtureOnly:true,
 sourceRevision:r.sourceRevision,nonce:r.nonce,requestSha256:crypto.createHash('sha256').update(raw).digest('hex'),measuredPolicySha256:r.policySha256,
 primaryLaunchedByRecorder:false,debuggerAttached:false,partialPrefixOnly:true,maximumRecordingSeconds:45,maximumObservedRecordingBytes:268435456,
 recordingAttempted:!failed,trace:failed?null:{safeToContinue:true},recordingStopped:true,error:failed?'controlled recorder start failure':null});
 process.exitCode=failed?23:0;
},10);
`;

test("sibling recorder never launches the primary; stop and closure are independent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-wpr-"));
  try {
    const output = path.join(root, "personal-mxc");
    fs.mkdirSync(output);
    const originalEnvironment = { ...process.env, GITHUB_SHA: "not-the-run-source" };
    let calls = 0;
    const command: typeof personalCommand = (exe, args, environment, cwd, timeout) => {
      calls++;
      assert.equal(exe, process.execPath);
      assert.equal(args[5], "-RequestFile");
      assert.equal(timeout, 360_000);
      assert.equal(environment?.GITHUB_SHA, "b".repeat(40));
      assert.equal(originalEnvironment.GITHUB_SHA, "not-the-run-source");
      return personalCommand(process.execPath, ["-e", fixture, args[6]!], environment, cwd, 5000);
    };
    const recorder = await startPersonalWpr(
      process.execPath,
      output,
      "a".repeat(24),
      "b".repeat(40),
      "c".repeat(64),
      originalEnvironment,
      command,
    );
    assert.equal(recorder.record.captureStartConfirmedBeforePrimary, true);
    const primary = await personalCommand(
      process.execPath,
      ["-e", "process.stdout.write(String(process.ppid))"],
      process.env,
      output,
      1000,
    );
    assert.equal(primary.stdout, String(process.pid));
    assert.equal(primary.exitCode, 0);
    requestPersonalWprStop(recorder, primary);
    const result = await finishPersonalWpr(recorder);
    assert.equal(calls, 1);
    assert.equal(result.ownerClosed, true);
    assert.equal(result.recordingStopped, true);
    assert.equal(result.measuredCommandLaunchedByRecorder, false);
    assert.equal(result.coverageIncomplete, true);
    const stop = JSON.parse(fs.readFileSync(path.join(root, "primary-wpr/stop.json"), "utf8"));
    assert.equal(stop.primaryPid, primary.pid);
    assert.equal(stop.primaryChildClosed, true);
    for (const key of ["nonce", "requestSha256", "measuredPolicySha256"]) {
      const invalid = { ...result.ownerReceipt.value, [key]: "wrong" };
      assert.throws(() => validatePersonalWprCompletion(result, invalid));
    }
    assert.equal(
      validatePersonalWprCompletion(
        { ...result, execution: { childClosed: false } },
        result.ownerReceipt.value,
      ),
      false,
    );
    assert.equal(
      validatePersonalWprCompletion(result, {
        ...result.ownerReceipt.value,
        recordingStopped: false,
      }),
      false,
    );
    assert.throws(() =>
      validatePersonalWprCompletion(result, {
        ...result.ownerReceipt.value,
        recordingAttempted: true,
        trace: null,
      }),
    );
    assert.throws(() =>
      validatePersonalWprCompletion(result, {
        ...result.ownerReceipt.value,
        recordingAttempted: false,
        trace: { safeToContinue: true },
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recorder failure stays secondary to an actual primary exception", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-wpr-failed-"));
  try {
    const output = path.join(root, "personal-mxc");
    fs.mkdirSync(output);
    const command: typeof personalCommand = (_exe, args, env, cwd) =>
      personalCommand(process.execPath, ["-e", fixture, args[6]!, "failed"], env, cwd, 5000);
    const recorder = await startPersonalWpr(
      process.execPath,
      output,
      "d".repeat(24),
      "e".repeat(40),
      "f".repeat(64),
      process.env,
      command,
    );
    const original = new Error("actual primary failure");
    let retained: unknown, trace: any;
    try {
      throw original;
    } catch (error) {
      retained = error;
    } finally {
      trace = await finishPersonalWpr(recorder);
    }
    assert.equal(retained, original);
    assert.equal(trace.ownerClosed, true);
    assert.equal(trace.recordingStopped, true);
    assert.equal(trace.execution.exitCode, 23);
    assert.equal(trace.captureStartConfirmedBeforePrimary, false);
    assert.equal(trace.coverageIncomplete, true);
    assert(trace.error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
