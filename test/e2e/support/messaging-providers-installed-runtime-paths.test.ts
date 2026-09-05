// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  fetchFakeWechatWithNodeHttp,
  resolveInstalledWechatPluginRoot,
  waitForInstalledWechatApi,
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

  it("keeps the installed WeChat runtime proof source syntactically valid", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      encoding: "utf8",
      input: WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE,
    });

    expect(result.status, result.stderr).toBe(0);
    expect([
      WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE.includes('process.getBuiltinModule("node:http")'),
      WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE.includes("globalThis.fetch ="),
      WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE.includes("__vite_ssr_import_"),
    ]).toEqual([true, true, false]);
  });

  it("honors the installed WeChat request abort deadline", async () => {
    const server = http.createServer((_request, _response) => {
      // Keep the response open so only the request deadline can finish the probe.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    expect(address).toEqual(expect.objectContaining({ port: expect.any(Number) }));
    const port = (address as AddressInfo).port;

    try {
      await expect(
        fetchFakeWechatWithNodeHttp(`http://127.0.0.1:${String(port)}/stalled`, {
          signal: AbortSignal.timeout(50),
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("waits for the fake WeChat API before exercising the installed runtime", async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(undefined);
    const delays: number[] = [];

    await waitForInstalledWechatApi(probe, async (milliseconds) => {
      delays.push(milliseconds);
    });

    expect(probe).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([250, 250]);
  });

  it("preserves the last WeChat API error after the route settlement deadline", async () => {
    const routeError = new TypeError("fetch failed");
    const probe = vi.fn().mockRejectedValue(routeError);
    const delays: number[] = [];

    await expect(
      waitForInstalledWechatApi(probe, async (milliseconds) => {
        delays.push(milliseconds);
      }),
    ).rejects.toBe(routeError);

    expect(probe).toHaveBeenCalledTimes(20);
    expect(delays).toEqual(Array.from({ length: 19 }, () => 250));
  });
});
