// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disposition: vi.fn(),
  legacyDebug: vi.fn(),
  guard: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("../onboard/experimental/hermes-portable-receipt", async (original) => ({
  ...(await original<typeof import("../onboard/experimental/hermes-portable-receipt")>()),
  inspectPortableAgentReceiptAuthorityForClassification: mocks.disposition,
}));
vi.mock("../state/portable-uninstall-retirement", async (original) => ({
  ...(await original<typeof import("../state/portable-uninstall-retirement")>()),
  assertNoHermesPortableHostAuthority: mocks.guard,
}));
vi.mock("../adapters/openshell/client", async (original) => ({
  ...(await original<typeof import("../adapters/openshell/client")>()),
  captureOpenshellCommand: mocks.capture,
}));
vi.mock("./debug", async (original) => ({
  ...(await original<typeof import("./debug")>()),
  runDebug: mocks.legacyDebug,
}));

import { buildDebugCommandDeps } from "./debug-command-deps";
import { runDebugCommandWithOptions } from "./debug-command";
import { inspectHermesPortableDebugSummary } from "./hermes-portable-debug";

describe("Portable debug", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.disposition.mockReturnValue({
      kind: "hermes",
      snapshot: {
        receipt: {
          phase: "active",
          gatewayName: "private-gateway-canary",
          lifecycleGeneration: "private-generation-canary",
          liveIdentityFingerprint: "private-identity-canary",
        },
      },
    });
    mocks.capture.mockImplementation(() => {
      throw new Error("runtime must remain offline");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("archives only selected retained state while the registry and runtime are unavailable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-debug-test-"));
    const output = path.join(directory, "debug.tar.gz");
    try {
      await runDebugCommandWithOptions(
        { sandboxName: "alpha", output },
        buildDebugCommandDeps(process.cwd()),
      );
      const entries = execFileSync("tar", ["tzf", output], { encoding: "utf8" }).trim().split("\n");
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatch(/\/portable-lifecycle\.json$/);
      const report = execFileSync("tar", ["xOzf", output, entries[1]!], { encoding: "utf8" });
      expect(JSON.parse(report)).toEqual({
        schemaVersion: 1,
        sandboxName: "alpha",
        agent: "hermes",
        savedLifecyclePhase: "active",
        runtimeHealth: "not-probed",
        agentHealth: "not-probed",
      });
      expect(report).not.toContain("private-");
      expect(mocks.disposition).toHaveBeenCalledWith("alpha", expect.any(String));
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.legacyDebug).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses malformed selected authority before creating output", async () => {
    mocks.disposition.mockImplementation(() => {
      throw new Error("invalid selected receipt");
    });
    await expect(
      runDebugCommandWithOptions({ sandboxName: "beta" }, buildDebugCommandDeps(process.cwd())),
    ).rejects.toThrow("invalid selected receipt");
    expect(mocks.disposition).toHaveBeenCalledWith("beta", expect.any(String));
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.legacyDebug).not.toHaveBeenCalled();
  });

  it("retains the host guard before entering legacy collection for another sandbox", () => {
    mocks.disposition.mockReturnValue({ kind: "none" });
    mocks.guard.mockImplementation(() => {
      throw new Error("Portable authority exists");
    });
    expect(() => buildDebugCommandDeps(process.cwd()).runDebug({ sandboxName: "beta" })).toThrow(
      "Portable authority exists",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.legacyDebug).not.toHaveBeenCalled();
  });

  it("reports a pending receipt without claiming registry publication or live health", () => {
    mocks.disposition.mockReturnValue({
      kind: "hermes",
      snapshot: {
        receipt: {
          phase: "pending",
          gatewayName: "gateway-alpha",
        },
      },
    });
    expect(inspectHermesPortableDebugSummary("alpha")?.report).toMatchObject({
      savedLifecyclePhase: "pending",
      runtimeHealth: "not-probed",
      agentHealth: "not-probed",
    });
  });
});
