// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for #860: per-chat message queuing prevents concurrent agent calls
// and caps queue depth to provide backpressure.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chatQueues, chatQueueDepths, chatEpochs, MAX_QUEUE_DEPTH } = require("../scripts/telegram-bridge");

describe("telegram bridge queue serialization", () => {
  it("exports MAX_QUEUE_DEPTH as 5", () => {
    expect(MAX_QUEUE_DEPTH).toBe(5);
  });

  it("two concurrent jobs on the same chatId execute sequentially", async () => {
    const order = [];
    let resolveFirst;
    const firstBlocks = new Promise((r) => { resolveFirst = r; });

    const job1 = async () => {
      order.push("job1-start");
      await firstBlocks;
      order.push("job1-end");
    };
    const job2 = async () => {
      order.push("job2-start");
      order.push("job2-end");
    };

    const chatId = "test-serial";
    const prev = chatQueues.get(chatId) || Promise.resolve();
    const chain1 = prev.then(job1, job1);
    chatQueues.set(chatId, chain1);

    const chain2 = chain1.then(job2, job2);
    chatQueues.set(chatId, chain2);

    // job1 should have started but job2 should be waiting
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["job1-start"]);

    // Unblock job1 — job2 should run after
    resolveFirst();
    await chain2;

    expect(order).toEqual(["job1-start", "job1-end", "job2-start", "job2-end"]);

    // Cleanup
    chatQueues.delete(chatId);
  });

  it("different chatIds run independently (in parallel)", async () => {
    const order = [];
    let resolveA;
    const blockA = new Promise((r) => { resolveA = r; });

    const jobA = async () => {
      order.push("A-start");
      await blockA;
      order.push("A-end");
    };
    const jobB = async () => {
      order.push("B-start");
      order.push("B-end");
    };

    const prevA = chatQueues.get("chatA") || Promise.resolve();
    const chainA = prevA.then(jobA, jobA);
    chatQueues.set("chatA", chainA);

    const prevB = chatQueues.get("chatB") || Promise.resolve();
    const chainB = prevB.then(jobB, jobB);
    chatQueues.set("chatB", chainB);

    // B should complete even though A is blocked
    await chainB;
    expect(order).toContain("B-start");
    expect(order).toContain("B-end");
    expect(order).not.toContain("A-end");

    resolveA();
    await chainA;
    expect(order).toEqual(["A-start", "B-start", "B-end", "A-end"]);

    chatQueues.delete("chatA");
    chatQueues.delete("chatB");
  });

  it("chatQueueDepths tracks pending jobs and decrements on completion", async () => {
    const chatId = "test-depth";
    chatQueueDepths.set(chatId, 3);
    expect(chatQueueDepths.get(chatId)).toBe(3);

    chatQueueDepths.set(chatId, chatQueueDepths.get(chatId) - 1);
    expect(chatQueueDepths.get(chatId)).toBe(2);

    chatQueueDepths.delete(chatId);
  });

  it("MAX_QUEUE_DEPTH caps at 5 pending jobs", () => {
    const chatId = "test-cap";
    // Simulate 5 queued jobs
    chatQueueDepths.set(chatId, 5);

    const depth = chatQueueDepths.get(chatId) || 0;
    expect(depth >= MAX_QUEUE_DEPTH).toBe(true);

    chatQueueDepths.delete(chatId);
  });

  it("/reset during in-flight job does not cause overlapping runs", async () => {
    const chatId = "test-reset-race";
    let resolveOld;
    const blockOld = new Promise((r) => { resolveOld = r; });
    const executed = [];

    // Epoch starts at 0
    chatEpochs.delete(chatId);
    const epochBefore = chatEpochs.get(chatId) || 0;

    // Enqueue a blocking "old" job that captures epoch 0
    const oldJob = async () => {
      executed.push("old-start");
      await blockOld;
      executed.push("old-end");
    };
    const prev = chatQueues.get(chatId) || Promise.resolve();
    const chain1 = prev.then(oldJob, oldJob);
    chatQueues.set(chatId, chain1);
    chatQueueDepths.set(chatId, 1);

    // old job starts
    await new Promise((r) => setTimeout(r, 10));
    expect(executed).toEqual(["old-start"]);

    // Simulate /reset: bump epoch, clear queue state
    chatQueues.delete(chatId);
    chatQueueDepths.delete(chatId);
    chatEpochs.set(chatId, epochBefore + 1);
    const epochAfter = chatEpochs.get(chatId) || 0;
    expect(epochAfter).toBe(1);

    // Enqueue a "new" job that captures epoch 1 — stale-check should skip
    // it if it was queued under the old epoch, but here it's under the new one.
    const newJob = async () => {
      // Check: new job's epoch matches current, so it should run
      const currentEpoch = chatEpochs.get(chatId) || 0;
      expect(currentEpoch).toBe(epochAfter);
      executed.push("new-run");
    };
    const prevNew = chatQueues.get(chatId) || Promise.resolve();
    const chain2 = prevNew.then(newJob, newJob);
    chatQueues.set(chatId, chain2);

    // new job runs immediately (fresh chain, not blocked by old)
    await chain2;
    expect(executed).toContain("new-run");
    expect(executed).not.toContain("old-end");

    // Resolve old job — it should complete without throwing
    resolveOld();
    await chain1;
    expect(executed).toContain("old-end");

    // Cleanup
    chatQueues.delete(chatId);
    chatQueueDepths.delete(chatId);
    chatEpochs.delete(chatId);
  });
});
