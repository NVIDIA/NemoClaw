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

  it("keeps the installed WeChat HTTP adapter source free of Vitest aliases", () => {
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

  it("preserves WeChat credential headers and frames the request body", async () => {
    let server!: http.Server;
    const received = new Promise<{ body: string; rawHeaders: string[] }>((resolve) => {
      server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          resolve({ body: Buffer.concat(chunks).toString("utf8"), rawHeaders: request.rawHeaders });
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ret":0}');
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    expect(address).toEqual(expect.objectContaining({ port: expect.any(Number) }));
    const port = (address as AddressInfo).port;
    const body = '{"msg":"hello"}';

    try {
      const response = await fetchFakeWechatWithNodeHttp(
        `http://127.0.0.1:${String(port)}/ilink/bot/sendmessage`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer openshell:resolve:env:v9_WECHAT_BOT_TOKEN",
            AuthorizationType: "ilink_bot_token",
            "Content-Type": "application/json",
          },
          body,
        },
      );
      const request = await received;

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ret: 0 });
      expect(request.body).toBe(body);
      expect(request.rawHeaders).toEqual(
        expect.arrayContaining([
          "Authorization",
          "Bearer openshell:resolve:env:v9_WECHAT_BOT_TOKEN",
          "AuthorizationType",
          "ilink_bot_token",
          "Content-Type",
          "application/json",
          "Content-Length",
          String(Buffer.byteLength(body)),
        ]),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it("preserves the last WeChat API error after 20 failed readiness attempts", async () => {
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
