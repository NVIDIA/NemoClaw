// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifyGatewayStartFailure } from "../validation";
import { normalizeGatewayStartError, printDockerDaemonRecovery } from "./gateway-start-failure";

describe("normalizeGatewayStartError", () => {
  it("preserves the original deadline-aware Error instance (#3768)", () => {
    const deadlineError = new Error("Gateway failed within 10s.");

    expect(normalizeGatewayStartError(deadlineError)).toBe(deadlineError);
  });

  it.each([
    ["string", "connection refused", "connection refused"],
    ["number", 500, "500"],
  ])("wraps a thrown %s without losing its message (#3768)", (_kind, thrown, message) => {
    const normalized = normalizeGatewayStartError(thrown);

    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe(message);
  });
});

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

  it("classifies a gateway database migration absent from installed OpenShell as incompatible (#8797)", () => {
    const output = [
      "Error: execution error: migration error: migration 6 was previously applied",
      "  is missing in the resolved migrations",
    ].join("\n");

    expect(classifyGatewayStartFailure(output)).toEqual({
      kind: "database_migration_incompatible",
    });
  });

  it("classifies a modified applied migration as an incompatible database (#9293)", () => {
    const output = [
      "Error:   × execution error: migration error: migration 4 was previously applied but",
      "  │ has been modified",
    ].join("\n");

    expect(classifyGatewayStartFailure(output)).toEqual({
      kind: "database_migration_incompatible",
    });
  });

  it("does not classify an on-disk migration-file edit as incompatible database state (#9293)", () => {
    const output = "the file containing migration 6 has been modified on disk";

    expect(classifyGatewayStartFailure(output)).toEqual({ kind: "unknown" });
  });

  it("does not classify an unrelated SQLite migration failure as incompatible database state (#8797)", () => {
    const output = "database is locked while applying migration 6";

    expect(classifyGatewayStartFailure(output)).toEqual({ kind: "unknown" });
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

describe("printDockerDaemonRecovery", () => {
  it.each([
    ["darwin", "colima start", "systemctl"],
    ["linux", "sudo systemctl start docker", "colima start"],
    ["win32", "Start the Docker daemon", "systemctl"],
  ] as const)("prints the %s recovery command", (platform, expected, excluded) => {
    const printed: string[] = [];

    printDockerDaemonRecovery((message = "") => printed.push(message), platform);

    const output = printed.join("\n");
    expect(output).toContain("Docker daemon is not running");
    expect(output).toContain(expected);
    expect(output).not.toContain(excluded);
  });

  it("prints the rootless Podman resume command for the portable profile (#9035)", () => {
    const printed: string[] = [];

    printDockerDaemonRecovery((message = "") => printed.push(message), "linux", true);

    const output = printed.join("\n");
    expect(output).toContain("rootless Podman API service is not reachable");
    expect(output).toContain("Start Podman");
    expect(output).toContain("nemoclaw onboard --resume");
    expect(output).not.toContain("sudo systemctl start docker");
  });
});
