// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { classifyGatewayStartFailure } from "../validation";
import { reportLegacyGatewayStartResultFailure } from "./gateway-start-failure";

describe("classifyGatewayStartFailure", () => {
  // Regression: NemoClaw #2347. When Colima is stopped on macOS, the
  // openshell gateway-start stream prints "Failed to create Docker client.
  // Socket not found: /var/run/docker.sock" before exiting non-zero. Onboard
  // must short-circuit the retry loop with an actionable message instead of
  // burning ~15 minutes on health polls against a dead socket.
  it("detects colima-stopped signature on macOS (Socket not found)", () => {
    const output = [
      "  Error: Failed to create Docker client.",
      "  Socket not found: /var/run/docker.sock",
    ].join("\n");
    expect(classifyGatewayStartFailure(output)).toEqual({ kind: "docker_unreachable" });
  });

  it("detects dockerd-stopped signature on Linux (Cannot connect to the Docker daemon)", () => {
    const output =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    expect(classifyGatewayStartFailure(output)).toEqual({ kind: "docker_unreachable" });
  });

  it("detects the standalone 'Failed to create Docker client' error marker", () => {
    expect(classifyGatewayStartFailure("Failed to create Docker client")).toEqual({
      kind: "docker_unreachable",
    });
  });

  it("does not match historical mentions of 'Failed to create Docker client'", () => {
    const output =
      "client created successfully; previous Failed to create Docker client issue fixed";
    expect(classifyGatewayStartFailure(output)).toEqual({ kind: "unknown" });
  });

  it("detects free-form 'docker daemon is not running' wording", () => {
    expect(classifyGatewayStartFailure("the docker daemon is not running on this host")).toEqual({
      kind: "docker_unreachable",
    });
  });

  it("returns unknown for healthy-but-slow output (should not short-circuit)", () => {
    // Real output seen during a slow first-time k3s bootstrap — the retry
    // loop must stay engaged for these, so we must not misclassify them.
    const output = [
      "Applying HelmChart openshell",
      "openshell-0 still starting",
      "Observed pod startup duration 90s",
    ].join("\n");
    expect(classifyGatewayStartFailure(output)).toEqual({ kind: "unknown" });
  });

  it("returns unknown for empty or missing output", () => {
    expect(classifyGatewayStartFailure("")).toEqual({ kind: "unknown" });
    expect(classifyGatewayStartFailure()).toEqual({ kind: "unknown" });
  });
});

describe("reportLegacyGatewayStartResultFailure", () => {
  it("classifies Docker-unreachable output after stripping ANSI sequences (#2347)", () => {
    const log = vi.fn();
    const output = [
      "\x1b[31mError: Failed to create Docker client.\x1b[0m",
      "\x1b[33mSocket not found: /var/run/docker.sock\x1b[0m",
    ].join("\n");

    expect(reportLegacyGatewayStartResultFailure(output, log)).toEqual({
      kind: "docker_unreachable",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Gateway start returned before healthy"),
    );
    expect(log.mock.calls[0][0]).not.toContain("\x1b");
  });
});
