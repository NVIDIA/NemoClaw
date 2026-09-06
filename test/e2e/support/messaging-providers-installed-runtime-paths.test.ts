// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveInstalledWechatPluginRoot,
  WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE,
} from "../live/messaging-providers-wechat-runtime-proof.ts";

describe("messaging provider installed-runtime paths", () => {
  it("finds the installed WeChat runtime in its managed npm project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-runtime-location-"));
    const stateDir = path.join(dir, "state");
    const pluginRoot = path.join(
      stateDir,
      "npm",
      "projects",
      "wechat-project",
      "node_modules",
      "@tencent-weixin",
      "openclaw-weixin",
    );

    try {
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "2.4.3" }),
      );
      expect(resolveInstalledWechatPluginRoot(stateDir)).toBe(fs.realpathSync(pluginRoot));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a standalone WeChat proof with the sandbox-local policy relay", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      encoding: "utf8",
      input: WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE,
    });

    expect(result.status, result.stderr).toBe(0);
    expect([
      WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE.includes('baseUrl: "http://127.0.0.1:" + port'),
      WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE.includes('hostname: "host.openshell.internal"'),
      WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE.includes("__vite_ssr_import_"),
    ]).toEqual([true, true, false]);
  });
});
