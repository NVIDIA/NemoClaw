// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as dockerImage from "../../adapters/docker/image";
import * as agentDefs from "../../agent/defs";
import * as agentOnboard from "../../agent/onboard";
import * as gatewayRuntime from "../../gateway-runtime-action";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import * as sandboxState from "../../state/sandbox";
import * as userManagedFilesProbe from "../../state/user-managed-files-probe";
import * as snapshotBackup from "./snapshot/backup-authority";
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
      expectedVersion: "0.1.55",
      stateDirs: [".state"],
      backedUpDirs: [".state"],
      stateFiles: [{ path: "config.toml", strategy: "copy" }],
      dir: "/sandbox/.deepagents",
      backupPath: "/tmp/nemoclaw-rebuild-backup",
      blueprintDigest: null,
    } as ReturnType<typeof sandboxState.backupSandboxState>["manifest"],
  };
}

function makeSandboxEntry(): Parameters<typeof backupSandboxStateForRebuild>[1] {
  return {
    name: "alpha",
    agent: "langchain-deepagents-code",
    provider: null,
    model: null,
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
    const loadAgent = vi
      .spyOn(agentDefs, "loadAgent")
      .mockReturnValue({ name: "hermes", displayName: "Hermes Agent" } as never);
    const ensureAgentBaseImage = vi
      .spyOn(agentOnboard, "ensureAgentBaseImage")
      .mockReturnValue({ imageTag: imageRef, built: true });
    const bindLocalAgentBaseImageToPinnedProvenance = vi
      .spyOn(agentOnboard, "bindLocalAgentBaseImageToPinnedProvenance")
      .mockReturnValue(null);
    const pinAgentSandboxBaseImageRef = vi
      .spyOn(agentOnboard, "pinAgentSandboxBaseImageRef")
      .mockImplementation((_agentName, ref) => String(ref));
    const bindLocalAgentBaseImageHandoffToResolution = vi
      .spyOn(agentOnboard, "bindLocalAgentBaseImageHandoffToResolution")
      .mockReturnValue(null);
    const dockerRmi = vi.spyOn(dockerImage, "dockerRmi").mockReturnValue({ status: 0 } as never);
    return {
      loadAgent,
      ensureAgentBaseImage,
      bindLocalAgentBaseImageToPinnedProvenance,
      bindLocalAgentBaseImageHandoffToResolution,
      pinAgentSandboxBaseImageRef,
      dockerRmi,
    };
  }

  it("forces a repository-local build and returns its exact ref when no override exists", () => {
    const imageRef = `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`;
    const trustedLocalOverride = {
      ref: imageRef,
      provenance: `${"b".repeat(64)}.${"c".repeat(64)}`,
    };
    const { ensureAgentBaseImage } = mockBaseImagePreflight(imageRef);
    ensureAgentBaseImage.mockReturnValue({
      imageTag: imageRef,
      built: true,
      trustedLocalOverride,
    });

    const result = ensureRebuildAgentBaseImage("hermes", makeBail());

    expect(ensureAgentBaseImage).toHaveBeenCalledWith(expect.objectContaining({ name: "hermes" }), {
      forceBaseImageRebuild: true,
    });
    expect(result).toEqual({
      ok: true,
      imageRef,
      overrideEnvVar,
      trustedLocalOverride,
    });
  });

  it("hands a pinned NemoCUA image alias to the inner sandbox create (#9649)", () => {
    const cuaOverrideEnvVar = "NEMOCLAW_CUA_SANDBOX_IMAGE_REF";
    const mutableRef = "nemocua-scenario:mutable";
    const pinnedRef = `nemoclaw-nemocua-sandbox-base-local:rebuild-1-${"a".repeat(16)}-image-${"b".repeat(64)}`;
    const agent = agentDefs.loadAgent("nemocua", { NEMOCLAW_CUA_ENABLED: "1" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-rebuild-test-"));
    let buildContext = root;
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");
    vi.stubEnv(cuaOverrideEnvVar, mutableRef);
    vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agent);
    vi.spyOn(agentOnboard, "ensureAgentBaseImage").mockReturnValue({
      imageTag: mutableRef,
      built: false,
    });
    const pinImage = vi
      .spyOn(agentOnboard, "pinAgentSandboxBaseImageRef")
      .mockReturnValue(pinnedRef);
    const dockerRmi = vi.spyOn(dockerImage, "dockerRmi").mockReturnValue({ status: 0 } as never);

    try {
      const preflight = ensureRebuildAgentBaseImage("nemocua", makeBail());
      expect(preflight).toMatchObject({
        ok: true,
        imageRef: pinnedRef,
        overrideEnvVar: cuaOverrideEnvVar,
      });
      expect(pinImage).toHaveBeenCalledWith("nemocua", mutableRef, {
        forceLocal: true,
        temporary: true,
      });

      const restore = pinRebuildAgentBaseImageForRecreate(preflight);
      try {
        const inner = agentOnboard.createAgentSandbox(agent, { rootDir: root });
        buildContext = inner.buildCtx;
        const dockerfile = fs.readFileSync(inner.stagedDockerfile, "utf8");
        expect(dockerfile).toContain(`ARG BASE_IMAGE=${pinnedRef}`);
        expect(dockerfile).not.toContain(mutableRef);
      } finally {
        restore();
      }

      expect(process.env[cuaOverrideEnvVar]).toBe(mutableRef);
      expect(disposeRebuildAgentBaseImagePreflight(preflight)).toBe(true);
      expect(dockerRmi).toHaveBeenCalledWith(pinnedRef, {
        ignoreError: true,
        suppressOutput: true,
      });
    } finally {
      fs.rmSync(buildContext, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("passes an immutable NemoCUA digest through without a local alias (#9649)", () => {
    const cuaOverrideEnvVar = "NEMOCLAW_CUA_SANDBOX_IMAGE_REF";
    const digestRef = `registry.example/nemocua@sha256:${"a".repeat(64)}`;
    const agent = agentDefs.loadAgent("nemocua", { NEMOCLAW_CUA_ENABLED: "1" });
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");
    vi.stubEnv(cuaOverrideEnvVar, digestRef);
    vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agent);
    vi.spyOn(agentOnboard, "ensureAgentBaseImage").mockReturnValue({
      imageTag: digestRef,
      built: false,
    });
    const pinImage = vi.spyOn(agentOnboard, "pinAgentSandboxBaseImageRef");
    const dockerRmi = vi.spyOn(dockerImage, "dockerRmi");

    try {
      const preflight = ensureRebuildAgentBaseImage("nemocua", makeBail());

      expect(preflight).toEqual({
        ok: true,
        imageRef: digestRef,
        overrideEnvVar: cuaOverrideEnvVar,
      });
      expect(pinImage).not.toHaveBeenCalled();
      expect(disposeRebuildAgentBaseImagePreflight(preflight)).toBe(true);
      expect(dockerRmi).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when an explicit local result lacks validated outer metadata", () => {
    process.env[overrideEnvVar] = "nemoclaw-hermes-sandbox-base-local:caller";
    const mutableRef = "nemoclaw-hermes-sandbox-base-local:resolved";
    const rebuildRef = `nemoclaw-hermes-sandbox-base-local:rebuild-343338-${"b".repeat(16)}-image-${"a".repeat(64)}`;
    const { ensureAgentBaseImage, pinAgentSandboxBaseImageRef, dockerRmi } =
      mockBaseImagePreflight(mutableRef);
    pinAgentSandboxBaseImageRef.mockReturnValue(rebuildRef);

    expect(() => ensureRebuildAgentBaseImage("hermes", makeBail())).toThrow(
      "could not be bound to its rebuild handoff",
    );

    expect(ensureAgentBaseImage).toHaveBeenCalledWith(expect.objectContaining({ name: "hermes" }), {
      forceBaseImageRebuild: false,
    });
    expect(pinAgentSandboxBaseImageRef).toHaveBeenCalledWith("hermes", mutableRef, {
      forceLocal: true,
      temporary: true,
    });
    expect(dockerRmi).toHaveBeenCalledWith(rebuildRef, {
      ignoreError: true,
      suppressOutput: true,
    });
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

  it("leases a temporary local handoff only from the stable outer resolution", () => {
    const inputHashRef = "nemoclaw-hermes-sandbox-base-local:3ef2ca87";
    const rebuildRef = `nemoclaw-hermes-sandbox-base-local:rebuild-343338-${"c".repeat(16)}-image-${"d".repeat(64)}`;
    const provenance = `${"e".repeat(64)}.${"f".repeat(64)}`;
    const resolutionMetadata = {
      ref: inputHashRef,
      digest: null,
      source: "local",
      imageId: `sha256:${"d".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    const mocks = mockBaseImagePreflight(inputHashRef);
    const {
      bindLocalAgentBaseImageHandoffToResolution,
      ensureAgentBaseImage,
      pinAgentSandboxBaseImageRef,
    } = mocks;
    pinAgentSandboxBaseImageRef.mockReturnValue(rebuildRef);
    ensureAgentBaseImage.mockReturnValue({
      imageTag: inputHashRef,
      built: false,
      resolutionMetadata,
      reusedResolutionHint: resolutionMetadata,
    });
    bindLocalAgentBaseImageHandoffToResolution.mockReturnValue({
      ref: rebuildRef,
      provenance,
    });

    try {
      const result = ensureRebuildAgentBaseImage("hermes", makeBail(), {
        resolutionHint: resolutionMetadata,
      });

      expect(bindLocalAgentBaseImageHandoffToResolution).toHaveBeenCalledWith(
        expect.objectContaining({ name: "hermes" }),
        inputHashRef,
        rebuildRef,
        resolutionMetadata,
        resolutionMetadata,
      );
      expect(result).toMatchObject({
        imageRef: rebuildRef,
        resolutionMetadata,
        trustedLocalOverride: { ref: rebuildRef, provenance },
      });
    } finally {
      Object.values(mocks).forEach((mock) => {
        mock.mockRestore();
      });
    }
  });

  it("force-rebuilds instead of trusting fresh fallback metadata after a local tag moved", () => {
    const sourceRef = "nemoclaw-hermes-sandbox-base-local:3ef2ca87";
    const imageId = `sha256:${"d".repeat(64)}`;
    const canonicalRef = `nemoclaw-hermes-sandbox-base-local:image-${"d".repeat(64)}`;
    const persistedHint = {
      ref: sourceRef,
      digest: null,
      source: "local",
      imageId: `sha256:${"a".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    const freshFallbackMetadata = {
      ...persistedHint,
      imageId,
    };
    const forcedMetadata = {
      ...freshFallbackMetadata,
      ref: canonicalRef,
    };
    const forcedTrust = {
      ref: canonicalRef,
      provenance: `${"e".repeat(64)}.${"f".repeat(64)}`,
    };
    const {
      bindLocalAgentBaseImageHandoffToResolution,
      ensureAgentBaseImage,
      pinAgentSandboxBaseImageRef,
    } = mockBaseImagePreflight(sourceRef);
    ensureAgentBaseImage
      .mockReturnValueOnce({
        imageTag: sourceRef,
        built: false,
        resolutionMetadata: freshFallbackMetadata,
      })
      .mockReturnValueOnce({
        imageTag: canonicalRef,
        built: true,
        resolutionMetadata: forcedMetadata,
        trustedLocalOverride: forcedTrust,
      });
    pinAgentSandboxBaseImageRef.mockReturnValue(canonicalRef);

    const result = ensureRebuildAgentBaseImage("hermes", makeBail(), {
      resolutionHint: persistedHint,
    });

    expect(bindLocalAgentBaseImageHandoffToResolution).not.toHaveBeenCalled();
    expect(ensureAgentBaseImage).toHaveBeenCalledTimes(2);
    expect(ensureAgentBaseImage).toHaveBeenNthCalledWith(2, expect.anything(), {
      forceBaseImageRebuild: true,
    });
    expect(result).toMatchObject({
      imageRef: canonicalRef,
      resolutionMetadata: forcedMetadata,
      trustedLocalOverride: forcedTrust,
    });
  });

  it("reuses the canonical forced-build metadata on the next offline rebuild", () => {
    const canonicalRef = `nemoclaw-hermes-sandbox-base-local:image-${"d".repeat(64)}`;
    const resolutionMetadata = {
      ref: canonicalRef,
      digest: null,
      source: "local",
      imageId: `sha256:${"d".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    const provenance = `${"e".repeat(64)}.${"f".repeat(64)}`;
    const {
      bindLocalAgentBaseImageHandoffToResolution,
      ensureAgentBaseImage,
      pinAgentSandboxBaseImageRef,
    } = mockBaseImagePreflight(canonicalRef);
    ensureAgentBaseImage.mockReturnValue({
      imageTag: canonicalRef,
      built: false,
      resolutionMetadata,
      reusedResolutionHint: resolutionMetadata,
    });
    pinAgentSandboxBaseImageRef.mockReturnValue(canonicalRef);
    bindLocalAgentBaseImageHandoffToResolution.mockReturnValue({
      ref: canonicalRef,
      provenance,
    });

    const result = ensureRebuildAgentBaseImage("hermes", makeBail(), {
      resolutionHint: resolutionMetadata,
    });

    expect(ensureAgentBaseImage).toHaveBeenCalledOnce();
    expect(ensureAgentBaseImage).toHaveBeenCalledWith(expect.anything(), {
      forceBaseImageRebuild: false,
      resolutionHint: resolutionMetadata,
    });
    expect(bindLocalAgentBaseImageHandoffToResolution).toHaveBeenCalledWith(
      expect.anything(),
      canonicalRef,
      canonicalRef,
      resolutionMetadata,
      resolutionMetadata,
    );
    expect(result.trustedLocalOverride).toEqual({ ref: canonicalRef, provenance });
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

describe("backupSandboxStateForRebuild failure safety", () => {
  let warnSpy: MockInstance;
  let errorSpy: MockInstance;
  let backupSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    backupSpy = vi.spyOn(snapshotBackup, "backupSandboxStateWithManagedAuthority");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts when backup fails completely", () => {
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
    expect(errorLines.some((line: string) => line.includes("Aborting rebuild"))).toBe(true);
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
      // The abort happens before the manifest is read; keep the fixture
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
    // Must not fall through to a partial-backup continuation.
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
      // The abort happens before the manifest is read; null keeps the fixture
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

  it("aborts when one state directory fails after other state was preserved", () => {
    const relockShieldsIfNeeded = vi.fn(() => true);
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: ["memories", "sessions"],
      backedUpFiles: ["SOUL.md"],
      failedDirs: ["plugins"],
      failedFiles: [],
      manifest: makeBackupResult().manifest,
    });

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
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
  });

  it("aborts before rebuild when the workspace backup fails (#10639)", () => {
    const relockShieldsIfNeeded = vi.fn(() => true);
    backupSpy.mockReturnValue({
      success: false,
      backedUpDirs: ["extensions"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: ["workspace"],
      failedFiles: [],
      manifest: makeBackupResult().manifest,
    });

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

    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
    const errorLines = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(errorLines.some((line: string) => line.includes("workspace"))).toBe(true);
    expect(
      errorLines.some((line: string) =>
        line.includes("Incomplete snapshot retained for manual recovery"),
      ),
    ).toBe(true);
    expect(
      errorLines.some((line: string) => line.includes("excluded from snapshot restore selection")),
    ).toBe(true);
    expect(errorLines.some((line: string) => line.includes("Aborting rebuild"))).toBe(true);
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

    backupSpy = vi
      .spyOn(snapshotBackup, "backupSandboxStateWithManagedAuthority")
      .mockReturnValue(makeBackupResult());
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
