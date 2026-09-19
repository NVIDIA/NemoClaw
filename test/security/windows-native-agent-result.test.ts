// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as delay } from "node:timers/promises";
import { access, writeFile } from "node:fs/promises";
import {
  openNativeTurnResultFixture,
  validNativeTurnResult,
} from "../support/windows-native-turn-result-fixtures.js";
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
      await fixture.write(JSON.stringify(fixture.expected) + "\n");
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
        await fixture.write(JSON.stringify(fixture.expected) + "\n");
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
      await fixture.write(JSON.stringify(fixture.expected) + "\n");
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
      await fixture.write(JSON.stringify({ verdict: "pass", token: "different" }) + "\n");
      await expect(fixture.wait(100, "OWNED_FINAL_TOKEN", label)).rejects.toThrow(
        `${label} did not publish`,
      );
      await fixture.write(JSON.stringify(fixture.expected) + "\n");
      expect(JSON.parse(await fixture.wait(100, "OWNED_FINAL_TOKEN", label))).toEqual(
        fixture.expected,
      );
    } finally {
      await fixture.close();
    }
  },
);

it("waits for the terminal receipt completion marker after its final token", async () => {
  const fixture = await openNativeAgentResultFixture("terminal");
  try {
    await fixture.write(JSON.stringify(fixture.expected).slice(0, -1));
    let settled = false;
    const pending = fixture.wait().then((value) => {
      settled = true;
      return value;
    });
    await delay(50);
    expect(settled).toBe(false);
    await fixture.write(JSON.stringify(fixture.expected) + "\n");
    expect(JSON.parse(await pending)).toEqual(fixture.expected);
  } finally {
    await fixture.close();
  }
});

it("keeps the terminal receipt byte bound", async () => {
  const fixture = await openNativeAgentResultFixture("terminal");
  try {
    await fixture.write("OWNED_FINAL_TOKEN" + "x".repeat(1024 * 1024));
    await expect(fixture.wait()).rejects.toThrow("exceeds its limit");
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
