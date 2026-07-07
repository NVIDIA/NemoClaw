// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);
const upgradePath = path.join(repoRoot, "dist", "lib", "actions", "upgrade-sandboxes.js");
const rebuildPath = path.join(repoRoot, "dist", "lib", "actions", "sandbox", "rebuild.js");

type UpgradeModule = typeof import("../../src/lib/actions/upgrade-sandboxes");

function snapshotRequireCache(): typeof require.cache {
  return { ...require.cache };
}

function restoreRequireCache(snapshot: typeof require.cache): void {
  for (const modulePath of Object.keys(require.cache)) delete require.cache[modulePath];
  Object.assign(require.cache, snapshot);
}

describe("compiled rebuild loader boundary", () => {
  it("keeps the rebuild graph lazy until upgrade forwarding (#6245)", async () => {
    const priorCache = snapshotRequireCache();
    try {
      delete require.cache[upgradePath];
      delete require.cache[rebuildPath];
      const upgrade = require(upgradePath) as UpgradeModule;

      expect(require.cache[rebuildPath]).toBeUndefined();
      const rebuild = await upgrade.upgradeSandboxesDependencies.loadRebuildModule();
      expect(require.cache[rebuildPath]).toBeDefined();
      expect(rebuild.rebuildSandbox).toBeTypeOf("function");

      const forwardedRebuild = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(upgrade.upgradeSandboxesDependencies, "loadRebuildModule").mockResolvedValue({
        rebuildSandbox: forwardedRebuild,
      } as never);
      await upgrade.upgradeSandboxesDependencies.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
      });
      expect(forwardedRebuild).toHaveBeenCalledWith("alpha", ["--yes"], {
        throwOnError: true,
      });
    } finally {
      vi.restoreAllMocks();
      restoreRequireCache(priorCache);
    }
  });

  it("preserves the public rebuild facade exports (#6245)", () => {
    const priorCache = snapshotRequireCache();
    try {
      const rebuild = require(rebuildPath) as {
        buildRefreshMutableOpenClawConfigHashCommand?: (configDir?: string) => string;
        stageMessagingManifestPlanForRebuild?: (...args: unknown[]) => Promise<unknown>;
      };

      expect(rebuild.buildRefreshMutableOpenClawConfigHashCommand).toBeTypeOf("function");
      expect(rebuild.stageMessagingManifestPlanForRebuild).toBeTypeOf("function");
      expect(
        rebuild.buildRefreshMutableOpenClawConfigHashCommand?.("/tmp/openclaw config"),
      ).toContain("config_dir='/tmp/openclaw config'");
    } finally {
      restoreRequireCache(priorCache);
    }
  });
});
