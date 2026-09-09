// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that sandbox lifecycle operations clean up host-side Docker images.
// See: https://github.com/NVIDIA/NemoClaw/issues/2086

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { help as renderRootHelp } from "../../../src/lib/actions/root-help";
import {
  removeSandboxImage,
  removeSandboxRegistryEntry,
  removeSandboxRegistryEntryOutcome,
  removeSandboxRegistryEntryWithReceipt,
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

  it("state-dir helper resolves ~/.nemoclaw/state from a single shared helper", () => {
    const resolved = resolveNemoclawStateDir("/tmp/example-home");
    expect(resolved).toBe(path.join("/tmp/example-home", ".nemoclaw", "state"));
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
