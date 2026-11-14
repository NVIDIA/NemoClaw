// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { access, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  openNativeTurnResultFixture,
  validNativeTurnResult,
} from "../support/windows-native-turn-result-fixtures.js";

describe("native one-shot result ownership", () => {
  it("waits for the workload result after a successful create command exits", async () => {
    const fixture = await openNativeTurnResultFixture();
    try {
      expect(fixture.create.exitCode).toBe(0);
      await expect(access(fixture.resultPath)).rejects.toThrow();
      const waiting = fixture.wait();
      const workload = fixture.publish();
      await expect(waiting).resolves.toEqual(validNativeTurnResult);
      await workload.closed;
      expect(workload.child.exitCode).toBe(0);
      expect(fixture.gateway.exitCode).toBeNull();
      expect(fixture.gateway.signalCode).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("accepts the result while the create watcher is still running", async () => {
    const fixture = await openNativeTurnResultFixture("pending");
    try {
      fixture.publish();
      await expect(fixture.wait()).resolves.toEqual(validNativeTurnResult);
      expect(fixture.create.exitCode).toBeNull();
      expect(fixture.create.signalCode).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { mode: "failure" as const, expected: "request exited 23" },
    { mode: "signal" as const, expected: "request exited SIGTERM" },
  ])("rejects create $mode even if a result file exists", async ({ mode, expected }) => {
    const fixture = await openNativeTurnResultFixture(mode);
    try {
      await writeFile(fixture.resultPath, JSON.stringify(validNativeTurnResult));
      await expect(fixture.wait()).rejects.toThrow(expected);
    } finally {
      await fixture.close();
    }
  });

  it("preserves a create process launch failure", async () => {
    const fixture = await openNativeTurnResultFixture("missing");
    try {
      await expect(fixture.wait()).rejects.toBe(fixture.createFailure.error);
      expect(fixture.createFailure.error).toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.close();
    }
  });

  it("rejects a stopped gateway even if a result file exists", async () => {
    const fixture = await openNativeTurnResultFixture();
    try {
      await fixture.stopGateway();
      await writeFile(fixture.resultPath, JSON.stringify(validNativeTurnResult));
      await expect(fixture.wait()).rejects.toThrow("gateway stopped");
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { name: "failed workload", result: { ...validNativeTurnResult, chatExitCode: 1 } },
    { name: "wrong reply", result: { ...validNativeTurnResult, reply: "NOT_CHAT_OK" } },
  ])("rejects the actual $name result", async ({ result }) => {
    const fixture = await openNativeTurnResultFixture();
    try {
      fixture.publish(result);
      await expect(fixture.wait()).rejects.toThrow("turn result was not exact");
    } finally {
      await fixture.close();
    }
  });

  it("bounds a missing result and leaves resources for the caller's cleanup", async () => {
    const fixture = await openNativeTurnResultFixture();
    try {
      await expect(fixture.wait(40)).rejects.toThrow("did not publish a result");
      expect(fixture.gateway.exitCode).toBeNull();
      expect(fixture.gateway.signalCode).toBeNull();
      await expect(access(fixture.root)).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
    await expect(access(fixture.root)).rejects.toThrow();
    expect(fixture.gateway.signalCode).toBe("SIGTERM");
  });
});
