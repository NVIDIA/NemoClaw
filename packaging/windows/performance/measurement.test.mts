// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { probeSandboxName } from "./probe-installed-readonly.mts";
import {
  identity,
  inventory,
  measuredCommand,
  OutputTimeline,
  startupSpans,
  publishFixtureRecord,
  readFixtureRecord,
} from "./measurement.mts";

const child = (source: string, extra: Partial<Parameters<typeof measuredCommand>[0]> = {}) =>
  measuredCommand({
    executable: process.execPath,
    args: ["-e", source],
    environment: process.env,
    cwd: process.cwd(),
    timeoutMs: 3000,
    ...extra,
  });

test("retains literal split UTF8 output and separate first byte clocks", () => {
  const output = new OutputTimeline();
  const bytes = Buffer.from("α config-start\r\n");
  output.write("stdout", bytes.subarray(0, 1), 5);
  output.write("stderr", Buffer.from("notice\n"), 6);
  output.write("stdout", bytes.subarray(1), 9);
  output.finish(10);
  assert.deepEqual(output.firstByteMs, { stdout: 5, stderr: 6 });
  assert.deepEqual(output.exactMarker("config-start"), {
    stream: "stdout",
    capturedMs: 9,
    text: "α config-start\r",
    terminated: true,
  });
  assert.equal(Buffer.concat(output.bytes.stdout).equals(bytes), true);
  assert.equal(output.exactMarker(null), null);
});

test("retains an unterminated final line without inventing a terminator", () => {
  const output = new OutputTimeline();
  output.write("stderr", Buffer.from("unfinished"), 2);
  output.finish(3);
  assert.deepEqual(output.events, [
    { stream: "stderr", capturedMs: 3, text: "unfinished", terminated: false },
  ]);
});

test("caps retained bytes while continuing to accept drained output", () => {
  const output = new OutputTimeline(4);
  output.write("stdout", Buffer.from("abcdef"), 1);
  output.write("stderr", Buffer.alloc(2_000_000), 2);
  output.finish(3);
  assert.equal(output.exceeded, true);
  assert.equal(Buffer.concat(output.bytes.stdout).toString(), "abcd");
  assert.equal(output.bytes.stderr.length, 0);
});

test("caps line metadata from newline floods", () => {
  const output = new OutputTimeline();
  output.write("stdout", Buffer.alloc(9000, 10), 1);
  output.finish(2);
  assert.equal(output.exceeded, true);
  assert.equal(output.events.length, 8192);
});

test("captures actual child output and a reviewed marker with monotonic order", async () => {
  const result = await child(
    "process.stdout.write('first\\n'); setTimeout(()=>process.stderr.write('config-start\\n'),30)",
    { marker: "config-start" },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.closed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.firstConfigurationLog?.stream, "stderr");
  assert.ok(result.firstByteMs.stdout! <= result.firstConfigurationLog!.capturedMs);
  assert.equal(Buffer.from(result.stdoutBase64, "base64").toString(), "first\n");
});

test("preserves the actual nonzero child exit and stderr", async () => {
  const result = await child("console.error('fixture failure');process.exitCode=23");
  assert.equal(result.exitCode, 23);
  assert.equal(result.closed, true);
  assert.match(result.stderr, /fixture failure/u);
});

test("records spawn failure without a valid timing success", async () => {
  const result = await child("", {
    executable: path.join(os.tmpdir(), "absent-performance-node-" + process.pid),
  });
  assert.match(result.spawnError!, /ENOENT/u);
  assert.equal(result.timedOut, false);
  assert.equal(result.closed, true);
});

test("kills only its owned stalled child and reports a timeout", async () => {
  const result = await child("setInterval(()=>{},1000)", { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.rootTerminationConfirmed, true);
  assert.notEqual(result.exitCode, 0);
  assert.throws(() => process.kill(result.processId!, 0));
});

test("records explicit cancellation separately from a timeout", async () => {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 100);
  try {
    const result = await child("setInterval(()=>{},1000)", { signal: stop.signal });
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.rootTerminationConfirmed, true);
  } finally {
    clearTimeout(timer);
  }
});

test("observer setup failure still stops the exact child", async () => {
  const result = await child("setInterval(()=>{},1000)", {
    onSpawn: () => {
      throw new Error("observer fixture");
    },
  });
  assert.equal(result.observerError, "observer fixture");
  assert.equal(result.rootTerminationConfirmed, true);
});

test("invalid configuration markers are rejected before a child starts", async () => {
  let started = false;
  await assert.rejects(
    child("process.exit(0)", {
      marker: "two\nlines",
      onSpawn: () => {
        started = true;
      },
    }),
    /bounded literal/u,
  );
  assert.equal(started, false);
});

test("retains official startup spans without summing overlapping durations", () => {
  const events = [
    {
      stream: "stderr" as const,
      capturedMs: 50,
      terminated: true,
      text: "[gateway] startup trace: gateway.config.snapshot 3.2ms total=11.5ms",
    },
  ];
  assert.deepEqual(startupSpans(events), [
    {
      name: "gateway.config.snapshot",
      durationMs: 3.2,
      upstreamRelativeTotalMs: 11.5,
      capturedMs: 50,
      stream: "stderr",
      literal: events[0].text,
    },
  ]);
  assert.deepEqual(
    startupSpans([{ ...events[0], text: "startup trace: bad ...ms total=..ms" }]),
    [],
  );
});

test("inventories actual files without declaring source maps removable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "performance-inventory-"));
  try {
    fs.mkdirSync(path.join(root, "child"));
    fs.writeFileSync(path.join(root, "child", "a.js.map"), "123");
    fs.writeFileSync(path.join(root, "a.d.ts"), "12345");
    assert.deepEqual(inventory(root), {
      files: 2,
      logicalBytes: 8,
      includesDeclarationsAndSourceMaps: true,
    });
    assert.equal(identity(path.join(root, "a.d.ts")).bytes, 5);
    fs.symlinkSync(path.join(root, "a.d.ts"), path.join(root, "link"));
    assert.throws(() => inventory(root), /links/u);
    assert.throws(() => identity(path.join(root, "link")), /ordinary/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("publishes only a complete fixture record and rejects partial or oversized input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "performance-record-"));
  try {
    const file = path.join(root, "record.json");
    publishFixtureRecord(file, { nonce: "fixture", passed: true });
    assert.deepEqual(readFixtureRecord(file), { nonce: "fixture", passed: true });
    fs.writeFileSync(file, '{"passed":true}');
    assert.throws(() => readFixtureRecord(file), /incomplete/u);
    fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1, 10));
    assert.throws(() => readFixtureRecord(file), /exceeds/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("owned sandbox name satisfies the pinned nineteen-character routing limit", () => {
  const name = probeSandboxName("abcdef123456abcdef123456");
  assert.ok(name.length <= 19);
  assert.match(name, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u);
  assert.equal(name, "ro-abcdef123456");
  assert.throws(() => probeSandboxName("untrusted/path"), /nonce/u);
});
