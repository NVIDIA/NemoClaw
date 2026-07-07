// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);

describe("compiled rebuild loader boundary", () => {
  it("keeps the rebuild graph lazy until upgrade forwarding (#6245)", () => {
    const upgradePath = path.join(repoRoot, "dist", "lib", "actions", "upgrade-sandboxes.js");
    const rebuildPath = path.join(repoRoot, "dist", "lib", "actions", "sandbox", "rebuild.js");
    const script = `
const assert = require("node:assert/strict");
const Module = require("node:module");
const upgradePath = ${JSON.stringify(upgradePath)};
const rebuildPath = ${JSON.stringify(rebuildPath)};
const originalLoad = Module._load;
let rebuildRequests = 0;
let forwardedArgs = null;
Module._load = function (request, parent, isMain) {
  if (request === "./sandbox/rebuild" && parent?.filename === upgradePath) {
    rebuildRequests += 1;
    return {
      rebuildSandbox: async (...args) => {
        forwardedArgs = args;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
(async () => {
  const upgrade = require(upgradePath);
  assert.equal(require.cache[rebuildPath], undefined);
  assert.equal(rebuildRequests, 0);
  await upgrade.upgradeSandboxesDependencies.rebuildSandbox("alpha", ["--yes"], {
    throwOnError: true,
  });
  assert.equal(rebuildRequests, 1);
  assert.deepEqual(forwardedArgs, ["alpha", ["--yes"], { throwOnError: true }]);
  process.stdout.write("ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

    expect(
      execFileSync(process.execPath, ["-e", script], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5_000,
      }),
    ).toBe("ok");
  });

  it("preserves the public rebuild facade exports (#6245)", () => {
    const rebuild = require("../../dist/lib/actions/sandbox/rebuild.js") as {
      buildRefreshMutableOpenClawConfigHashCommand?: (configDir?: string) => string;
      stageMessagingManifestPlanForRebuild?: (...args: unknown[]) => Promise<unknown>;
    };

    expect(rebuild.buildRefreshMutableOpenClawConfigHashCommand).toBeTypeOf("function");
    expect(rebuild.stageMessagingManifestPlanForRebuild).toBeTypeOf("function");
    expect(
      rebuild.buildRefreshMutableOpenClawConfigHashCommand?.("/tmp/openclaw config"),
    ).toContain("config_dir='/tmp/openclaw config'");
  });
});
