// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Channel-layer lifecycle contract: every policy mutator that succeeds must
 * call refreshSandboxPolicyContextFile once with the sandbox name, and every
 * mutator that fails or short-circuits (dry-run, unknown preset, declined
 * confirm, apply/remove returns false) must skip the refresh.
 *
 * This pins the caller/callee contract between policy-channel and
 * policy-context-refresh so a future mutator added to the channel cannot
 * silently let the in-sandbox POLICY.md drift.
 */

import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const D = (p: string) => requireDist(`../../../../dist/lib/${p}`);

type PresetInfo = { name: string };

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const store = D("credentials/store.js");
const registry = D("state/registry.js");
const onboardSession = D("state/onboard-session.js");
const policies = D("policy/index.js");
const policyContextRefresh = D("actions/sandbox/policy-context-refresh.js");
const {
  addSandboxPolicy,
  removeSandboxPolicy,
  applyChannelPresetIfAvailable,
  removeChannelPresetIfPresent,
} = D("actions/sandbox/policy-channel.js") as {
  addSandboxPolicy: (sandboxName: string, options?: Record<string, unknown>) => Promise<void>;
  removeSandboxPolicy: (sandboxName: string, options?: Record<string, unknown>) => Promise<void>;
  applyChannelPresetIfAvailable: (sandboxName: string, channelName: string) => boolean;
  removeChannelPresetIfPresent: (sandboxName: string, channelName: string) => void;
};

const POLICY_PRESETS: PresetInfo[] = [{ name: "npm" }, { name: "pypi" }, { name: "discord" }];

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;
let refreshSpy: MockInstance;
let applyPresetMock: MockInstance;
let removePresetMock: MockInstance;
let applyPresetContentMock: MockInstance;
let loadPresetFromFileMock: MockInstance;

async function captureExit(action: () => Promise<void>): Promise<number | undefined> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  }
  throw new Error("Expected process.exit to be called");
}

beforeEach(() => {
  delete process.env.NEMOCLAW_NON_INTERACTIVE;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);

  vi.spyOn(store, "prompt").mockResolvedValue("y");
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "alpha",
    agent: null,
    policies: ["pypi"],
  });
  vi.spyOn(registry, "getCustomPolicies").mockReturnValue([]);

  vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
  vi.spyOn(onboardSession, "updateSession").mockImplementation(() => undefined);

  vi.spyOn(policies, "listPresets").mockReturnValue(POLICY_PRESETS);
  vi.spyOn(policies, "listCustomPresets").mockReturnValue([]);
  vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
  vi.spyOn(policies, "selectFromList").mockResolvedValue("pypi");
  vi.spyOn(policies, "selectForRemoval").mockResolvedValue("pypi");
  vi.spyOn(policies, "loadPreset").mockImplementation((name: unknown) => {
    return `network_policies:\n  ${String(name)}:\n    host: ${String(name)}.example.com\n`;
  });
  applyPresetMock = vi.spyOn(policies, "applyPreset").mockReturnValue(true);
  removePresetMock = vi.spyOn(policies, "removePreset").mockReturnValue(true);
  applyPresetContentMock = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
  loadPresetFromFileMock = vi.spyOn(policies, "loadPresetFromFile").mockImplementation(() => ({
    presetName: "custom",
    content: "network_policies:\n  custom:\n    host: custom.example.com\n",
  }));
  vi.spyOn(policies, "getPresetEndpoints").mockReturnValue(["host.example.com"]);
  vi.spyOn(policies, "getPresetValidationWarning").mockReturnValue(null);

  refreshSpy = vi
    .spyOn(policyContextRefresh, "refreshSandboxPolicyContextFile")
    .mockReturnValue({ outcome: "ok", written: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
});

describe("addSandboxPolicy refresh contract", () => {
  it("refreshes the in-sandbox POLICY.md after a successful built-in apply", async () => {
    await addSandboxPolicy("alpha", { preset: "pypi", yes: true });

    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "pypi");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("alpha");
  });

  it("does not refresh on --dry-run because the registry was never mutated", async () => {
    await addSandboxPolicy("alpha", { preset: "pypi", yes: true, dryRun: true });

    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when interactive confirmation is declined", async () => {
    vi.spyOn(store, "prompt").mockResolvedValue("n");

    await addSandboxPolicy("alpha");

    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when the policy library reports apply failure", async () => {
    applyPresetMock.mockReturnValue(false);

    await expect(
      captureExit(() => addSandboxPolicy("alpha", { preset: "pypi", yes: true })),
    ).resolves.toBe(1);

    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "pypi");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when the preset name is unknown", async () => {
    await expect(
      captureExit(() => addSandboxPolicy("alpha", { preset: "nonexistent", yes: true })),
    ).resolves.toBe(1);

    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("applyExternalPreset refresh contract (--from-file)", () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-refresh-"));
    tempFile = path.join(tempDir, "preset.yaml");
    fs.writeFileSync(tempFile, "network_policies:\n  custom:\n    host: custom.example.com\n");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("refreshes after a successful custom-preset apply via --from-file", async () => {
    await addSandboxPolicy("alpha", { fromFile: tempFile, yes: true });

    expect(loadPresetFromFileMock).toHaveBeenCalled();
    expect(applyPresetContentMock).toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("alpha");
  });

  it("does not refresh when applyPresetContent reports failure", async () => {
    applyPresetContentMock.mockReturnValue(false);

    await expect(
      captureExit(() => addSandboxPolicy("alpha", { fromFile: tempFile, yes: true })),
    ).resolves.toBe(1);

    expect(applyPresetContentMock).toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh on --dry-run with --from-file", async () => {
    await addSandboxPolicy("alpha", { fromFile: tempFile, yes: true, dryRun: true });

    expect(applyPresetContentMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("removeSandboxPolicy refresh contract", () => {
  beforeEach(() => {
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["pypi"]);
  });

  it("refreshes the in-sandbox POLICY.md after a successful removal", async () => {
    await removeSandboxPolicy("alpha", { preset: "pypi", yes: true });

    expect(removePresetMock).toHaveBeenCalledWith("alpha", "pypi");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("alpha");
  });

  it("does not refresh on --dry-run", async () => {
    await removeSandboxPolicy("alpha", { preset: "pypi", yes: true, dryRun: true });

    expect(removePresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when interactive confirmation is declined", async () => {
    vi.spyOn(store, "prompt").mockResolvedValue("n");

    await removeSandboxPolicy("alpha");

    expect(removePresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when the policy library reports remove failure", async () => {
    removePresetMock.mockReturnValue(false);

    await expect(
      captureExit(() => removeSandboxPolicy("alpha", { preset: "pypi", yes: true })),
    ).resolves.toBe(1);

    expect(removePresetMock).toHaveBeenCalledWith("alpha", "pypi");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when the preset is not currently applied", async () => {
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);

    await expect(
      captureExit(() => removeSandboxPolicy("alpha", { preset: "pypi", yes: true })),
    ).resolves.toBe(1);

    expect(removePresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("applyChannelPresetIfAvailable refresh contract", () => {
  it("refreshes once after a successful channel preset apply", () => {
    const ok = applyChannelPresetIfAvailable("alpha", "discord");

    expect(ok).toBe(true);
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "discord");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("alpha");
  });

  it("does not refresh when policy library reports apply failure", () => {
    applyPresetMock.mockReturnValue(false);

    const ok = applyChannelPresetIfAvailable("alpha", "discord");

    expect(ok).toBe(false);
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "discord");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when policy library throws", () => {
    applyPresetMock.mockImplementation(() => {
      throw new Error("preset YAML missing");
    });

    const ok = applyChannelPresetIfAvailable("alpha", "discord");

    expect(ok).toBe(false);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("removeChannelPresetIfPresent refresh contract", () => {
  it("refreshes once after a successful built-in channel preset removal", () => {
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["discord"]);

    removeChannelPresetIfPresent("alpha", "discord");

    expect(removePresetMock).toHaveBeenCalledWith("alpha", "discord");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("alpha");
  });

  it("does not refresh when the channel is not a built-in preset", () => {
    removeChannelPresetIfPresent("alpha", "totally-not-a-preset");

    expect(removePresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when the built-in preset is not currently applied", () => {
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);

    removeChannelPresetIfPresent("alpha", "discord");

    expect(removePresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when policy library reports remove failure", () => {
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["discord"]);
    removePresetMock.mockReturnValue(false);

    removeChannelPresetIfPresent("alpha", "discord");

    expect(removePresetMock).toHaveBeenCalledWith("alpha", "discord");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not refresh when policy library throws", () => {
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["discord"]);
    removePresetMock.mockImplementation(() => {
      throw new Error("preset removal racing with rebuild");
    });

    removeChannelPresetIfPresent("alpha", "discord");

    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
