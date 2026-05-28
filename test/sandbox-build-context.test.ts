// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectBuildContextStats,
  normalizeReadModesForDockerCopy,
  stageLegacySandboxBuildContext,
  stageOptimizedSandboxBuildContext,
} from "../dist/lib/sandbox/build-context";

describe("sandbox build context staging", () => {
  function writeBuildContextFixture(sourceRoot: string) {
    const blueprintManifestDir = path.join(
      sourceRoot,
      "nemoclaw-blueprint",
      "model-specific-setup",
      "openclaw",
    );

    function writeFixture(relativePath: string, content = "fixture\n", mode = 0o644) {
      const target = path.join(sourceRoot, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { mode });
      fs.chmodSync(target, mode);
    }

    writeFixture("Dockerfile");
    for (const fileName of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "openclaw.plugin.json",
    ]) {
      writeFixture(path.join("nemoclaw", fileName), "{}\n", 0o600);
    }
    writeFixture(path.join("nemoclaw", "src", "index.ts"), "fixture\n", 0o600);
    fs.chmodSync(path.join(sourceRoot, "nemoclaw"), 0o700);
    fs.chmodSync(path.join(sourceRoot, "nemoclaw", "src"), 0o700);
    writeFixture(path.join("nemoclaw-blueprint", "blueprint.yaml"));
    writeFixture(path.join("nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"));
    writeFixture(path.join("nemoclaw-blueprint", "scripts", "http-proxy-fix.js"));
    writeFixture(
      path.join(
        "nemoclaw-blueprint",
        "openclaw-plugins",
        "kimi-inference-compat",
        "openclaw.plugin.json",
      ),
      "{}\n",
    );
    writeFixture(
      path.join("nemoclaw-blueprint", "openclaw-plugins", "kimi-inference-compat", "index.js"),
      "fixture\n",
      0o600,
    );
    writeFixture(
      path.join(
        "nemoclaw-blueprint",
        "model-specific-setup",
        "openclaw",
        "kimi-k2.6-managed-inference.json",
      ),
      "{}\n",
      0o600,
    );
    fs.chmodSync(path.join(sourceRoot, "nemoclaw-blueprint", "model-specific-setup"), 0o700);
    fs.chmodSync(blueprintManifestDir, 0o700);
    writeFixture(path.join("scripts", "nemoclaw-start.sh"));
    writeFixture(path.join("scripts", "codex-acp-wrapper.sh"));
    writeFixture(path.join("scripts", "lib", "sandbox-init.sh"));
    writeFixture(path.join("scripts", "generate-openclaw-config.py"));
    writeFixture(path.join("scripts", "openclaw-build-messaging-plugins.py"));
    writeFixture(path.join("scripts", "seed-wechat-accounts.py"));
    writeFixture(path.join("scripts", "patch-openclaw-tool-catalog.js"));
    writeFixture(path.join("scripts", "patch-openclaw-chat-send.js"));
  }

  function expectStagedNemoclawModes(buildCtx: string) {
    const stagedNemoclaw = path.join(buildCtx, "nemoclaw");
    const stagedSrc = path.join(stagedNemoclaw, "src");
    const stagedPackageJson = path.join(stagedNemoclaw, "package.json");
    const stagedIndexTs = path.join(stagedSrc, "index.ts");

    const stagedNemoclawMode = fs.statSync(stagedNemoclaw).mode & 0o777;
    expect(stagedNemoclawMode & 0o555).toBe(0o555);
    expect(stagedNemoclawMode & 0o002).toBe(0);
    const stagedSrcMode = fs.statSync(stagedSrc).mode & 0o777;
    expect(stagedSrcMode & 0o555).toBe(0o555);
    expect(stagedSrcMode & 0o002).toBe(0);
    expect((fs.statSync(stagedPackageJson).mode & 0o777).toString(8)).toBe("644");
    expect((fs.statSync(stagedIndexTs).mode & 0o777).toString(8)).toBe("644");
  }

  function expectStagedBlueprintModes(buildCtx: string) {
    const stagedBlueprint = path.join(buildCtx, "nemoclaw-blueprint");
    const stagedManifestDir = path.join(stagedBlueprint, "model-specific-setup", "openclaw");
    const stagedManifest = path.join(stagedManifestDir, "kimi-k2.6-managed-inference.json");
    const stagedPlugin = path.join(
      stagedBlueprint,
      "openclaw-plugins",
      "kimi-inference-compat",
      "index.js",
    );

    const stagedManifestDirMode = fs.statSync(stagedManifestDir).mode & 0o777;
    expect(stagedManifestDirMode & 0o555).toBe(0o555);
    expect(stagedManifestDirMode & 0o002).toBe(0);
    expect((fs.statSync(stagedManifest).mode & 0o777).toString(8)).toBe("644");
    expect((fs.statSync(stagedPlugin).mode & 0o777).toString(8)).toBe("644");
  }

  it("normalizes copied blueprint modes with chmod a+rX semantics", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-unit-"));
    const blueprintDir = path.join(tmpDir, "nemoclaw-blueprint");
    const manifestDir = path.join(blueprintDir, "model-specific-setup", "openclaw");
    const manifestPath = path.join(manifestDir, "kimi-k2.6-managed-inference.json");
    const executablePath = path.join(blueprintDir, "scripts", "helper.sh");
    const symlinkPath = path.join(blueprintDir, "manifest-link.json");

    try {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.mkdirSync(path.dirname(executablePath), { recursive: true });
      fs.writeFileSync(manifestPath, "{}\n", { mode: 0o600 });
      fs.writeFileSync(executablePath, "#!/bin/sh\n", { mode: 0o700 });
      fs.symlinkSync(manifestPath, symlinkPath);
      fs.chmodSync(blueprintDir, 0o700);
      fs.chmodSync(path.join(blueprintDir, "model-specific-setup"), 0o700);
      fs.chmodSync(manifestDir, 0o700);
      fs.chmodSync(manifestPath, 0o600);
      fs.chmodSync(executablePath, 0o700);

      normalizeReadModesForDockerCopy(blueprintDir);

      expect((fs.statSync(blueprintDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(manifestDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(manifestPath).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(executablePath).mode & 0o777).toString(8)).toBe("755");
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging makes copied blueprint manifests world-readable", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-mode-"));

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageOptimizedSandboxBuildContext(sourceRoot, tmpDir);
      expectStagedBlueprintModes(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging makes copied nemoclaw plugin sources world-readable", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-nemoclaw-mode-"));

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageOptimizedSandboxBuildContext(sourceRoot, tmpDir);
      expectStagedNemoclawModes(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy staging makes copied blueprint manifests world-readable", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-legacy-mode-"));

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageLegacySandboxBuildContext(sourceRoot, tmpDir);
      expectStagedBlueprintModes(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy staging makes copied nemoclaw plugin sources world-readable", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-build-context-legacy-nemoclaw-mode-"),
    );

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageLegacySandboxBuildContext(sourceRoot, tmpDir);
      expectStagedNemoclawModes(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging excludes blueprint .venv and extra scripts while preserving required files", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-opt-"));

    try {
      const { buildCtx } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", ".venv"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", "blueprint.yaml"))).toBe(true);
      expect(
        fs.existsSync(
          path.join(buildCtx, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", "scripts", "http-proxy-fix.js")),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            buildCtx,
            "nemoclaw-blueprint",
            "openclaw-plugins",
            "kimi-inference-compat",
            "openclaw.plugin.json",
          ),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            buildCtx,
            "nemoclaw-blueprint",
            "model-specific-setup",
            "openclaw",
            "kimi-k2.6-managed-inference.json",
          ),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "codex-acp-wrapper.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "generate-openclaw-config.py"))).toBe(
        true,
      );
      expect(
        fs.existsSync(path.join(buildCtx, "scripts", "openclaw-build-messaging-plugins.py")),
      ).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "seed-wechat-accounts.py"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-tool-catalog.js"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-chat-send.js"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(buildCtx, "scripts", "lib", "sandbox-init.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "setup.sh"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging is smaller than the legacy build context", { timeout: 120_000 }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-compare-"));

    try {
      const legacy = stageLegacySandboxBuildContext(repoRoot, tmpDir);
      const optimized = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);
      const legacyStats = collectBuildContextStats(legacy.buildCtx);
      const optimizedStats = collectBuildContextStats(optimized.buildCtx);

      expect(optimizedStats.fileCount).toBeLessThan(legacyStats.fileCount);
      expect(optimizedStats.totalBytes).toBeLessThan(legacyStats.totalBytes);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
