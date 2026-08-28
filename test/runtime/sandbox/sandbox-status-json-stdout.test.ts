// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSandboxStatusReport } from "../../../src/lib/actions/sandbox/status-snapshot.js";

// `sandbox status --json` builds a machine-readable report through
// getSandboxStatusReport, which reconciles the gateway. When the gateway needs
// recovery, the reconcile path prints human progress to stdout (step(),
// "Waiting for gateway health...", and so on). We inject a reconcile that
// writes that progress and assert the --json report builder
// keeps stdout clean; otherwise the JSON document on stdout is unparseable.
// Writes go through process.stdout.write directly (what console.log delegates
// to), so the test targets the exact stream the builder must keep clean.
describe("sandbox status --json keeps stdout clean during gateway recovery", () => {
  let originalWrite: typeof process.stdout.write;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      const cb = rest.find((a) => typeof a === "function") as undefined | (() => void);
      if (cb) cb();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("does not leak reconcile/recovery progress onto stdout (it would corrupt --json)", async () => {
    const report = await getSandboxStatusReport("ghost-sandbox", {
      reconcile: async () => {
        process.stdout.write("\n  [2/8] Starting OpenShell gateway\n");
        process.stdout.write("  Starting gateway cluster...\n");
        process.stdout.write("  Waiting for gateway health...\n");
        return {
          state: "gateway_unreachable_after_restart",
          output: "Gateway: nemoclaw\nStatus: unreachable",
        };
      },
    });
    process.stdout.write = originalWrite;

    const onStdout = captured.join("");
    expect(onStdout).not.toContain("Starting OpenShell gateway");
    expect(onStdout).not.toContain("Starting gateway cluster");
    expect(onStdout).toBe("");

    expect(report.schemaVersion).toBe(1);
    expect(report.name).toBe("ghost-sandbox");
    expect(report.found).toBe(false);
    expect(report.gatewayState).toBe("gateway_unreachable_after_restart");
    expect(report.baselineExclusions).toEqual([]);
    expect(report.baselineExclusionStates).toEqual([]);
    expect(report.baselineExclusionTransition).toBeNull();
  });

  it("reports unknown runtime when a non-OpenClaw registry agent cannot be loaded", async () => {
    const report = await getSandboxStatusReport("custom-sandbox", {
      getSandbox: () =>
        ({
          name: "custom-sandbox",
          agent: "missing-terminal-agent",
          provider: "nvidia-prod",
          model: "test-model",
          policies: [],
          baselineExclusions: [
            {
              version: 1,
              agent: "missing-terminal-agent",
              key: "nous_research",
              digest: "a".repeat(64),
            },
          ],
          openshellDriver: "native",
        }) as never,
      reconcile: async () => ({ state: "missing", output: "" }),
      getBaselineExclusionRuntimeStatus: () => "live-policy-mismatch",
    });

    expect(report.agent).toBe("missing-terminal-agent");
    expect(report.agentRuntime).toBe("unknown");
    expect(report.agentLoadError).toMatch(/missing-terminal-agent/);
    expect(report.baselineExclusions).toEqual(["nous_research"]);
    expect(report.baselineExclusionStates).toEqual([
      { key: "nous_research", status: "live-policy-mismatch" },
    ]);
  });

  it("reports a pending baseline policy transaction separately from committed exclusions", async () => {
    const report = await getSandboxStatusReport("repairing-sandbox", {
      getSandbox: () =>
        ({
          name: "repairing-sandbox",
          policies: [],
          baselineExclusions: [],
          baselineExclusionTransition: {
            id: "tx-1",
            operation: "exclude",
            exclusion: {
              version: 1,
              agent: "openclaw",
              key: "nous_research",
              digest: "a".repeat(64),
            },
            targetLiveDigest: null,
            startedAt: "2026-07-19T00:00:00.000Z",
          },
        }) as never,
      reconcile: async () => ({ state: "missing", output: "" }),
    });

    expect(report.baselineExclusions).toEqual([]);
    expect(report.baselineExclusionTransition).toEqual({
      operation: "exclude",
      key: "nous_research",
    });
  });
});
