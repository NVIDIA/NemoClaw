// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectBuildContextStats,
  stageLegacySandboxBuildContext,
  stageOptimizedSandboxBuildContext,
} from "../dist/lib/sandbox-build-context";

describe("sandbox build context staging", () => {
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
      expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "codex-acp-wrapper.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "generate-openclaw-config.py"))).toBe(
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
