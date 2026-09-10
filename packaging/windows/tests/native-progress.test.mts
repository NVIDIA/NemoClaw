// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import {
  copyNativeRuntime,
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

test("copies nested and empty files with milestones after destination publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-progress-copy-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  try {
    await mkdir(join(source, "nested"), { recursive: true });
    await mkdir(join(source, "empty-directory"));
    await writeFile(join(source, "first"), "first payload");
    await writeFile(join(source, "nested", "second"), "second payload");
    await writeFile(join(source, "empty"), "");
    const files = [
      join(destination, "first"),
      join(destination, "nested", "second"),
      join(destination, "empty"),
    ];
    const observed: number[] = [];
    const result = await copyNativeRuntime([{ source, destination }], {
      onProgress(counts) {
        if (!counts) return;
        assert.deepEqual(Object.keys(counts).sort(), ["completed", "total", "unit"]);
        assert.equal(counts.unit, "files");
        assert.equal(counts.total, 3);
        assert.equal(files.filter(existsSync).length, counts.completed);
        observed.push(counts.completed);
      },
    });
    assert.deepEqual(result, { completed: 3, total: 3 });
    assert.deepEqual(observed, [0, 1, 2, 3]);
    assert.equal(await readFile(files[0], "utf8"), "first payload");
    assert.equal(await readFile(files[1], "utf8"), "second payload");
    assert.equal(await readFile(files[2], "utf8"), "");
    assert.ok(existsSync(join(destination, "empty-directory")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty staging remains indeterminate instead of fabricating a positive total", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-progress-empty-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    const updates: (NativeProgressCounts | undefined)[] = [];
    assert.deepEqual(
      await copyNativeRuntime([{ source, destination: join(root, "copy") }], {
        onProgress: (counts) => updates.push(counts),
      }),
      { completed: 0, total: 0 },
    );
    assert.deepEqual(updates, [undefined]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation settles the owned copy before caller cleanup removes partial files", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-progress-abort-"));
  const controller = new AbortController();
  try {
    const source = join(root, "source");
    const destination = join(root, "copy");
    await mkdir(source);
    await Promise.all(
      ["first", "second", "third"].map((name) =>
        writeFile(join(source, name), Buffer.alloc(4096, 7)),
      ),
    );
    await assert.rejects(
      copyNativeRuntime([{ source, destination }], {
        signal: controller.signal,
        onProgress(counts) {
          if (counts?.completed === 1) controller.abort();
        },
      }),
      { name: "AbortError" },
    );
    await rm(destination, { recursive: true });
    assert.equal(existsSync(destination), false);
    await assert.rejects(
      copyNativeRuntime([{ source, destination }], { signal: controller.signal }),
      { name: "AbortError" },
    );
    assert.equal(existsSync(destination), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves the copy operation's rejection of a destination inside its source", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-progress-alias-"));
  try {
    await writeFile(join(root, "payload"), "payload");
    await assert.rejects(copyNativeRuntime([{ source: root, destination: join(root, "inside") }]), {
      code: "ERR_FS_CP_EINVAL",
    });
    assert.equal(existsSync(join(root, "inside")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts each timed copy target before its writes while retaining combined counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-progress-targets-"));
  try {
    const first = join(root, "node-input"),
      second = join(root, "agent-input");
    const node = join(root, "node-copy"),
      agent = join(root, "agent-copy");
    await writeFile(first, "node");
    await writeFile(second, "agent");
    const starts: { index: number; nodeExists: boolean; agentExists: boolean }[] = [];
    const counts: NativeProgressCounts[] = [];
    const result = await copyNativeRuntime(
      [
        { source: first, destination: node },
        { source: second, destination: agent },
      ],
      {
        onTargetStart: (index) =>
          starts.push({ index, nodeExists: existsSync(node), agentExists: existsSync(agent) }),
        onProgress: (value) => {
          if (value) counts.push(value);
        },
      },
    );
    assert.deepEqual(starts, [
      { index: 0, nodeExists: false, agentExists: false },
      { index: 1, nodeExists: true, agentExists: false },
    ]);
    assert.deepEqual(counts, [
      { completed: 0, total: 2, unit: "files" },
      { completed: 1, total: 2, unit: "files" },
      { completed: 2, total: 2, unit: "files" },
    ]);
    assert.deepEqual(result, { completed: 2, total: 2 });
    assert.equal(await readFile(node, "utf8"), "node");
    assert.equal(await readFile(agent, "utf8"), "agent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
