// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

type RebuildFlowHelpersModule = typeof import("./rebuild-flow-helpers");
type SandboxStateModule = typeof import("../../state/sandbox");
type UserManagedFilesProbeModule = typeof import("../../state/user-managed-files-probe");

const requireDist = createRequire(import.meta.url);
const rebuildFlowHelpersPath = "./rebuild-flow-helpers.js";
const sandboxStatePath = "../../state/sandbox.js";
const userManagedFilesProbePath = "../../state/user-managed-files-probe.js";

function loadRebuildFlowHelpers(): RebuildFlowHelpersModule {
  delete require.cache[requireDist.resolve(rebuildFlowHelpersPath)];
  return requireDist(rebuildFlowHelpersPath);
}

// Warm the CommonJS dependency graph outside the first test's timeout. Tests
// still reload this entry module after installing dependency spies.
loadRebuildFlowHelpers();
delete require.cache[requireDist.resolve(rebuildFlowHelpersPath)];

function loadSandboxState(): SandboxStateModule {
  return requireDist(sandboxStatePath);
}

function loadUserManagedFilesProbe(): UserManagedFilesProbeModule {
  return requireDist(userManagedFilesProbePath);
}

function makeBackupResult(): ReturnType<SandboxStateModule["backupSandboxState"]> {
  return {
    success: true,
    backedUpDirs: [".state"],
    backedUpFiles: ["config.toml"],
    failedDirs: [],
    failedFiles: [],
    manifest: {
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-06-01T00-00-00-000Z",
      agentType: "langchain-deepagents-code",
      agentVersion: null,
      expectedVersion: "0.1.30",
      stateDirs: [".state"],
      backedUpDirs: [".state"],
      stateFiles: [{ path: "config.toml", strategy: "copy" }],
      dir: "/sandbox/.deepagents",
      backupPath: "/tmp/nemoclaw-rebuild-backup",
      blueprintDigest: null,
      policyPresets: [],
      customPolicies: [],
    } as ReturnType<SandboxStateModule["backupSandboxState"]>["manifest"],
  };
}

function makeSandboxEntry(): Parameters<
  RebuildFlowHelpersModule["backupSandboxStateForRebuild"]
>[1] {
  return {
    name: "alpha",
    agent: "langchain-deepagents-code",
    provider: null,
    model: null,
    policies: [],
    customPolicies: [],
    nimContainer: null,
  } as unknown as Parameters<RebuildFlowHelpersModule["backupSandboxStateForRebuild"]>[1];
}

function makeBail(): (msg: string, code?: number) => never {
  return (msg: string) => {
    throw new Error(`bail: ${msg}`);
  };
}

describe("rebuild target gateway preflight", () => {
  const priorGateway = process.env.OPENSHELL_GATEWAY;

  afterEach(() => {
    vi.restoreAllMocks();
    switch (priorGateway) {
      case undefined:
        delete process.env.OPENSHELL_GATEWAY;
        break;
      default:
        process.env.OPENSHELL_GATEWAY = priorGateway;
    }
  });

  it("health-checks and pins the sandbox's persisted gateway", async () => {
    const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
    const recover = vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: true,
      before: { state: "connected_other" },
      after: { state: "healthy_named" },
      attempted: true,
    });
    const { ensureRebuildTargetGatewaySelected } = loadRebuildFlowHelpers();

    await expect(
      ensureRebuildTargetGatewaySelected(
        "alpha",
        { name: "alpha", gatewayName: "nemoclaw-19080", gatewayPort: 19080 },
        () => undefined,
        makeBail(),
      ),
    ).resolves.toBe(true);

    expect(recover).toHaveBeenCalledWith({ gatewayName: "nemoclaw-19080" });
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-19080");
  });

  it("fails closed when the target gateway cannot become healthy", async () => {
    const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
    vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: false,
      before: { state: "connected_other" },
      after: { state: "missing_named" },
      attempted: true,
    });
    const { ensureRebuildTargetGatewaySelected } = loadRebuildFlowHelpers();

    await expect(
      ensureRebuildTargetGatewaySelected(
        "alpha",
        { name: "alpha", gatewayName: "nemoclaw-19080", gatewayPort: 19080 },
        () => undefined,
        makeBail(),
      ),
    ).rejects.toThrow("Could not select healthy gateway 'nemoclaw-19080'");
  });
});

describe("rebuild agent base image preflight", () => {
  const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
  let priorOverride: string | undefined;

  beforeEach(() => {
    priorOverride = process.env[overrideEnvVar];
    delete process.env[overrideEnvVar];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const original = priorOverride;
    const restoreOverride =
      original === undefined
        ? () => Reflect.deleteProperty(process.env, overrideEnvVar)
        : () => Reflect.set(process.env, overrideEnvVar, original);
    restoreOverride();
  });

  function mockBaseImagePreflight(imageRef: string) {
    const agentDefs = requireDist("../../agent/defs.js");
    const agentOnboard = requireDist("../../agent/onboard.js");
    vi.spyOn(agentDefs, "loadAgent").mockReturnValue({ name: "hermes" });
    const ensureAgentBaseImage = vi
      .spyOn(agentOnboard, "ensureAgentBaseImage")
      .mockReturnValue({ imageTag: imageRef, built: true });
    const pinAgentSandboxBaseImageRef = vi
      .spyOn(agentOnboard, "pinAgentSandboxBaseImageRef")
      .mockImplementation((_agentName, ref) => String(ref));
    return { ensureAgentBaseImage, pinAgentSandboxBaseImageRef };
  }

  it("forces a repository-local build and returns its exact ref when no override exists", () => {
    const imageRef = "nemoclaw-hermes-sandbox-base-local:12345678";
    const { ensureAgentBaseImage } = mockBaseImagePreflight(imageRef);
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    const result = ensureRebuildAgentBaseImage("hermes", makeBail());

    expect(ensureAgentBaseImage).toHaveBeenCalledWith(expect.objectContaining({ name: "hermes" }), {
      forceBaseImageRebuild: true,
    });
    expect(result).toEqual({ ok: true, imageRef, overrideEnvVar });
  });

  it("resolves an explicit caller override instead of replacing it during preflight", () => {
    process.env[overrideEnvVar] = "nemoclaw-hermes-sandbox-base-local:caller";
    const mutableRef = "nemoclaw-hermes-sandbox-base-local:resolved";
    const immutableRef = `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`;
    const { ensureAgentBaseImage, pinAgentSandboxBaseImageRef } =
      mockBaseImagePreflight(mutableRef);
    pinAgentSandboxBaseImageRef.mockReturnValue(immutableRef);
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    const result = ensureRebuildAgentBaseImage("hermes", makeBail());

    expect(ensureAgentBaseImage).toHaveBeenCalledWith(expect.objectContaining({ name: "hermes" }), {
      forceBaseImageRebuild: false,
    });
    expect(pinAgentSandboxBaseImageRef).toHaveBeenCalledWith("hermes", mutableRef);
    expect(result).toEqual({ ok: true, imageRef: immutableRef, overrideEnvVar });
  });

  it("pins the preflighted ref only for recreation and restores caller state", () => {
    const { pinRebuildAgentBaseImageForRecreate } = loadRebuildFlowHelpers();
    const env: NodeJS.ProcessEnv = {
      [overrideEnvVar]: "nemoclaw-hermes-sandbox-base-local:image-caller",
    };
    const restore = pinRebuildAgentBaseImageForRecreate(
      {
        ok: true,
        imageRef: "nemoclaw-hermes-sandbox-base-local:image-resolved",
        overrideEnvVar,
      },
      env,
    );

    expect(env[overrideEnvVar]).toBe("nemoclaw-hermes-sandbox-base-local:image-resolved");
    restore();
    expect(env[overrideEnvVar]).toBe("nemoclaw-hermes-sandbox-base-local:image-caller");
    restore();
    expect(env[overrideEnvVar]).toBe("nemoclaw-hermes-sandbox-base-local:image-caller");
  });

  it("removes a scoped recreation pin when the caller had no override", () => {
    const { pinRebuildAgentBaseImageForRecreate } = loadRebuildFlowHelpers();
    const env: NodeJS.ProcessEnv = {};
    const restore = pinRebuildAgentBaseImageForRecreate(
      {
        ok: true,
        imageRef: "nemoclaw-hermes-sandbox-base-local:12345678",
        overrideEnvVar,
      },
      env,
    );

    expect(env[overrideEnvVar]).toBe("nemoclaw-hermes-sandbox-base-local:12345678");
    restore();
    expect(Object.hasOwn(env, overrideEnvVar)).toBe(false);
  });
});

describe("warnUnpreservedUserManagedFiles", () => {
  let warnSpy: MockInstance;
  let logSpy: MockInstance;
  let errorSpy: MockInstance;
  let backupSpy: MockInstance;
  let probeSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const sandboxState = loadSandboxState();
    backupSpy = vi.spyOn(sandboxState, "backupSandboxState").mockReturnValue(makeBackupResult());
    const probeModule = loadUserManagedFilesProbe();
    probeSpy = vi.spyOn(probeModule, "probeUserManagedFiles").mockReturnValue({
      declared: [],
      existing: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns directly before a rebuild replaces user-managed MCP files", () => {
    probeSpy.mockReturnValue({
      declared: [".env", ".mcp.json"],
      existing: [".env", ".mcp.json"],
    });

    const { warnUnpreservedUserManagedFiles } = loadRebuildFlowHelpers();
    warnUnpreservedUserManagedFiles("alpha", () => undefined);

    expect(probeSpy).toHaveBeenCalledOnce();
    expect(probeSpy).toHaveBeenCalledWith("alpha");

    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      warnLines.some((line: string) => line.includes("will not be preserved if rebuild replaces")),
    ).toBe(true);
    expect(warnLines.some((line: string) => line.includes(".env, .mcp.json"))).toBe(true);
    expect(warnLines.some((line: string) => line.includes("After a successful rebuild"))).toBe(
      true,
    );
  });

  it("emits no warning when probe returns no existing user-managed files", () => {
    probeSpy.mockReturnValue({
      declared: [".env", ".mcp.json"],
      existing: [],
    });

    const { warnUnpreservedUserManagedFiles } = loadRebuildFlowHelpers();
    warnUnpreservedUserManagedFiles("alpha", () => undefined);

    expect(probeSpy).toHaveBeenCalledOnce();
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("will not be preserved"))).toBe(false);
  });

  it("emits no warning when agent declares no user-managed files", () => {
    probeSpy.mockReturnValue({ declared: [], existing: [] });

    const { warnUnpreservedUserManagedFiles } = loadRebuildFlowHelpers();
    warnUnpreservedUserManagedFiles("alpha", () => undefined);

    expect(probeSpy).toHaveBeenCalledOnce();
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("will not be preserved"))).toBe(false);
  });

  it("skips probe when staleRecovery short-circuits the backup", () => {
    const { backupSandboxStateForRebuild } = loadRebuildFlowHelpers();
    const result = backupSandboxStateForRebuild(
      "alpha",
      makeSandboxEntry(),
      true,
      () => undefined,
      () => true,
      makeBail(),
    );

    expect(result).toBeNull();
    expect(backupSpy).not.toHaveBeenCalled();
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("does not probe during backup before managed MCP adapter entries are scrubbed", () => {
    const { backupSandboxStateForRebuild } = loadRebuildFlowHelpers();
    const result = backupSandboxStateForRebuild(
      "alpha",
      makeSandboxEntry(),
      false,
      () => undefined,
      () => true,
      makeBail(),
    );

    expect(result).toBeTruthy();
    expect(backupSpy).toHaveBeenCalledOnce();
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("surfaces a user-visible warning when the post-scrub probe errors", () => {
    probeSpy.mockImplementation(() => {
      throw new Error("ssh boom");
    });

    const { warnUnpreservedUserManagedFiles } = loadRebuildFlowHelpers();
    expect(() => warnUnpreservedUserManagedFiles("alpha", () => undefined)).not.toThrow();

    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      warnLines.some((line: string) =>
        line.includes("Could not check declared user-managed files"),
      ),
    ).toBe(true);
    expect(warnLines.some((line: string) => line.includes("Re-add any user-managed files"))).toBe(
      true,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
