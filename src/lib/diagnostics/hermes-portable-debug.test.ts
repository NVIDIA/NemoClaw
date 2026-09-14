// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  legacyDebug: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("../adapters/openshell/client", async (original) => ({
  ...(await original<typeof import("../adapters/openshell/client")>()),
  captureOpenshellCommand: mocks.capture,
}));
vi.mock("./debug", async (original) => ({
  ...(await original<typeof import("./debug")>()),
  runDebug: mocks.legacyDebug,
}));

import { loadAgent } from "../agent/defs";
import { createHermesPortableLifecycleTestReceipt } from "../onboard/experimental/hermes-portable-lifecycle.test-fixture";
import { hermesPortableReceiptDirectory } from "../onboard/experimental/hermes-portable-receipt";

import { buildDebugCommandDeps } from "./debug-command-deps";
import { runDebugCommandWithOptions } from "./debug-command";
import { inspectHermesPortableDebugSummary } from "./hermes-portable-debug";

describe("Portable debug", () => {
  let directory: string;
  let receiptDirectory: string;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-debug-test-"));
    vi.stubEnv("HOME", directory);
    const stateDir = path.join(directory, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const policyPath = path.join(directory, "policy.yaml");
    fs.writeFileSync(policyPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
    createHermesPortableLifecycleTestReceipt({
      agent: loadAgent("hermes"),
      stateDir,
      policyPath,
      homeDir: directory,
      sandboxName: "alpha",
      gatewayName: "private-gateway-canary",
      lifecycleGeneration: "private-generation-canary",
      containerId: "a".repeat(64),
      imageDigest: "b".repeat(64),
      sandboxId: "private-sandbox-id",
      labels: { "openshell.managed": "true" },
    });
    receiptDirectory = hermesPortableReceiptDirectory("alpha", stateDir);
    mocks.capture.mockImplementation(() => {
      throw new Error("runtime must remain offline");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("archives only selected retained state while the registry and runtime are unavailable", async () => {
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
      expect(report).not.toContain(directory);
      expect(report).not.toContain("a".repeat(64));
      expect(fs.existsSync(path.join(directory, ".nemoclaw", "sandboxes.json"))).toBe(false);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.legacyDebug).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit Portable selection when the registry has a default sandbox (#11651)", async () => {
    vi.resetModules();
    const { save } = await import("../state/registry/persistence");
    save({
      defaultSandbox: "alpha",
      sandboxes: { alpha: { name: "alpha", agent: "hermes" } },
    });
    const { buildDebugCommandDeps: buildIsolatedDebugCommandDeps } =
      await import("./debug-command-deps");
    const output = path.join(directory, "debug.tar.gz");

    await expect(
      runDebugCommandWithOptions(
        { output },
        { ...buildIsolatedDebugCommandDeps(process.cwd()), env: {} },
      ),
    ).rejects.toThrow("--sandbox NAME");

    expect(fs.existsSync(output)).toBe(false);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.legacyDebug).not.toHaveBeenCalled();
  });

  it("preserves another file when a partial archive symlink already exists (#11651)", async () => {
    const output = path.join(directory, "debug.tar.gz");
    const victim = path.join(directory, "user-data.txt");
    const partial = `${output}.partial.${process.pid}`;
    const contents = "preserve this unrelated user data";
    fs.writeFileSync(victim, contents);
    fs.symlinkSync(victim, partial);

    await runDebugCommandWithOptions(
      { sandboxName: "alpha", output },
      buildDebugCommandDeps(process.cwd()),
    );

    expect(fs.readFileSync(victim, "utf8")).toBe(contents);
    expect(fs.lstatSync(partial).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(output).isFile()).toBe(true);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    const entries = execFileSync("tar", ["tzf", output], { encoding: "utf8" });
    expect(entries).toContain("/portable-lifecycle.json");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.legacyDebug).not.toHaveBeenCalled();
  });

  it("refuses malformed selected authority before creating output", async () => {
    const output = path.join(directory, "debug.tar.gz");
    fs.writeFileSync(path.join(receiptDirectory, "active.json"), "{invalid json", { mode: 0o600 });
    await expect(
      runDebugCommandWithOptions(
        { sandboxName: "alpha", output },
        buildDebugCommandDeps(process.cwd()),
      ),
    ).rejects.toThrow("is malformed or is not strict UTF-8");
    expect(fs.existsSync(output)).toBe(false);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.legacyDebug).not.toHaveBeenCalled();
  });

  it("retains the host guard before entering legacy collection for another sandbox", () => {
    expect(() => buildDebugCommandDeps(process.cwd()).runDebug({ sandboxName: "beta" })).toThrow(
      /Portable|portable/,
    );
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.legacyDebug).not.toHaveBeenCalled();
  });

  it("reports a pending receipt without claiming registry publication or live health", () => {
    // Retain the valid pending phase and its durable policy, before later phases exist.
    fs.unlinkSync(path.join(receiptDirectory, "active.json"));
    fs.unlinkSync(path.join(receiptDirectory, "configuring.json"));
    expect(inspectHermesPortableDebugSummary("alpha")?.report).toMatchObject({
      savedLifecyclePhase: "pending",
      runtimeHealth: "not-probed",
      agentHealth: "not-probed",
    });
  });
});
