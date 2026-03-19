// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { OnboardPipeline } = require("../bin/lib/onboard");

describe("OnboardPipeline", () => {
  it("runs all steps in order when none fail", async () => {
    const order = [];
    const pipeline = new OnboardPipeline();
    await pipeline.run([
      { name: "A", execute: async () => { order.push("A"); }, rollback: null },
      { name: "B", execute: async () => { order.push("B"); }, rollback: null },
      { name: "C", execute: async () => { order.push("C"); }, rollback: null },
    ]);
    assert.deepEqual(order, ["A", "B", "C"]);
  });

  it("rolls back completed steps in reverse when a step fails", async () => {
    const order = [];
    const pipeline = new OnboardPipeline();
    await assert.rejects(
      () => pipeline.run([
        { name: "A", execute: async () => { order.push("exec-A"); }, rollback: () => { order.push("rollback-A"); } },
        { name: "B", execute: async () => { order.push("exec-B"); }, rollback: () => { order.push("rollback-B"); } },
        { name: "C", execute: async () => { throw new Error("step C failed"); }, rollback: () => { order.push("rollback-C"); } },
      ]),
      { message: "step C failed" }
    );
    // C's execute threw, so C was never pushed to completedSteps.
    // Rollback should run B then A (reverse order), NOT C.
    assert.deepEqual(order, ["exec-A", "exec-B", "rollback-B", "rollback-A"]);
  });

  it("does not run rollback for steps with null rollback", async () => {
    const order = [];
    const pipeline = new OnboardPipeline();
    await assert.rejects(
      () => pipeline.run([
        { name: "A", execute: async () => { order.push("exec-A"); }, rollback: null },
        { name: "B", execute: async () => { order.push("exec-B"); }, rollback: () => { order.push("rollback-B"); } },
        { name: "C", execute: async () => { throw new Error("fail"); }, rollback: null },
      ])
    );
    // Only B has a rollback function
    assert.deepEqual(order, ["exec-A", "exec-B", "rollback-B"]);
  });

  it("continues rollback even if a rollback function throws", async () => {
    const order = [];
    const pipeline = new OnboardPipeline();
    await assert.rejects(
      () => pipeline.run([
        { name: "A", execute: async () => {}, rollback: () => { order.push("rollback-A"); } },
        { name: "B", execute: async () => {}, rollback: () => { throw new Error("rollback B broken"); } },
        { name: "C", execute: async () => { throw new Error("fail"); }, rollback: null },
      ])
    );
    // B's rollback throws but A's rollback should still run
    assert.deepEqual(order, ["rollback-A"]);
  });

  it("clears completedSteps after rollback", async () => {
    const pipeline = new OnboardPipeline();
    await assert.rejects(
      () => pipeline.run([
        { name: "A", execute: async () => {}, rollback: () => {} },
        { name: "B", execute: async () => { throw new Error("fail"); }, rollback: null },
      ])
    );
    assert.equal(pipeline.completedSteps.length, 0);
  });

  it("removes signal handlers after successful run", async () => {
    const pipeline = new OnboardPipeline();
    await pipeline.run([
      { name: "A", execute: async () => {}, rollback: null },
    ]);
    assert.equal(pipeline._signalHandler, null, "signal handler should be cleaned up");
  });

  it("removes signal handlers after failed run", async () => {
    const pipeline = new OnboardPipeline();
    await assert.rejects(
      () => pipeline.run([
        { name: "A", execute: async () => { throw new Error("fail"); }, rollback: null },
      ])
    );
    assert.equal(pipeline._signalHandler, null, "signal handler should be cleaned up");
  });
});
