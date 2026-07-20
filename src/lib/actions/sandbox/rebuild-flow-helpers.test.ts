// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as agentDefs from "../../agent/defs";
import * as agentOnboard from "../../agent/onboard";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as sandboxState from "../../state/sandbox";
import * as userManagedFilesProbe from "../../state/user-managed-files-probe";
import {
  backupSandboxStateForRebuild,
  ensureRebuildAgentBaseImage,
  ensureRebuildTargetGatewaySelected,
  pinRebuildAgentBaseImageForRecreate,
  warnUnpreservedUserManagedFiles,
} from "./rebuild-flow-helpers";

function makeBackupResult(): Awaited<ReturnType<typeof sandboxState.backupSandboxState>> {
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
      expectedVersion: "0.1.34",
      stateDirs: [".state"],
      backedUpDirs: [".state"],
      stateFiles: [{ path: "config.toml", strategy: "copy" }],
      dir: "/sandbox/.deepagents",
      backupPath: "/tmp/nemoclaw-rebuild-backup",
      blueprintDigest: null,
      policyPresets: [],
      customPolicies: [],
    } as Awaited<ReturnType<typeof sandboxState.backupSandboxState>>["manifest"],
  };
}

function makeSandboxEntry(): Parameters<typeof backupSandboxStateForRebuild>[1] {
  return {
    name: "alpha",
    agent: "langchain-deepagents-code",
    provider: null,
    model: null,
    policies: [],
    customPolicies: [],
    nimContainer: null,
  } satisfies Parameters<typeof backupSandboxStateForRebuild>[1];
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
    const recover = vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: true,
      before: { state: "connected_other", status: "", gatewayInfo: "", activeGateway: null },
      after: { state: "healthy_named", status: "", gatewayInfo: "", activeGateway: null },
      attempted: true,
    });

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
    vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: false,
      before: { state: "connected_other", status: "", gatewayInfo: "", activeGateway: null },
      after: { state: "missing_named", status: "", gatewayInfo: "", activeGateway: null },
      attempted: true,
    });

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
    vi.spyOn(agentDefs, "loadAgent").mockReturnValue({ name: "hermes" } as never);
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

    const result = ensureRebuildAgentBaseImage("hermes", makeBail());

    expect(ensureAgentBaseImage).toHaveBeenCalledWith(expect.objectContaining({ name: "hermes" }), {
      forceBaseImageRebuild: false,
    });
    expect(pinAgentSandboxBaseImageRef).toHaveBeenCalledWith("hermes", mutableRef);
    expect(result).toEqual({ ok: true, imageRef: immutableRef, overrideEnvVar });
  });

  it("pins the preflighted ref only for recreation and restores caller state", () => {
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

describe("backupSandboxStateForRebuild with --force", () => {
  let warnSpy: MockInstance;
  let errorSpy: MockInstance;
  let backupSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    backupSpy = vi.spyOn(sandboxState, "backupSandboxState");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null (skip) when backup fails completely and force is set", async () => {
    backupSpy.mockResolvedValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".state"],
      failedFiles: ["config.toml"],
      manifest: null,
    });
    const result = await backupSandboxStateForRebuild(
      "alpha",
      makeSandboxEntry(),
      false,
      () => undefined,
      () => true,
      makeBail(),
      { force: true },
    );

    expect(result).toBeNull();
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("--force was specified"))).toBe(true);
  });

  it("aborts with hint when backup fails completely without force", async () => {
    backupSpy.mockResolvedValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".state"],
      failedFiles: [],
      manifest: null,
    });
    await expect(
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        () => true,
        makeBail(),
      ),
    ).rejects.toThrow("bail: Failed to back up sandbox state.");

    const errorLines = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(errorLines.some((line: string) => line.includes("rebuild --force"))).toBe(true);
  });

  it("aborts without force even when force option is explicitly false", async () => {
    backupSpy.mockResolvedValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".state"],
      failedFiles: [],
      manifest: null,
    });
    await expect(
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        () => true,
        makeBail(),
        { force: false },
      ),
    ).rejects.toThrow("bail: Failed to back up sandbox state.");
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

    backupSpy = vi.spyOn(sandboxState, "backupSandboxState").mockResolvedValue(makeBackupResult());
    probeSpy = vi.spyOn(userManagedFilesProbe, "probeUserManagedFiles").mockResolvedValue({
      declared: [],
      existing: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns directly before a rebuild replaces user-managed MCP files", async () => {
    probeSpy.mockResolvedValue({
      declared: [".env", ".mcp.json"],
      existing: [".env", ".mcp.json"],
    });

    await warnUnpreservedUserManagedFiles("alpha", () => undefined);

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

  it("emits no warning when probe returns no existing user-managed files", async () => {
    probeSpy.mockResolvedValue({
      declared: [".env", ".mcp.json"],
      existing: [],
    });

    await warnUnpreservedUserManagedFiles("alpha", () => undefined);

    expect(probeSpy).toHaveBeenCalledOnce();
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("will not be preserved"))).toBe(false);
  });

  it("emits no warning when agent declares no user-managed files", async () => {
    probeSpy.mockResolvedValue({ declared: [], existing: [] });

    await warnUnpreservedUserManagedFiles("alpha", () => undefined);

    expect(probeSpy).toHaveBeenCalledOnce();
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("will not be preserved"))).toBe(false);
  });

  it("skips probe when staleRecovery short-circuits the backup", async () => {
    const result = await backupSandboxStateForRebuild(
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

  it("does not probe during backup before managed MCP adapter entries are scrubbed", async () => {
    const result = await backupSandboxStateForRebuild(
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

  it("surfaces a user-visible warning when the post-scrub probe errors", async () => {
    probeSpy.mockRejectedValue(new Error("gRPC boom"));

    await expect(
      warnUnpreservedUserManagedFiles("alpha", () => undefined),
    ).resolves.toBeUndefined();

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

  it("surfaces the backup failure reason before aborting", async () => {
    backupSpy.mockResolvedValue({
      ...makeBackupResult(),
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".state"],
      failedFiles: ["config.toml"],
      error: "Pre-backup audit rejected an unsafe symlink",
    });

    await expect(
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        () => true,
        makeBail(),
      ),
    ).rejects.toThrow("bail: Failed to back up sandbox state.");

    const errorLines = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(errorLines).toContain("  Reason: Pre-backup audit rejected an unsafe symlink");
  });
});
