// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildHostUninstallPlan, classifyShimPath } from "./uninstall-plan";
import { flattenUninstallPlan } from "../domain/uninstall/plan";

describe("uninstall plan actions", () => {
  it("classifies an on-disk dev shim", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-plan-shim-"));
    const shim = path.join(tmp, "nemoclaw");
    try {
      fs.writeFileSync(
        shim,
        [
          "#!/usr/bin/env bash",
          "# NemoClaw dev-shim - managed by scripts/npm-link-or-shim.sh",
          'export PATH="/tmp/node-bin:$PATH"',
          'exec "/tmp/checkout/bin/nemoclaw.js" "$@"',
          "",
        ].join("\n"),
      );

      expect(classifyShimPath(shim)).toMatchObject({ kind: "managed-dev-shim", remove: true });
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("builds a host uninstall plan with shim classification and env-derived paths", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-plan-"));
    const shimDir = path.join(tmp, ".local", "bin");
    const shim = path.join(shimDir, "nemoclaw");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(shim, "#!/usr/bin/env bash\necho user\n");

    try {
      const plan = buildHostUninstallPlan({
        deleteModels: false,
        env: { HOME: tmp, TMPDIR: path.join(tmp, "tmp") },
        keepOpenShell: false,
      });
      const actions = flattenUninstallPlan(plan);

      expect(actions).toEqual(expect.arrayContaining([{ kind: "preserve-shim", reason: "regular file is not an installer-managed shim" }]));
      expect(actions).toEqual(expect.arrayContaining([{ kind: "delete-path", path: path.join(tmp, ".nemoclaw") }]));
      expect(actions).toEqual(expect.arrayContaining([{ kind: "delete-runtime-glob", pattern: path.join(tmp, "tmp", "nemoclaw-create-*.log") }]));
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
