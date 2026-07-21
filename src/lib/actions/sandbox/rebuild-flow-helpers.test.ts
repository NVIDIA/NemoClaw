// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as dockerImage from "../../adapters/docker/image";
import * as agentDefs from "../../agent/defs";
import * as agentOnboard from "../../agent/onboard";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as sandboxState from "../../state/sandbox";
import * as userManagedFilesProbe from "../../state/user-managed-files-probe";
import {
  backupSandboxStateForRebuild,
  disposeRebuildAgentBaseImagePreflight,
  ensureRebuildAgentBaseImage,
  ensureRebuildTargetGatewaySelected,
  pinRebuildAgentBaseImageForRecreate,
  warnUnpreservedUserManagedFiles,
} from "./rebuild-flow-helpers";

function makeBackupResult(): ReturnType<typeof sandboxState.backupSandboxState> {
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
    } as ReturnType<typeof sandboxState.backupSandboxState>["manifest"],
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
    const bindLocalAgentBaseImageToPinnedProvenance = vi
      .spyOn(agentOnboard, "bindLocalAgentBaseImageToPinnedProvenance")
      .mockReturnValue(null);
    const pinAgentSandboxBaseImageRef = vi
      .spyOn(agentOnboard, "pinAgentSandboxBaseImageRef")
      .mockImplementation((_agentName, ref) => String(ref));
    const dockerRmi = vi.spyOn(dockerImage, "dockerRmi").mockReturnValue({ status: 0 } as never);
    return {
      ensureAgentBaseImage,
      bindLocalAgentBaseImageToPinnedProvenance,
      pinAgentSandboxBaseImageRef,
      dockerRmi,
    };
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
    const {
      ensureAgentBaseImage,
      bindLocalAgentBaseImageToPinnedProvenance,
      pinAgentSandboxBaseImageRef,
    } = mockBaseImagePreflight(mutableRef);
    pinAgentSandboxBaseImageRef.mockReturnValue(immutableRef);

    const result = ensureRebuildAgentBaseImage("hermes", makeBail());

    expect(ensureAgentBaseImage).toHaveBeenCalledWith(expect.objectContaining({ name: "hermes" }), {
      forceBaseImageRebuild: false,
    });
    expect(pinAgentSandboxBaseImageRef).toHaveBeenCalledWith("hermes", mutableRef, {
      forceLocal: true,
      temporary: true,
    });
    expect(bindLocalAgentBaseImageToPinnedProvenance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "hermes" }),
      immutableRef,
    );
    expect(result).toEqual({
      ok: true,
      imageRef: immutableRef,
      overrideEnvVar,
      disposeImageRef: expect.any(Function),
    });
    expect(disposeRebuildAgentBaseImagePreflight(result)).toBe(true);
  });

  it("proves a caller alias before resolving it as the pinned remote image (#7144)", () => {
    const callerAlias = "nemoclaw-hermes-sandbox-base-local:e2e-current";
    const remoteRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
    const resolutionMetadata = { key: "verified-remote" } as never;
    process.env[overrideEnvVar] = callerAlias;
    const { ensureAgentBaseImage, bindLocalAgentBaseImageToPinnedProvenance } =
      mockBaseImagePreflight(remoteRef);
    bindLocalAgentBaseImageToPinnedProvenance.mockReturnValue(resolutionMetadata);
    const restoreTrust = vi.fn();
    const pinTrust = vi
      .spyOn(agentOnboard, "pinTrustedAgentRemoteBaseImageOverrideForOperation")
      .mockReturnValue(restoreTrust);
    ensureAgentBaseImage.mockImplementation(() => {
      expect(pinTrust).toHaveBeenCalledWith(overrideEnvVar, {
        ref: callerAlias,
        resolutionMetadata,
      });
      expect(restoreTrust).not.toHaveBeenCalled();
      return { imageTag: remoteRef, built: false, resolutionMetadata };
    });

    const result = ensureRebuildAgentBaseImage("hermes", makeBail());

    expect(bindLocalAgentBaseImageToPinnedProvenance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "hermes" }),
      callerAlias,
    );
    expect(restoreTrust).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      imageRef: remoteRef,
      overrideEnvVar,
      resolutionMetadata,
      trustedRemoteOverride: { ref: remoteRef, resolutionMetadata },
    });
  });

  it("retains a resolved platform digest for the immutable remote handoff (#7144)", () => {
    const platformRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
    const { pinAgentSandboxBaseImageRef } = mockBaseImagePreflight(platformRef);

    const result = ensureRebuildAgentBaseImage("hermes", makeBail(), {
      resolutionHint: { key: "stale-base" } as never,
    });

    expect(pinAgentSandboxBaseImageRef).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      imageRef: platformRef,
      overrideEnvVar,
    });
  });

  it("disposes a temporary recreate handoff at most once (#7144)", () => {
    const disposeImageRef = vi.fn(() => true);
    const preflight = {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:rebuild-1-${"a".repeat(16)}-image-${"b".repeat(64)}`,
      overrideEnvVar,
      disposeImageRef,
    };

    expect(disposeRebuildAgentBaseImagePreflight(preflight)).toBe(true);
    expect(disposeRebuildAgentBaseImagePreflight(preflight)).toBe(true);
    expect(disposeImageRef).toHaveBeenCalledOnce();
  });

  it("retries a temporary recreate handoff after cleanup fails (#7144)", () => {
    const disposeImageRef = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const preflight = {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:rebuild-1-${"a".repeat(16)}-image-${"b".repeat(64)}`,
      overrideEnvVar,
      disposeImageRef,
    };

    expect(disposeRebuildAgentBaseImagePreflight(preflight)).toBe(false);
    expect(disposeRebuildAgentBaseImagePreflight(preflight)).toBe(true);
    expect(disposeImageRef).toHaveBeenCalledTimes(2);
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

  it("leases a local-build proof only for the recreation scope", () => {
    const env: NodeJS.ProcessEnv = {};
    const trustedLocalOverride = {
      ref: `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`,
      provenance: `${"b".repeat(64)}.${"c".repeat(64)}`,
    };
    const restoreTrust = vi.fn();
    const pinTrust = vi
      .spyOn(agentOnboard, "pinTrustedAgentBaseImageOverrideForOperation")
      .mockReturnValue(restoreTrust);

    const restore = pinRebuildAgentBaseImageForRecreate(
      {
        ok: true,
        imageRef: trustedLocalOverride.ref,
        overrideEnvVar,
        trustedLocalOverride,
      },
      env,
    );

    expect(pinTrust).toHaveBeenCalledWith(overrideEnvVar, trustedLocalOverride);
    expect(env[overrideEnvVar]).toBe(trustedLocalOverride.ref);
    restore();
    expect(restoreTrust).toHaveBeenCalledOnce();
    expect(Object.hasOwn(env, overrideEnvVar)).toBe(false);
  });

  it("leases pinned remote provenance only for the recreation scope (#7144)", () => {
    const env: NodeJS.ProcessEnv = {};
    const trustedRemoteOverride = {
      ref: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
      resolutionMetadata: { key: "verified-remote" } as never,
    };
    const restoreTrust = vi.fn();
    const pinTrust = vi
      .spyOn(agentOnboard, "pinTrustedAgentRemoteBaseImageOverrideForOperation")
      .mockReturnValue(restoreTrust);

    const restore = pinRebuildAgentBaseImageForRecreate(
      {
        ok: true,
        imageRef: trustedRemoteOverride.ref,
        overrideEnvVar,
        trustedRemoteOverride,
      },
      env,
    );

    expect(pinTrust).toHaveBeenCalledWith(overrideEnvVar, trustedRemoteOverride);
    expect(env[overrideEnvVar]).toBe(trustedRemoteOverride.ref);
    restore();
    expect(restoreTrust).toHaveBeenCalledOnce();
    expect(Object.hasOwn(env, overrideEnvVar)).toBe(false);
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

  it("returns null (skip) when backup fails completely and force is set", () => {
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".state"],
      failedFiles: ["config.toml"],
      manifest: null,
    });
    const result = backupSandboxStateForRebuild(
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

  it("aborts with hint when backup fails completely without force", () => {
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".state"],
      failedFiles: [],
      manifest: null,
    });
    expect(() =>
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        () => true,
        makeBail(),
      ),
    ).toThrow("bail: Failed to back up sandbox state.");

    const errorLines = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(errorLines.some((line: string) => line.includes("rebuild --force"))).toBe(true);
    expect(errorLines.some((line: string) => line.includes("accept losing state"))).toBe(true);
  });

  it("aborts without force even when force option is explicitly false", () => {
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".state"],
      failedFiles: [],
      manifest: null,
    });
    expect(() =>
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        () => true,
        makeBail(),
        { force: false },
      ),
    ).toThrow("bail: Failed to back up sandbox state.");
  });

  it("aborts with an ownership hint when every state directory hit permission denied (#6972)", () => {
    // Mirrors the issue: a post-reboot ownership corruption left all state dirs
    // unreadable; only a few loose files backed up. Proceeding would destroy the
    // failed dirs on recreate.
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: ["SOUL.md", ".hermes_history", "runtime/state.db"],
      failedDirs: ["memories", "sessions", "workspace", "plans"],
      failedDirReasons: {
        memories: "permission denied",
        sessions: "permission denied",
        workspace: "permission denied",
        plans: "permission denied",
      },
      failedFiles: [],
      // Non-force abort bails before the manifest is read; keep the fixture
      // internally consistent (no backed-up dirs) rather than reusing a manifest
      // that claims otherwise.
      manifest: null,
    });
    const relockShieldsIfNeeded = vi.fn(() => true);

    expect(() =>
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        relockShieldsIfNeeded,
        makeBail(),
      ),
    ).toThrow("bail: Failed to back up sandbox state.");
    expect(relockShieldsIfNeeded).toHaveBeenCalledOnce();
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);

    const errorLines = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      errorLines.some((line: string) =>
        line.includes("None of the 4 sandbox state directories could be preserved"),
      ),
    ).toBe(true);
    expect(errorLines.some((line: string) => line.includes("wrong ownership or permissions"))).toBe(
      true,
    );
    // The per-dir cause is surfaced on the Failed: line.
    expect(errorLines.some((line: string) => line.includes("memories (permission denied)"))).toBe(
      true,
    );
    expect(errorLines.some((line: string) => line.includes("rebuild --force"))).toBe(true);
    // Must not fall through to the lenient "Rebuild will continue" warning.
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("Rebuild will continue"))).toBe(false);
  });

  it("aborts with an unstable-mount hint when every dir was absent after extraction (#6972)", () => {
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: ["SOUL.md"],
      failedDirs: ["memories", "sessions"],
      failedDirReasons: {
        memories: "absent after extraction",
        sessions: "absent after extraction",
      },
      failedFiles: [],
      // Non-force abort bails before the manifest is read; null keeps the fixture
      // consistent with backedUpDirs: [].
      manifest: null,
    });

    expect(() =>
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        () => true,
        makeBail(),
      ),
    ).toThrow("bail: Failed to back up sandbox state.");

    const errorLines = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      errorLines.some((line: string) => line.includes("did not materialize on extraction")),
    ).toBe(true);
    expect(errorLines.some((line: string) => line.includes("wrong ownership or permissions"))).toBe(
      false,
    );
  });

  it("aborts before replacement when a required state file backup fails (#7144)", () => {
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: ["memories", "sessions"],
      backedUpFiles: ["SOUL.md"],
      failedDirs: [],
      failedFiles: ["kanban.db"],
      manifest: makeBackupResult().manifest,
    });

    expect(() =>
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        () => true,
        makeBail(),
      ),
    ).toThrow("bail: Failed to back up sandbox state.");

    const errorLines = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(errorLines.some((line: string) => line.includes("Failed files: kanban.db"))).toBe(true);
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("Rebuild will continue"))).toBe(false);
  });

  it("allows a required state file backup failure only with --force (#7144)", () => {
    const manifest = makeBackupResult().manifest!;
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: ["memories", "sessions"],
      backedUpFiles: ["SOUL.md"],
      failedDirs: [],
      failedFiles: ["kanban.db"],
      manifest,
    });

    const result = backupSandboxStateForRebuild(
      "alpha",
      makeSandboxEntry(),
      false,
      () => undefined,
      () => true,
      makeBail(),
      { force: true },
    );

    expect(result).toBe(manifest);
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("--force was specified"))).toBe(true);
  });

  it("keeps the salvageable partial manifest when all dirs failed but --force is set (#6972)", () => {
    const manifest = makeBackupResult().manifest!;
    manifest.stateDirs = ["memories", "sessions"];
    manifest.backedUpDirs = [];
    manifest.stateFiles = [{ path: "SOUL.md", strategy: "copy" }];
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: ["SOUL.md"],
      failedDirs: ["memories", "sessions"],
      failedFiles: [],
      manifest,
    });

    const result = backupSandboxStateForRebuild(
      "alpha",
      makeSandboxEntry(),
      false,
      () => undefined,
      () => true,
      makeBail(),
      { force: true },
    );

    expect(result).toBe(manifest);
    expect(result?.backedUpDirs).toEqual([]);
    expect(result?.stateFiles).toEqual([{ path: "SOUL.md", strategy: "copy" }]);
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("--force was specified"))).toBe(true);
  });

  it("still proceeds on a partial backup that preserved at least one state directory", () => {
    // Benign case: the base image bakes a root-owned nested subdir that always
    // perm-fails, marking one top-level dir failed while others succeed. This
    // must NOT abort — only a total directory-state loss does.
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: ["memories", "sessions"],
      backedUpFiles: ["SOUL.md"],
      failedDirs: ["plugins"],
      failedFiles: [],
      manifest: makeBackupResult().manifest,
    });

    const result = backupSandboxStateForRebuild(
      "alpha",
      makeSandboxEntry(),
      false,
      () => undefined,
      () => true,
      makeBail(),
    );

    expect(result).toBeTruthy();
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("Partial backup"))).toBe(true);
    expect(warnLines.some((line: string) => line.includes("Rebuild will continue"))).toBe(true);
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

    backupSpy = vi.spyOn(sandboxState, "backupSandboxState").mockReturnValue(makeBackupResult());
    probeSpy = vi.spyOn(userManagedFilesProbe, "probeUserManagedFiles").mockReturnValue({
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

    warnUnpreservedUserManagedFiles("alpha", () => undefined);

    expect(probeSpy).toHaveBeenCalledOnce();
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("will not be preserved"))).toBe(false);
  });

  it("emits no warning when agent declares no user-managed files", () => {
    probeSpy.mockReturnValue({ declared: [], existing: [] });

    warnUnpreservedUserManagedFiles("alpha", () => undefined);

    expect(probeSpy).toHaveBeenCalledOnce();
    const warnLines = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warnLines.some((line: string) => line.includes("will not be preserved"))).toBe(false);
  });

  it("skips probe when staleRecovery short-circuits the backup", () => {
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

  it("surfaces the backup failure reason before aborting", () => {
    backupSpy.mockReturnValue({
      ...makeBackupResult(),
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".state"],
      failedFiles: ["config.toml"],
      error: "Pre-backup audit rejected an unsafe symlink",
    });

    expect(() =>
      backupSandboxStateForRebuild(
        "alpha",
        makeSandboxEntry(),
        false,
        () => undefined,
        () => true,
        makeBail(),
      ),
    ).toThrow("bail: Failed to back up sandbox state.");

    const errorLines = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(errorLines).toContain("  Reason: Pre-backup audit rejected an unsafe symlink");
  });
});
