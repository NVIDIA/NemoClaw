// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSandboxStatusReport } from "../dist/lib/actions/sandbox/status-snapshot.js";

// `sandbox status --json` builds a machine-readable report through
// getSandboxStatusReport, which reconciles the gateway. When the gateway needs
// recovery, the reconcile path prints human progress to stdout (step(),
// streamGatewayStart, "Waiting for gateway health...", etc.). We inject a
// reconcile that writes that progress and assert the --json report builder
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
  });
});
