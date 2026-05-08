// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that sandbox lifecycle operations clean up host-side Docker images.
// See: https://github.com/NVIDIA/NemoClaw/issues/2086

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  removeSandboxImage,
  removeSandboxRegistryEntry,
  removeShieldsState,
} from "../src/lib/actions/sandbox/destroy";
import { getSandboxDeleteOutcome } from "../src/lib/domain/sandbox/destroy";
import { normalizeGarbageCollectImagesOptions } from "../src/lib/domain/lifecycle/options";
import { help as renderRootHelp } from "../src/lib/actions/root-help";
import { COMMANDS, globalCommandTokens } from "../src/lib/cli/command-registry";
import { getRegisteredOclifCommandMetadata } from "../src/lib/cli/oclif-metadata";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("image cleanup: sandbox destroy removes Docker image (#2086)", () => {
  it("removes sandbox images before deleting the registry entry", () => {
    const calls: string[] = [];

    const removed = removeSandboxRegistryEntry("alpha", {
      removeImage: (sandboxName) => calls.push(`image:${sandboxName}`),
      removeSandbox: (sandboxName) => {
        calls.push(`registry:${sandboxName}`);
        return true;
      },
    });

    expect(removed).toBe(true);
    expect(calls).toEqual(["image:alpha", "registry:alpha"]);
  });

  it("removeSandboxImage calls docker rmi for recorded image tags", () => {
    const removedTags: string[] = [];

    removeSandboxImage("alpha", {
      getSandbox: () => ({ name: "alpha", imageTag: "openshell/sandbox-from:123" }) as any,
      dockerRmi: (tag) => {
        removedTags.push(tag);
        return { status: 0 } as any;
      },
    });

    expect(removedTags).toEqual(["openshell/sandbox-from:123"]);
  });

  it("removeSandboxImage gracefully handles missing imageTag", () => {
    const removedTags: string[] = [];

    removeSandboxImage("alpha", {
      getSandbox: () => ({ name: "alpha", imageTag: null }) as any,
      dockerRmi: (tag) => {
        removedTags.push(tag);
        return { status: 0 } as any;
      },
    });

    expect(removedTags).toEqual([]);
  });

  it("treats missing sandbox delete results as already gone", () => {
    expect(
      getSandboxDeleteOutcome({ status: 1, stderr: "Error: sandbox alpha not found" }),
    ).toEqual({
      output: "Error: sandbox alpha not found",
      alreadyGone: true,
    });
  });
});

describe("image cleanup: onboard records imageTag in registry (#2086)", () => {
  const onboardSrc = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");

  it("buildId is captured before patchStagedDockerfile", () => {
    // buildId should be a named variable, not an inline Date.now()
    expect(onboardSrc).toContain("const buildId = String(Date.now())");
  });

  it("registerSandbox uses resolvedImageTag parsed from build output", () => {
    expect(onboardSrc).toContain("resolvedImageTag");
    expect(onboardSrc).toMatch(/sandbox-from:\\d\+/);
    expect(onboardSrc).toMatch(/imageTag:\s*resolvedImageTag/);
    expect(onboardSrc).toMatch(/buildId/);
    expect(onboardSrc).toMatch(/console\.warn/);
  });

  it("onboard recreate path cleans up old image", () => {
    // When recreating, the old image should be removed
    const match = onboardSrc.match(/if \(previousEntry\?\.imageTag\)[\s\S]*?^\s*}/m);
    expect(match).toBeTruthy();
    if (!match) throw new Error("Expected previousEntry image cleanup block in src/lib/onboard.ts");
    expect(match[0]).toMatch(/dockerRmi\(|docker.*\.rmi\(/);
  });
});

describe("image cleanup: registry stores imageTag (#2086)", () => {
  const registrySrc = fs.readFileSync(path.join(ROOT, "src/lib/state/registry.ts"), "utf-8");

  it("SandboxEntry interface includes imageTag field", () => {
    expect(registrySrc).toMatch(/imageTag\?:\s*string\s*\|\s*null/);
  });

  it("registerSandbox persists imageTag", () => {
    // The registerSandbox function should include imageTag in the stored entry
    const registerMatch = registrySrc.match(/function registerSandbox[\s\S]*?^}/m);
    expect(registerMatch).toBeTruthy();
    if (!registerMatch) {
      throw new Error("Expected registerSandbox() in src/lib/state/registry.ts");
    }
    expect(registerMatch[0]).toContain("imageTag");
  });
});

describe("shields state cleanup on destroy (#3114)", () => {
  it("removes shields and shields-timer state files for the sandbox", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    try {
      const shieldsFile = path.join(tmpDir, "shields-alpha.json");
      const timerFile = path.join(tmpDir, "shields-timer-alpha.json");
      fs.writeFileSync(shieldsFile, JSON.stringify({ shieldsDown: false }));
      fs.writeFileSync(timerFile, JSON.stringify({ pid: 12345 }));

      removeShieldsState("alpha", tmpDir);

      expect(fs.existsSync(shieldsFile)).toBe(false);
      expect(fs.existsSync(timerFile)).toBe(false);
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
      fs.writeFileSync(otherFile, JSON.stringify({ shieldsDown: false }));

      removeShieldsState("alpha", tmpDir);

      expect(fs.existsSync(otherFile)).toBe(true);
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
      removeShieldsState("../../shields-traversal", tmpDir);

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
