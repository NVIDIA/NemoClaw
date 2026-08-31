// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSandboxStatusReport } from "../../../src/lib/actions/sandbox/status-snapshot.js";

describe("sandbox status JSON", () => {
  let originalWrite: typeof process.stdout.write;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      const callback = rest.find((value) => typeof value === "function") as
        | (() => void)
        | undefined;
      callback?.();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("keeps stdout clean during gateway recovery", async () => {
    const report = await getSandboxStatusReport("ghost-sandbox", {
      reconcile: async () => {
        process.stdout.write("gateway recovery progress\n");
        return { state: "gateway_unreachable_after_restart", output: "" };
      },
    });
    process.stdout.write = originalWrite;
    expect(captured.join("")).toBe("");
    expect(report).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        name: "ghost-sandbox",
        found: false,
        gatewayState: "gateway_unreachable_after_restart",
      }),
    );
  });

  it("does not expose removed policy shadow fields", async () => {
    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => ({ name: "alpha", agent: "openclaw" }),
      getGatewayPresets: () => ["npm"],
      reconcile: async () => ({ state: "missing", output: "" }),
    });
    expect(report.policies).toEqual(["npm"]);
    expect(report.policiesAvailable).toBe(true);
    expect(report).not.toHaveProperty("baselineExclusions");
    expect(report).not.toHaveProperty("baselineExclusionTransition");
  });

  it("distinguishes unavailable live policy from a verified empty policy", async () => {
    const base = {
      getSandbox: () => ({ name: "alpha", agent: "openclaw" }),
      reconcile: async () => ({ state: "missing" as const, output: "" }),
    };
    const unavailable = await getSandboxStatusReport("alpha", {
      ...base,
      getGatewayPresets: () => null,
    });
    const empty = await getSandboxStatusReport("alpha", {
      ...base,
      getGatewayPresets: () => [],
    });

    expect(unavailable.policies).toEqual([]);
    expect(unavailable.policiesAvailable).toBe(false);
    expect(empty.policies).toEqual([]);
    expect(empty.policiesAvailable).toBe(true);
  });
});
