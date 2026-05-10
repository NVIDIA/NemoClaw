// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { runWechatHostQrLogin } from "../../../dist/ext/wechat/login";
import type { FetchLike } from "../../../dist/ext/wechat/qr";

type StatusBody = {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
};

interface ScriptedRoute {
  match: (url: string) => boolean;
  bodies: StatusBody[] | { qrcode: string; qrcode_img_content: string }[];
}

/** Builds a fetch that walks a scripted sequence per matching route. The
 *  test asserts on the resulting login result, so timing/ordering of polls
 *  is observable through the route's body queue. */
function scriptedFetch(routes: ScriptedRoute[]): { fetch: FetchLike; calls: string[] } {
  const queues = routes.map((r) => ({ ...r, queue: [...r.bodies] }));
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const route = queues.find((r) => r.match(url));
    if (!route) {
      return { ok: false, status: 599, text: async () => `unmatched ${url}` };
    }
    const body = route.queue.length > 0 ? route.queue.shift()! : route.bodies[route.bodies.length - 1];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetch, calls };
}

const isInit = (u: string) => u.includes("/ilink/bot/get_bot_qrcode");
const isStatus = (u: string) => u.includes("/ilink/bot/get_qrcode_status");

const noopRender = (): void => {};
const noopLog = (): void => {};
const fastSleep = async (): Promise<void> => {};

describe("runWechatHostQrLogin", () => {
  it("returns ok with the bot token + per-account metadata on confirmed", async () => {
    const { fetch } = scriptedFetch([
      {
        match: isInit,
        bodies: [{ qrcode: "qr-cookie-1", qrcode_img_content: "https://example.com/qr/1" }],
      },
      {
        match: isStatus,
        bodies: [
          { status: "wait" },
          { status: "scaned" },
          {
            status: "confirmed",
            bot_token: "secret-bot-token",
            ilink_bot_id: "bot-123",
            baseurl: "https://idc-9.weixin.qq.com",
            ilink_user_id: "user-abc",
          },
        ],
      },
    ]);

    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });

    expect(result).toEqual({
      kind: "ok",
      credentials: {
        token: "secret-bot-token",
        accountId: "bot-123",
        baseUrl: "https://idc-9.weixin.qq.com",
        userId: "user-abc",
      },
    });
  });

  it("follows scaned_but_redirect by switching the polling base URL", async () => {
    const calls: string[] = [];
    const { fetch } = scriptedFetch([
      {
        match: isInit,
        bodies: [{ qrcode: "qr-cookie-2", qrcode_img_content: "https://example.com/qr/2" }],
      },
      {
        match: isStatus,
        bodies: [
          { status: "scaned_but_redirect", redirect_host: "idc-3.weixin.qq.com" },
          {
            status: "confirmed",
            bot_token: "tok-2",
            ilink_bot_id: "bot-2",
            baseurl: "https://idc-3.weixin.qq.com",
            ilink_user_id: "user-2",
          },
        ],
      },
    ]);

    const tracingFetch: FetchLike = async (url, init) => {
      calls.push(url);
      return fetch(url, init);
    };

    const result = await runWechatHostQrLogin({
      fetch: tracingFetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });

    expect(result.kind).toBe("ok");
    // First poll hits the bootstrap host; after the redirect, polling
    // moves to the IDC the server pointed us at.
    const statusCalls = calls.filter((u) => u.includes("get_qrcode_status"));
    expect(statusCalls[0]).toContain("ilinkai.weixin.qq.com");
    expect(statusCalls[1]).toContain("idc-3.weixin.qq.com");
  });

  it("refreshes the QR up to 3 times before giving up with kind=expired", async () => {
    const { fetch } = scriptedFetch([
      {
        match: isInit,
        bodies: [
          { qrcode: "q1", qrcode_img_content: "u1" },
          { qrcode: "q2", qrcode_img_content: "u2" },
          { qrcode: "q3", qrcode_img_content: "u3" },
        ],
      },
      {
        // Every status response is "expired" until refresh budget exhausts.
        match: isStatus,
        bodies: [{ status: "expired" }],
      },
    ]);

    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });

    expect(result).toEqual({ kind: "expired", reason: "max_refresh_exceeded" });
  });

  it("returns kind=timeout when the deadline elapses without confirmation", async () => {
    const { fetch } = scriptedFetch([
      { match: isInit, bodies: [{ qrcode: "q", qrcode_img_content: "u" }] },
      { match: isStatus, bodies: [{ status: "wait" }] },
    ]);

    let virtualNow = 1_000_000;
    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      // sleep advances the virtual clock so the deadline is hit deterministically.
      sleep: async (ms) => {
        virtualNow += ms;
      },
      now: () => virtualNow,
      totalTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    expect(result).toEqual({ kind: "timeout" });
  });

  it("returns kind=aborted when an external signal fires before the first poll", async () => {
    const { fetch } = scriptedFetch([
      { match: isInit, bodies: [{ qrcode: "q", qrcode_img_content: "u" }] },
      { match: isStatus, bodies: [{ status: "wait" }] },
    ]);

    const controller = new AbortController();
    controller.abort();
    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
      signal: controller.signal,
    });

    expect(result).toEqual({ kind: "aborted" });
  });

  it("returns kind=error when the QR init request fails", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("DNS lookup failed");
    };
    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });
    expect(result.kind).toBe("error");
  });

  it("returns kind=error when confirmed but the server omits required metadata", async () => {
    const { fetch } = scriptedFetch([
      { match: isInit, bodies: [{ qrcode: "q", qrcode_img_content: "u" }] },
      {
        match: isStatus,
        // missing baseurl + ilink_user_id — orchestrator must surface this
        // as an error rather than silently returning partial credentials.
        bodies: [{ status: "confirmed", bot_token: "tok", ilink_bot_id: "bot" }],
      },
    ]);
    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });
    expect(result.kind).toBe("error");
  });
});
