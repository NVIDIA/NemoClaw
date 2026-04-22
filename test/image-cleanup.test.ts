// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that sandbox lifecycle operations clean up host-side Docker images.
// See: https://github.com/NVIDIA/NemoClaw/issues/2086

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("image cleanup: sandbox destroy removes Docker image (#2086)", () => {
  const nemoclawSrc = fs.readFileSync(path.join(ROOT, "src/nemoclaw.ts"), "utf-8");

  it("removeSandboxImage() helper exists and calls docker rmi", () => {
    expect(nemoclawSrc).toContain("function removeSandboxImage(");
    expect(nemoclawSrc).toMatch(/docker.*rmi/);
  });

  it("sandboxDestroy calls removeSandboxImage before registry.removeSandbox", () => {
    // Extract the sandboxDestroy function body
    const destroyMatch = nemoclawSrc.match(/async function sandboxDestroy[\s\S]*?^}/m);
    expect(destroyMatch).toBeTruthy();
    const destroyBody = destroyMatch[0];

    // removeSandboxImage must appear before registry.removeSandbox
    const removeImageIdx = destroyBody.indexOf("removeSandboxImage(");
    const removeRegistryIdx = destroyBody.indexOf("registry.removeSandbox(");
    expect(removeImageIdx).toBeGreaterThan(-1);
    expect(removeRegistryIdx).toBeGreaterThan(-1);
    expect(removeImageIdx).toBeLessThan(removeRegistryIdx);
  });

  it("sandboxRebuild calls removeSandboxImage before registry.removeSandbox", () => {
    const rebuildMatch = nemoclawSrc.match(
      /async function sandboxRebuild[\s\S]*?^\s*console\.log\(`\s*\$\{G\}.*Sandbox.*rebuilt/m,
    );
    expect(rebuildMatch).toBeTruthy();
    const rebuildBody = rebuildMatch[0];

    const removeImageIdx = rebuildBody.indexOf("removeSandboxImage(");
    const removeRegistryIdx = rebuildBody.indexOf("registry.removeSandbox(");
    expect(removeImageIdx).toBeGreaterThan(-1);
    expect(removeRegistryIdx).toBeGreaterThan(-1);
    expect(removeImageIdx).toBeLessThan(removeRegistryIdx);
  });

  it("removeSandboxImage gracefully handles missing imageTag", () => {
    // The function should check for imageTag before attempting removal
    const fnMatch = nemoclawSrc.match(/function removeSandboxImage[\s\S]*?^}/m);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch[0]).toContain("imageTag");
  });
});

describe("image cleanup: onboard records imageTag in registry (#2086)", () => {
  const onboardSrc = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");

  it("buildId is captured before patchStagedDockerfile", () => {
    // buildId should be a named variable, not an inline Date.now()
    expect(onboardSrc).toContain("const buildId = String(Date.now())");
  });

  it("registerSandbox includes imageTag with buildId", () => {
    expect(onboardSrc).toMatch(/imageTag:\s*`openshell\/sandbox-from:\$\{buildId\}`/);
  });

  it("onboard recreate path cleans up old image", () => {
    // When recreating, the old image should be removed
    expect(onboardSrc).toMatch(/previousEntry\?\.imageTag/);
    expect(onboardSrc).toMatch(/docker.*rmi.*previousEntry\.imageTag/);
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
    expect(registerMatch[0]).toContain("imageTag");
  });
});

describe("image cleanup: gc command exists (#2086)", () => {
  const nemoclawSrc = fs.readFileSync(path.join(ROOT, "src/nemoclaw.ts"), "utf-8");

  it("gc is a global command", () => {
    const globalBlock = nemoclawSrc.match(/GLOBAL_COMMANDS\s*=\s*new Set\(\[[\s\S]*?\]\)/);
    expect(globalBlock).toBeTruthy();
    expect(globalBlock[0]).toContain('"gc"');
  });

  it("gc command is dispatched in the CLI switch", () => {
    expect(nemoclawSrc).toContain('case "gc"');
    expect(nemoclawSrc).toContain("garbageCollectImages");
  });

  it("garbageCollectImages lists sandbox-from images and cross-references registry", () => {
    const gcMatch = nemoclawSrc.match(/async function garbageCollectImages[\s\S]*?^}/m);
    expect(gcMatch).toBeTruthy();
    const gcBody = gcMatch[0];

    // Must query docker for sandbox-from images
    expect(gcBody).toContain("openshell/sandbox-from");
    // Must consult the registry for in-use tags
    expect(gcBody).toContain("registry.listSandboxes");
    // Must support --dry-run
    expect(gcBody).toContain("dry-run");
    // Must support --yes
    expect(gcBody).toContain("--yes");
  });

  it("gc appears in help text", () => {
    const helpMatch = nemoclawSrc.match(/function help\(\)[\s\S]*?^}/m);
    expect(helpMatch).toBeTruthy();
    expect(helpMatch[0]).toContain("nemoclaw gc");
  });
});
