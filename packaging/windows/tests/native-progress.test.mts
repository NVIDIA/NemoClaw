// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import {
  createNativeProgressWriter,
  type NativeProgressCounts,
  type NativeProgressStage,
} from "../runtime/native-web-session.mts";

function captureProgress() {
  const stream = new PassThrough();
  const records: Record<string, unknown>[] = [];
  stream.on("data", (chunk: Buffer) => records.push(JSON.parse(chunk.toString("utf8"))));
  const writer = createNativeProgressWriter(stream);
  return {
    stream,
    records,
    writer,
    close() {
      writer.close();
      stream.destroy();
    },
  };
}

test("coalesces real count updates and immediately advances fixed phases", async () => {
  const fixture = captureProgress();
  try {
    fixture.writer.progress("runtime", { completed: 0, total: 1000, unit: "files" });
    for (let completed = 1; completed <= 1000; completed++)
      fixture.writer.progress("runtime", { completed, total: 1000, unit: "files" });
    assert.equal(fixture.records.length, 1);
    await sleep(300);
    assert.deepEqual(fixture.records[1], {
      kind: "progress",
      stage: "runtime",
      completed: 1000,
      total: 1000,
      unit: "files",
    });
    fixture.writer.progress("gateway");
    assert.deepEqual(fixture.records[2], { kind: "progress", stage: "gateway" });
  } finally {
    fixture.close();
  }
});

test("rejects unknown stages and omits every invalid count field", () => {
  const invalid = [
    { completed: -1, total: 2, unit: "files" },
    { completed: 3, total: 2, unit: "files" },
    { completed: 0, total: 0, unit: "files" },
    { completed: 0.5, total: 2, unit: "files" },
    { completed: 0, total: Number.MAX_SAFE_INTEGER + 1, unit: "files" },
    { completed: NaN, total: Infinity, unit: "files" },
    { completed: 0, total: 2, unit: "secret-path" },
    { completed: 0, unit: "files" },
  ];
  for (const counts of invalid) {
    const fixture = captureProgress();
    try {
      fixture.writer.progress("private-path-or-token" as NativeProgressStage);
      fixture.writer.progress("runtime", counts as NativeProgressCounts);
      assert.deepEqual(fixture.records, [{ kind: "progress", stage: "runtime" }]);
    } finally {
      fixture.close();
    }
  }
});

test("retains only the latest progress while a real Writable is backpressured", async () => {
  const received: string[] = [];
  const callbacks: (() => void)[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      received.push(chunk.toString("utf8"));
      callbacks.push(callback);
    },
  });
  const writer = createNativeProgressWriter(stream);
  try {
    writer.progress("runtime", { completed: 0, total: 1000, unit: "files" });
    for (let completed = 1; completed <= 1000; completed++)
      writer.progress("runtime", { completed, total: 1000, unit: "files" });
    assert.equal(received.length, 1);
    assert.ok(stream.writableLength < 256);
    callbacks.shift()!();
    await sleep(300);
    assert.equal(received.length, 2);
    assert.equal(JSON.parse(received[1]).completed, 1000);
    writer.close();
    callbacks.shift()!();
    assert.equal(stream.listenerCount("drain"), 0);
  } finally {
    writer.close();
    stream.destroy();
  }
});

test("discarding stale progress and closing remove scheduled updates", async () => {
  const fixture = captureProgress();
  try {
    fixture.writer.progress("runtime");
    fixture.writer.progress("runtime", { completed: 1, total: 3, unit: "files" });
    fixture.writer.clear();
    await sleep(300);
    assert.equal(fixture.records.length, 1);
    fixture.writer.progress("runtime", { completed: 2, total: 3, unit: "files" });
    fixture.writer.close();
    await sleep(300);
    assert.equal(fixture.records.length, 1);
    assert.equal(fixture.stream.listenerCount("drain"), 0);
  } finally {
    fixture.close();
  }
});
