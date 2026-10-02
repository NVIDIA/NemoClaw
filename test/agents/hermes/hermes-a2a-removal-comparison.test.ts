// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewedPreimage } from "./hermes-a2a-removal-fixture.ts";

const patchPath = path.resolve(import.meta.dirname, "../../../agents/hermes/a2a-neutral.patch");

describe("Hermes agent-to-agent registration comparison", () => {
  it("H06 restores outbound registration when the neutralization patch is omitted (#11763)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-a2a-comparison-"));
    const plugin = path.join(directory, "plugins/platforms/a2a");
    fs.mkdirSync(plugin, { recursive: true });
    try {
      const patch = fs.readFileSync(patchPath, "utf8");
      fs.writeFileSync(
        path.join(plugin, "plugin.yaml"),
        reviewedPreimage(patch, "plugins/platforms/a2a/plugin.yaml"),
      );
      fs.writeFileSync(
        path.join(plugin, "__init__.py"),
        reviewedPreimage(patch, "plugins/platforms/a2a/__init__.py") +
          "            A2AAdapter\n        )\n    except Exception:\n        raise\n",
      );
      fs.writeFileSync(path.join(plugin, "adapter.py"), "class A2AAdapter: pass\n");
      fs.writeFileSync(
        path.join(plugin, "tools.py"),
        "def register_tools(ctx):\n    ctx.outbound.extend(['a2a_discover', 'a2a_call', 'a2a_list', 'a2a_history', 'a2a_orchestrate'])\n",
      );
      const program =
        "import json; from plugins.platforms.a2a import register\nclass Context:\n    outbound = []\n    inbound = []\n    def register_platform(self, adapter): self.inbound.append(adapter.__name__)\nctx = Context(); register(ctx); print(json.dumps({'outbound': ctx.outbound, 'inbound': ctx.inbound}))";
      const probe = () =>
        spawnSync("python3", ["-B", "-c", program], {
          encoding: "utf8",
          timeout: 5000,
          env: { PATH: process.env.PATH, PYTHONPATH: directory },
        });
      const native = probe();
      expect(native.status, native.stderr).toBe(0);
      expect(JSON.parse(native.stdout)).toEqual({
        outbound: ["a2a_discover", "a2a_call", "a2a_list", "a2a_history", "a2a_orchestrate"],
        inbound: ["A2AAdapter"],
      });
      const applied = spawnSync("git", ["apply", patchPath], {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(applied.status, applied.stderr).toBe(0);
      const managed = probe();
      expect(managed.status, managed.stderr).toBe(0);
      expect(JSON.parse(managed.stdout)).toEqual({ outbound: [], inbound: ["A2AAdapter"] });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
