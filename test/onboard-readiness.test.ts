// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { applyPreset, buildPolicySetCommand, buildPolicyGetCommand } from "../dist/lib/policies";
import { hasStaleGateway, isSandboxReady, parseSandboxStatus } from "../dist/lib/onboard";

describe("sandbox readiness parsing", () => {
  it("detects Ready sandbox", () => {
    expect(isSandboxReady("my-assistant   Ready   2m ago", "my-assistant")).toBeTruthy();
  });

  it("rejects NotReady sandbox", () => {
    expect(!isSandboxReady("my-assistant   NotReady   init failed", "my-assistant")).toBeTruthy();
  });

  it("rejects empty output", () => {
    expect(!isSandboxReady("No sandboxes found.", "my-assistant")).toBeTruthy();
    expect(!isSandboxReady("", "my-assistant")).toBeTruthy();
  });

  it("strips ANSI escape codes before matching", () => {
    expect(
      isSandboxReady("\x1b[1mmy-assistant\x1b[0m   \x1b[32mReady\x1b[0m   2m ago", "my-assistant"),
    ).toBeTruthy();
  });

  it("rejects ANSI-wrapped NotReady", () => {
    expect(
      !isSandboxReady(
        "\x1b[1mmy-assistant\x1b[0m   \x1b[31mNotReady\x1b[0m   crash",
        "my-assistant",
      ),
    ).toBeTruthy();
  });

  it("exact-matches sandbox name in first column", () => {
    // "my" should NOT match "my-assistant"
    expect(!isSandboxReady("my-assistant   Ready   2m ago", "my")).toBeTruthy();
  });

  it("does not match sandbox name in non-first column", () => {
    expect(
      !isSandboxReady("other-box   Ready   owned-by-my-assistant", "my-assistant"),
    ).toBeTruthy();
  });

  it("handles multiple sandboxes in output", () => {
    const output = [
      "NAME           STATUS     AGE",
      "dev-box        NotReady   5m ago",
      "my-assistant   Ready      2m ago",
      "staging        Ready      10m ago",
    ].join("\n");
    expect(isSandboxReady(output, "my-assistant")).toBeTruthy();
    expect(!isSandboxReady(output, "dev-box")).toBeTruthy(); // NotReady
    expect(isSandboxReady(output, "staging")).toBeTruthy();
    expect(!isSandboxReady(output, "prod")).toBeTruthy(); // not present
  });

  it("handles Ready sandbox with extra status columns", () => {
    expect(
      isSandboxReady("my-assistant   Ready   Running   2m ago   1/1", "my-assistant"),
    ).toBeTruthy();
  });

  it("rejects when output only contains name in a URL or path", () => {
    expect(
      !isSandboxReady("Connecting to my-assistant.openshell.internal Ready", "my-assistant"),
    ).toBeTruthy();
    // "my-assistant.openshell.internal" is cols[0], not "my-assistant"
  });

  it("handles tab-separated output", () => {
    expect(isSandboxReady("my-assistant\tReady\t2m ago", "my-assistant")).toBeTruthy();
  });
});

// Regression tests: WSL truncates hyphenated sandbox names during shell
// argument parsing (e.g. "my-assistant" → "m").
describe("WSL sandbox name handling", () => {
  it("buildPolicySetCommand preserves hyphenated sandbox name as a separate argv element", () => {
    const cmd = buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
    expect(cmd).toContain("my-assistant");
    // The sandbox name must be a discrete argv element, not concatenated into a shell string
    expect(cmd[cmd.length - 1]).toBe("my-assistant");
  });

  it("buildPolicyGetCommand preserves hyphenated sandbox name", () => {
    const cmd = buildPolicyGetCommand("my-assistant");
    expect(cmd).toContain("my-assistant");
  });

  it("buildPolicySetCommand preserves multi-hyphen names", () => {
    const cmd = buildPolicySetCommand("/tmp/p.yaml", "my-dev-assistant-v2");
    expect(cmd).toContain("my-dev-assistant-v2");
  });

  it("buildPolicySetCommand preserves single-char name", () => {
    // If WSL truncates "my-assistant" to "m", the single-char name should
    // still be passed through unchanged as an argv element
    const cmd = buildPolicySetCommand("/tmp/p.yaml", "m");
    expect(cmd).toContain("m");
  });

  it("applyPreset rejects truncated/invalid sandbox name", () => {
    // Empty name
    expect(() => applyPreset("", "npm")).toThrow(/Invalid or truncated sandbox name/);
    // Name with uppercase (not valid per RFC 1123)
    expect(() => applyPreset("My-Assistant", "npm")).toThrow(/Invalid or truncated sandbox name/);
    // Name starting with hyphen
    expect(() => applyPreset("-broken", "npm")).toThrow(/Invalid or truncated sandbox name/);
  });

  it("readiness check uses exact match preventing truncated name false-positive", () => {
    // If "my-assistant" was truncated to "m", the readiness check should
    // NOT match a sandbox named "my-assistant" when searching for "m"
    expect(!isSandboxReady("my-assistant   Ready   2m ago", "m")).toBeTruthy();
    expect(!isSandboxReady("my-assistant   Ready   2m ago", "my")).toBeTruthy();
    expect(!isSandboxReady("my-assistant   Ready   2m ago", "my-")).toBeTruthy();
  });
});

describe("parseSandboxStatus", () => {
  it("returns status for a matching sandbox", () => {
    expect(parseSandboxStatus("my-assistant   Ready   2m ago", "my-assistant")).toBe("Ready");
  });

  it("returns Pending status", () => {
    expect(parseSandboxStatus("my-assistant   Pending   10s ago", "my-assistant")).toBe("Pending");
  });

  it("returns ContainerCreating status", () => {
    expect(parseSandboxStatus("my-assistant   ContainerCreating   5s ago", "my-assistant")).toBe("ContainerCreating");
  });

  it("returns Failed status", () => {
    expect(parseSandboxStatus("my-assistant   Failed   1m ago", "my-assistant")).toBe("Failed");
  });

  it("returns CrashLoopBackOff status", () => {
    expect(parseSandboxStatus("my-assistant   CrashLoopBackOff   3m ago", "my-assistant")).toBe("CrashLoopBackOff");
  });

  it("returns null when sandbox not found", () => {
    expect(parseSandboxStatus("other-box   Ready   2m ago", "my-assistant")).toBe(null);
  });

  it("returns null for empty output", () => {
    expect(parseSandboxStatus("", "my-assistant")).toBe(null);
  });

  it("returns null for null/undefined input", () => {
    expect(parseSandboxStatus(null, "my-assistant")).toBe(null);
    expect(parseSandboxStatus(undefined, "my-assistant")).toBe(null);
  });

  it("strips ANSI codes before parsing", () => {
    expect(
      parseSandboxStatus("\x1b[1mmy-assistant\x1b[0m   \x1b[33mPending\x1b[0m   10s", "my-assistant")
    ).toBe("Pending");
  });

  it("exact-matches sandbox name in first column", () => {
    expect(parseSandboxStatus("my-assistant   Ready   2m ago", "my")).toBe(null);
  });

  it("picks correct sandbox from multi-line output", () => {
    const output = [
      "NAME           STATUS              AGE",
      "dev-box        NotReady            5m ago",
      "my-assistant   ContainerCreating   10s ago",
      "staging        Ready               10m ago",
    ].join("\n");
    expect(parseSandboxStatus(output, "my-assistant")).toBe("ContainerCreating");
    expect(parseSandboxStatus(output, "dev-box")).toBe("NotReady");
    expect(parseSandboxStatus(output, "staging")).toBe("Ready");
    expect(parseSandboxStatus(output, "prod")).toBe(null);
  });
});

// Regression tests for issue #397: stale gateway detection before port checks.
// A previous onboard session may leave the gateway container and port forward
// running, causing port-conflict failures on the next onboard invocation.
describe("stale gateway detection", () => {
  it("detects active nemoclaw gateway from real output", () => {
    // Actual output from `openshell gateway info -g nemoclaw` (ANSI stripped)
    const output = [
      "Gateway Info",
      "",
      "  Gateway: nemoclaw",
      "  Gateway endpoint: https://127.0.0.1:8080",
    ].join("\n");
    expect(hasStaleGateway(output)).toBeTruthy();
  });

  it("detects gateway from ANSI-colored output", () => {
    const output =
      "\x1b[1m\x1b[36mGateway Info\x1b[39m\x1b[0m\n\n" +
      "  \x1b[2mGateway:\x1b[0m nemoclaw\n" +
      "  \x1b[2mGateway endpoint:\x1b[0m https://127.0.0.1:8080";
    expect(hasStaleGateway(output)).toBeTruthy();
  });

  it("returns false for empty string (no gateway running)", () => {
    expect(!hasStaleGateway("")).toBeTruthy();
  });

  it("returns false for null/undefined", () => {
    expect(!hasStaleGateway(null)).toBeTruthy();
    expect(!hasStaleGateway(undefined)).toBeTruthy();
  });

  it("returns false for error output without gateway name", () => {
    expect(!hasStaleGateway("Error: no gateway found")).toBeTruthy();
    expect(!hasStaleGateway("connection refused")).toBeTruthy();
  });

  it("returns false for a different gateway name", () => {
    // If someone ran a non-nemoclaw gateway, we should not touch it
    const output = [
      "Gateway Info",
      "",
      "  Gateway: my-other-gateway",
      "  Gateway endpoint: https://127.0.0.1:8080",
    ].join("\n");
    expect(!hasStaleGateway(output)).toBeTruthy();
  });
});
