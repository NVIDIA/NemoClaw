// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that sandbox lifecycle operations clean up host-side Docker images.
// See: https://github.com/NVIDIA/NemoClaw/issues/2086

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  removeSandboxImage,
  removeSandboxRegistryEntry,
} from "../src/lib/sandbox-destroy-action";
import { getSandboxDeleteOutcome } from "../src/lib/sandbox-destroy-helpers";
import { normalizeGarbageCollectImagesOptions } from "../src/lib/lifecycle-options";
import { help as renderRootHelp } from "../src/lib/root-help-action";

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
  const registrySrc = fs.readFileSync(path.join(ROOT, "src/lib/registry.ts"), "utf-8");

  it("SandboxEntry interface includes imageTag field", () => {
    expect(registrySrc).toMatch(/imageTag\?:\s*string\s*\|\s*null/);
  });

  it("registerSandbox persists imageTag", () => {
    // The registerSandbox function should include imageTag in the stored entry
    const registerMatch = registrySrc.match(/function registerSandbox[\s\S]*?^}/m);
    expect(registerMatch).toBeTruthy();
    if (!registerMatch) {
      throw new Error("Expected registerSandbox() in src/lib/registry.ts");
    }
    expect(registerMatch[0]).toContain("imageTag");
  });
});

describe("image cleanup: gc command exists (#2086)", () => {
  const nemoclawSrc = fs.readFileSync(path.join(ROOT, "src/nemoclaw.ts"), "utf-8");
  const registrySrc = fs.readFileSync(path.join(ROOT, "src/lib/command-registry.ts"), "utf-8");

  it("gc is a global command", () => {
    // GLOBAL_COMMANDS is now derived from the command registry.
    expect(registrySrc).toContain('"nemoclaw gc"');
    expect(nemoclawSrc).toContain("globalCommandTokens()");
  });

  it("gc command is dispatched through the oclif bridge", () => {
    expect(nemoclawSrc).toContain("resolveGlobalOclifDispatch");
    expect(registrySrc).toContain('"nemoclaw gc"');
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
