// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that sandbox lifecycle operations clean up host-side Docker images.
// See: https://github.com/NVIDIA/NemoClaw/issues/2086

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { help as renderRootHelp } from "../../../src/lib/actions/root-help";
import {
  cleanupShieldsDestroyArtifacts,
  removeSandboxImage,
  removeSandboxRegistryEntry,
  removeSandboxRegistryEntryOutcome,
  removeSandboxRegistryEntryWithReceipt,
  removeShieldsState,
  requireSandboxDestructiveCleanupAuthority,
} from "../../../src/lib/actions/sandbox/destroy";
import { requireSnapshotDestinationRegistryRemoval } from "../../../src/lib/actions/sandbox/snapshot";
import { COMMANDS, globalCommandTokens } from "../../../src/lib/cli/command-registry";
import { getRegisteredOclifCommandMetadata } from "../../../src/lib/cli/oclif-metadata";
import { normalizeGarbageCollectImagesOptions } from "../../../src/lib/domain/lifecycle/options";
import { getSandboxDeleteOutcome } from "../../../src/lib/domain/sandbox/destroy";
import { createDockerRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../../src/lib/onboard/runtime-provider/registry";
import { resolveNemoclawStateDir } from "../../../src/lib/state/paths";

describe("image cleanup: sandbox destroy removes Docker image (#2086)", () => {
  it("removes sandbox images before deleting the registry entry", () => {
    const calls: string[] = [];

    const removed = removeSandboxRegistryEntry("alpha", {
      removeImage: (sandboxName) => {
        calls.push(`image:${sandboxName}`);
      },
      removeSandbox: (sandboxName) => {
        calls.push(`registry:${sandboxName}`);
        return true;
      },
    });

    expect(removed).toBe(true);
    expect(calls).toEqual(["image:alpha", "registry:alpha"]);
  });

  it("removeSandboxImage calls docker rmi for recorded image tags", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      ["docker", createDockerRuntimeProviderBundle({ removeImage })],
    ]);

    removeSandboxImage("alpha", {
      getSandbox: () => ({ name: "alpha", imageTag: "openshell/sandbox-from:123" }) as any,
      runtimeProviders,
    });

    expect(removeImage).toHaveBeenCalledWith("openshell/sandbox-from:123", {
      ignoreError: true,
      timeout: 30_000,
    });
  });

  it("redacts provider cleanup failures before reporting them", () => {
    const secret = "super-secret-provider-value";
    const warn = vi.fn();
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      [
        "docker",
        createDockerRuntimeProviderBundle({
          removeImage: () => {
            throw new Error(`OPENAI_API_KEY=${secret}`);
          },
        }),
      ],
    ]);

    const result = removeSandboxImage("alpha", {
      getSandbox: () =>
        ({
          name: "alpha",
          openshellDriver: "docker",
          imageTag: "local/alpha:current",
          workload: {
            schemaVersion: 1,
            kind: "legacy-dockerfile",
            reference: "local/alpha:current",
            shared: false,
          },
        }) as any,
      runtimeProviders,
      warn,
    });

    expect(result).toEqual({ status: "skipped", reason: "authority-unproven" });
    const warning = warn.mock.calls.flat().join("\n");
    expect(warning).not.toContain(secret);
    expect(warning).toContain("OPENAI_API_KEY=<REDACTED>");
  });

  it("removeSandboxImage gracefully handles missing imageTag", () => {
    const removedTags: string[] = [];
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      [
        "docker",
        createDockerRuntimeProviderBundle({
          removeImage: (tag) => {
            removedTags.push(tag);
            return { status: 0 };
          },
        }),
      ],
    ]);

    removeSandboxImage("alpha", {
      getSandbox: () => ({ name: "alpha", imageTag: null }) as any,
      runtimeProviders,
    });

    expect(removedTags).toEqual([]);
  });

  it("never deletes a shared managed workload image", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      ["docker", createDockerRuntimeProviderBundle({ removeImage })],
    ]);

    const result = removeSandboxImage("alpha", {
      getSandbox: () =>
        ({
          name: "alpha",
          openshellDriver: "docker",
          imageTag: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`,
          workload: { shared: true, kind: "managed-image" },
        }) as any,
      runtimeProviders,
    });

    expect(result).toEqual({ status: "skipped", reason: "shared-image" });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("protects a managed image and removes its registry row when its receipt was dropped", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      ["docker", createDockerRuntimeProviderBundle({ removeImage })],
    ]);

    const result = removeSandboxImage("alpha", {
      getSandbox: () =>
        ({
          name: "alpha",
          openshellDriver: "docker",
          imageTag: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`,
          workload: undefined,
        }) as any,
      runtimeProviders,
    });

    expect(result).toEqual({ status: "skipped", reason: "shared-image" });
    expect(removeImage).not.toHaveBeenCalled();

    const removeSandbox = vi.fn(() => true);
    expect(
      removeSandboxRegistryEntry("alpha", {
        removeImage: () => result,
        removeSandbox,
      }),
    ).toBe(true);
    expect(removeSandbox).toHaveBeenCalledWith("alpha");
  });

  it("fails closed and reports the provider when workload image authority is unproven", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));
    const warn = vi.fn();
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      ["docker", createDockerRuntimeProviderBundle({ removeImage })],
    ]);

    const result = removeSandboxImage("alpha", {
      getSandbox: () =>
        ({
          name: "alpha",
          openshellDriver: "docker",
          imageTag: "local/alpha:current",
          workload: {
            schemaVersion: 1,
            kind: "legacy-dockerfile",
            reference: "local/alpha:recorded",
            shared: false,
          },
        }) as any,
      runtimeProviders,
      warn,
    });

    expect(result).toEqual({ status: "skipped", reason: "authority-unproven" });
    expect(removeImage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Runtime provider 'docker'"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workload receipt"));

    const removeSandbox = vi.fn(() => true);
    const removalOutcome = removeSandboxRegistryEntryOutcome("alpha", {
      removeImage: () => result,
      removeSandbox,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => requireSnapshotDestinationRegistryRemoval("alpha", removalOutcome)).toThrow();
      expect(removeSandbox).not.toHaveBeenCalled();
      const output = error.mock.calls.flat().join("\n");
      expect(output).toContain("doctor --json");
      expect(output).toContain("Do not rewrite a receipt");
    } finally {
      error.mockRestore();
    }
  });

  it("accepts an already absent registry entry after destination deletion", () => {
    const outcome = removeSandboxRegistryEntryOutcome("alpha", {
      removeImage: () => ({ status: "skipped", reason: "no-owned-image" }),
      removeSandbox: () => false,
    });

    expect(outcome).toEqual({ status: "not-found", removed: false });
    expect(() => requireSnapshotDestinationRegistryRemoval("alpha", outcome)).not.toThrow();
  });

  it.each([
    {
      label: "unknown provider",
      sandbox: {
        name: "alpha",
        openshellDriver: "future-runtime",
        imageTag: "local/alpha:current",
      },
      expected: "is not registered for this operation",
    },
    {
      label: "mismatched legacy workload receipt",
      sandbox: {
        name: "alpha",
        openshellDriver: "docker",
        imageTag: "local/alpha:current",
        workload: {
          schemaVersion: 1,
          kind: "legacy-dockerfile",
          reference: "local/alpha:recorded",
          shared: false,
        },
      },
      expected: "could not prove ownership",
    },
  ])("rejects destructive cleanup before side effects for $label", ({ sandbox, expected }) => {
    const removeImage = vi.fn(() => ({ status: 0 }));
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      ["docker", createDockerRuntimeProviderBundle({ removeImage })],
    ]);

    expect(() =>
      requireSandboxDestructiveCleanupAuthority("alpha", sandbox as any, runtimeProviders),
    ).toThrow(expected);
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("preserves registry ownership when workload cleanup authority is unproven", () => {
    const removeSandbox = vi.fn(() => true);
    const removeSandboxWithReceipt = vi.fn();
    const authorityUnproven = () => ({ status: "skipped", reason: "authority-unproven" }) as const;

    expect(
      removeSandboxRegistryEntry("alpha", {
        removeImage: authorityUnproven,
        removeSandbox,
      }),
    ).toBe(false);
    expect(
      removeSandboxRegistryEntryWithReceipt("alpha", {
        removeImage: authorityUnproven,
        removeSandboxWithReceipt,
      }),
    ).toBeNull();
    expect(removeSandbox).not.toHaveBeenCalled();
    expect(removeSandboxWithReceipt).not.toHaveBeenCalled();
  });

  it("treats missing sandbox delete results as already gone", () => {
    expect(
      getSandboxDeleteOutcome({ status: 1, stderr: "Error: sandbox alpha not found" }),
    ).toEqual({
      output: "Error: sandbox alpha not found",
      alreadyGone: true,
      gatewayUnreachable: false,
    });
  });

  it("destroy neutralizes active shields timer and only deletes target sandbox files", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "destroy-shields-"));
    const alphaRecovery = path.join(stateDir, "shields-external-policy-alpha.yaml");
    const alphaState = path.join(stateDir, "shields-alpha.json");
    const alphaTimer = path.join(stateDir, "shields-timer-alpha.json");
    const betaRecovery = path.join(stateDir, "shields-external-policy-beta.yaml");
    const betaState = path.join(stateDir, "shields-beta.json");
    const betaTimer = path.join(stateDir, "shields-timer-beta.json");

    fs.writeFileSync(alphaRecovery, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(alphaState, '{"shieldsDown":true}');
    fs.writeFileSync(alphaTimer, '{"pid":9999}');
    fs.writeFileSync(betaRecovery, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(betaState, '{"shieldsDown":true}');
    fs.writeFileSync(betaTimer, '{"pid":9999}');

    const killCalls: string[] = [];
    cleanupShieldsDestroyArtifacts("alpha", {
      stateDir,
      killShieldsTimer: (sandboxName) => {
        killCalls.push(sandboxName);
        return {
          warnings: [],
        };
      },
    });

    expect(killCalls).toEqual(["alpha"]);
    expect(fs.existsSync(alphaRecovery)).toBe(false);
    expect(fs.existsSync(alphaState)).toBe(false);
    expect(fs.existsSync(alphaTimer)).toBe(false);
    expect(fs.existsSync(betaRecovery)).toBe(true);
    expect(fs.existsSync(betaState)).toBe(true);
    expect(fs.existsSync(betaTimer)).toBe(true);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("destroy preserves Shields state when external recovery cleanup fails (#9833)", () => {
    const warnings: string[] = [];
    const rmSync = vi.fn((artifactPath: string) => {
      if (artifactPath.endsWith("shields-external-policy-alpha.yaml")) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
    });

    expect(() =>
      cleanupShieldsDestroyArtifacts("alpha", {
        stateDir: "/tmp/nonexistent-state-dir",
        rmSync: rmSync as unknown as typeof fs.rmSync,
        killShieldsTimer: () => ({
          warnings: ["Failed to terminate Shields timer PID 4242"],
        }),
        warn: (message) => warnings.push(message),
      }),
    ).toThrow(
      "Could not remove external Shields policy recovery artifact '/tmp/nonexistent-state-dir/shields-external-policy-alpha.yaml': permission denied. Shields state was preserved for retry.",
    );

    expect(warnings).toEqual(["Failed to terminate Shields timer PID 4242"]);
    expect(rmSync).toHaveBeenCalledOnce();
    expect(rmSync.mock.calls[0][0]).toContain("shields-external-policy-alpha.yaml");
  });

  it("state-dir helper resolves ~/.nemoclaw/state from a single shared helper", () => {
    const resolved = resolveNemoclawStateDir("/tmp/example-home");
    expect(resolved).toBe(path.join("/tmp/example-home", ".nemoclaw", "state"));
  });
});

describe("shields state cleanup on destroy (#3114)", () => {
  it("removes Shields state, timer, and external recovery files for the sandbox", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    try {
      const shieldsFile = path.join(tmpDir, "shields-alpha.json");
      const timerFile = path.join(tmpDir, "shields-timer-alpha.json");
      const recoveryFile = path.join(tmpDir, "shields-external-policy-alpha.yaml");
      fs.writeFileSync(shieldsFile, JSON.stringify({ shieldsDown: false }));
      fs.writeFileSync(timerFile, JSON.stringify({ pid: 12345 }));
      fs.writeFileSync(recoveryFile, "version: 1\nnetwork_policies: {}\n");

      removeShieldsState("alpha", tmpDir);

      expect(fs.existsSync(shieldsFile)).toBe(false);
      expect(fs.existsSync(timerFile)).toBe(false);
      expect(fs.existsSync(recoveryFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("is a no-op when no shields state files exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    try {
      // Must not throw
      removeShieldsState("nonexistent", tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not remove state files for other sandboxes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    try {
      const otherFile = path.join(tmpDir, "shields-bravo.json");
      const otherRecoveryFile = path.join(tmpDir, "shields-external-policy-bravo.yaml");
      fs.writeFileSync(otherFile, JSON.stringify({ shieldsDown: false }));
      fs.writeFileSync(otherRecoveryFile, "version: 1\nnetwork_policies: {}\n");

      removeShieldsState("alpha", tmpDir);

      expect(fs.existsSync(otherFile)).toBe(true);
      expect(fs.existsSync(otherRecoveryFile)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in sandbox name", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    const escapedFile = path.join(tmpDir, "..", "shields-traversal.json");
    try {
      fs.writeFileSync(escapedFile, "should survive");

      // A name containing ../ should not delete files outside stateDir
      removeShieldsState("../../../../shields-traversal", tmpDir);

      expect(fs.existsSync(escapedFile)).toBe(true);
    } finally {
      fs.rmSync(escapedFile, { force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("image cleanup: gc command exists (#2086)", () => {
  it("gc is a global command", () => {
    expect(COMMANDS).toContainEqual(
      expect.objectContaining({ commandId: "gc", scope: "global", usage: "nemoclaw gc" }),
    );
    expect(globalCommandTokens()).toContain("gc");
  });

  it("gc command is discovered by oclif", () => {
    expect(getRegisteredOclifCommandMetadata("gc")).toBeTruthy();
  });

  it("gc option normalization supports dry-run and confirmation aliases", () => {
    expect(normalizeGarbageCollectImagesOptions(["--dry-run", "--yes"])).toEqual({
      dryRun: true,
      force: false,
      yes: true,
    });
    expect(normalizeGarbageCollectImagesOptions({ dryRun: true, force: true })).toEqual({
      dryRun: true,
      force: true,
    });
  });

  it("gc appears in rendered help text", () => {
    const originalLog = console.log;
    let renderedHelp = "";
    console.log = (message?: unknown) => {
      renderedHelp += `${String(message ?? "")}\n`;
    };
    try {
      renderRootHelp();
    } finally {
      console.log = originalLog;
    }

    expect(renderedHelp).toContain("nemoclaw gc");
    expect(renderedHelp).toContain("Remove orphaned sandbox Docker images");
  });
});
