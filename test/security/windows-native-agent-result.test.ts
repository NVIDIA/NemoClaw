// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  createNativeAgentCompletionFixture,
  openNativeAgentResultFixture,
} from "../support/windows-native-agent-result-fixtures.js";

const routes = ["terminal", "nemocua"] as const;

describe.each(routes)("native %s request completion", (route) => {
  it("waits for an actual delayed result after creation exits zero", async () => {
    const fixture = await openNativeAgentResultFixture(route);
    try {
      expect(fixture.create.exitCode).toBe(0);
      let settled = false;
      const pending = fixture.wait().then((value) => {
        settled = true;
        return value;
      });
      await delay(50);
      expect(settled).toBe(false);
      const publisher = fixture.publish();
      expect(JSON.parse(await pending)).toEqual(fixture.expected);
      await publisher.closed;
      expect(fixture.gateway.exitCode).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("accepts a result while the creation watcher remains active", async () => {
    const fixture = await openNativeAgentResultFixture(route, "pending");
    try {
      await fixture.write(JSON.stringify(fixture.expected));
      expect(JSON.parse(await fixture.wait())).toEqual(fixture.expected);
      expect(fixture.create.exitCode).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it.each(["failure", "signal", "missing"] as const)(
    "fails promptly for creation %s even with a result",
    async (mode) => {
      const fixture = await openNativeAgentResultFixture(route, mode);
      try {
        await fixture.write(JSON.stringify(fixture.expected));
        const error = await fixture.wait(5000).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/OpenShell request exited|ENOENT/);
      } finally {
        await fixture.close();
      }
    },
  );

  it("rejects gateway loss before accepting an existing result", async () => {
    const fixture = await openNativeAgentResultFixture(route);
    try {
      await fixture.write(JSON.stringify(fixture.expected));
      await fixture.stopGateway();
      await expect(fixture.wait()).rejects.toThrow("gateway stopped");
    } finally {
      await fixture.close();
    }
  });

  it("retains the bounded missing-result deadline after successful creation", async () => {
    const fixture = await openNativeAgentResultFixture(route);
    try {
      await expect(fixture.wait(100)).rejects.toThrow("before the deadline");
      expect(fixture.create.exitCode).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});

it.each(["Pi", "Hermes", "Deep Agents Code"])(
  "keeps the final-token requirement for %s",
  async (label) => {
    const fixture = await openNativeAgentResultFixture("terminal");
    try {
      await fixture.write(JSON.stringify({ verdict: "pass", token: "different" }));
      await expect(fixture.wait(100, "OWNED_FINAL_TOKEN", label)).rejects.toThrow(
        `${label} did not publish`,
      );
      await fixture.write(JSON.stringify(fixture.expected));
      expect(JSON.parse(await fixture.wait(100, "OWNED_FINAL_TOKEN", label))).toEqual(
        fixture.expected,
      );
    } finally {
      await fixture.close();
    }
  },
);

it("keeps the terminal receipt byte bound", async () => {
  const fixture = await openNativeAgentResultFixture("terminal");
  try {
    await fixture.write("OWNED_FINAL_TOKEN" + "x".repeat(1024 * 1024));
    await expect(fixture.wait()).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});

it("stops the guarded polling owner when an outer relay failure cancels it", async () => {
  const fixture = await openNativeAgentResultFixture("nemocua");
  try {
    const pending = fixture.wait();
    fixture.abort();
    await expect(pending).rejects.toThrow("owned result monitoring cancelled");
    const reads = fixture.reads();
    await delay(150);
    expect(fixture.reads()).toBe(reads);
  } finally {
    await fixture.close();
  }
});

describe.each(routes)("native %s result cleanup", (route) => {
  it("keeps a successful result's sandbox until its executor completes", async () => {
    const fixture = createNativeAgentCompletionFixture(route);
    const pending = fixture.finish();
    expect(fixture.queries).toEqual([
      ["owned-openshell", fixture.environment, "owned-sandbox", fixture.gateway, null],
    ]);
    expect(fixture.deletions).toEqual([]);
    await delay(25);
    expect(fixture.deletions).toEqual([]);
    fixture.complete("AgentCompleted");
    await pending;
    expect(fixture.deletions).toEqual([
      [
        "owned-openshell",
        ["sandbox", "delete", "owned-sandbox"],
        fixture.environment,
        expect.any(String),
      ],
    ]);
  });

  it("rejects failed execution instead of entering successful deletion", async () => {
    const fixture = createNativeAgentCompletionFixture(route);
    const pending = fixture.finish();
    fixture.complete("ExecFailed");
    await expect(pending).rejects.toThrow("executor failed during cleanup");
    expect(fixture.deletions).toEqual([]);
  });

  it("preserves completion-observation failure for owned failure cleanup", async () => {
    const fixture = createNativeAgentCompletionFixture(route);
    const pending = fixture.finish();
    const error = new Error("owned executor observation failed");
    fixture.reject(error);
    await expect(pending).rejects.toBe(error);
    expect(fixture.deletions).toEqual([]);
  });
});
