// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { runWechatHostQrLogin } from "./login";
import { WECHAT_QR_POLL_TIMEOUT_MS, type FetchLike } from "./qr";

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
    const body =
      route.queue.length > 0 ? route.queue.shift()! : route.bodies[route.bodies.length - 1];
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

function pendingBodyResponse(
  markBodyStarted: () => void,
): (init?: Parameters<FetchLike>[1]) => ReturnType<FetchLike> {
  return async (init) => ({
    ok: true,
    status: 200,
    text: async () => {
      markBodyStarted();
      return await new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    },
  });
}

function pendingStreamingBodyResponse(
  markBodyStarted: () => void,
  markCancelRequested: () => void,
): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start() {
        markBodyStarted();
      },
      cancel() {
        markCancelRequested();
        return new Promise<void>(() => {});
      },
    }),
    text: async () => {
      throw new Error("streaming response must not use text()");
    },
  });
}

afterEach(() => vi.useRealTimers());

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
    const logs: string[] = [];
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
      log: (message) => logs.push(message),
      sleep: fastSleep,
    });

    expect(result.kind).toBe("ok");
    // First poll hits the bootstrap host; after the redirect, polling
    // moves to the IDC the server pointed us at.
    const statusCalls = calls.filter((u) => u.includes("get_qrcode_status"));
    expect(statusCalls[0]).toContain("ilinkai.weixin.qq.com");
    expect(statusCalls[1]).toContain("idc-3.weixin.qq.com");
    expect(logs.join("\n")).toContain("polling validated IDC origin");
    expect(logs.join("\n")).not.toContain("idc-3.weixin.qq.com");
  });

  it("omits a sensitive fatal polling body from logs and the returned error", async () => {
    const logs: string[] = [];
    const sensitiveBody =
      "bot_token=secret-value qrcode=session-value https://idc-37.weixin.qq.com/status";
    const fetch: FetchLike = async (url) =>
      isInit(url)
        ? {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                qrcode: "qr-cookie-redaction",
                qrcode_img_content: "https://example.com/qr/redaction",
              }),
          }
        : {
            ok: false,
            status: 400,
            text: async () => sensitiveBody,
          };

    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: (message) => logs.push(message),
      sleep: fastSleep,
    });

    expect(result).toEqual({ kind: "error", message: "http: WeChat QR status returned 400" });
    expect(JSON.stringify(result)).not.toContain(sensitiveBody);
    expect(logs.join("\n")).not.toContain(sensitiveBody);
  });

  it.each([
    "evil.example.com",
    "*.weixin.qq.com",
    "idc-3.weixin.qq.com:8443",
    "idc-3.weixin.qq.com.evil.example",
    "idc-3.weixin.qq.com/path",
  ])(
    "rejects an invalid redirect before contacting it [case %#] (#10606)",
    async (redirectHost) => {
      const { fetch, calls } = scriptedFetch([
        {
          match: isInit,
          bodies: [{ qrcode: "qr-cookie-invalid", qrcode_img_content: "https://example.com/qr" }],
        },
        {
          match: isStatus,
          bodies: [{ status: "scaned_but_redirect", redirect_host: redirectHost }],
        },
      ]);

      const result = await runWechatHostQrLogin({
        fetch,
        renderQr: noopRender,
        log: noopLog,
        sleep: fastSleep,
      });

      expect(result).toEqual({
        kind: "error",
        message: "WeChat login returned an invalid IDC redirect host.",
      });
      expect(calls.filter(isStatus)).toHaveLength(1);
      expect(calls).not.toContainEqual(expect.stringContaining(redirectHost));
    },
  );

  it("rejects an invalid confirmed origin without returning credentials (#10606)", async () => {
    const { fetch } = scriptedFetch([
      {
        match: isInit,
        bodies: [{ qrcode: "qr-cookie-invalid", qrcode_img_content: "https://example.com/qr" }],
      },
      {
        match: isStatus,
        bodies: [
          {
            status: "confirmed",
            bot_token: "secret-bot-token",
            ilink_bot_id: "bot-123",
            baseurl: "https://evil.example.com",
            ilink_user_id: "user-abc",
          },
        ],
      },
    ]);

    await expect(
      runWechatHostQrLogin({ fetch, renderQr: noopRender, log: noopLog, sleep: fastSleep }),
    ).resolves.toEqual({
      kind: "error",
      message: "WeChat login returned an invalid iLink origin.",
    });
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

  it("continues polling after a successful response body times out (#10606)", async () => {
    vi.useFakeTimers();
    let markBodyStarted = () => {};
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    const responses: Array<(init?: Parameters<FetchLike>[1]) => ReturnType<FetchLike>> = [
      async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ qrcode: "q", qrcode_img_content: "u" }),
      }),
      pendingBodyResponse(markBodyStarted),
      async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "confirmed",
            bot_token: "secret-bot-token",
            ilink_bot_id: "bot-123",
            baseurl: "https://idc-3.weixin.qq.com",
            ilink_user_id: "user-abc",
          }),
      }),
    ];
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(url);
      return await responses.shift()!(init);
    };

    const login = runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });
    await bodyStarted;
    await vi.advanceTimersByTimeAsync(WECHAT_QR_POLL_TIMEOUT_MS);

    await expect(login).resolves.toMatchObject({ kind: "ok" });
    expect(calls.filter(isStatus)).toHaveLength(2);
  });

  it("bounds a pending bootstrap body by the total login deadline (#10606)", async () => {
    vi.useFakeTimers();
    let markBodyStarted = () => {};
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    const fetch: FetchLike = async (_url, init) => await pendingBodyResponse(markBodyStarted)(init);

    const login = runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
      totalTimeoutMs: 1_000,
    });
    await bodyStarted;
    const resolved = expect(login).resolves.toEqual({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await resolved;
  });

  it("bounds a pending poll body by the remaining login deadline (#10606)", async () => {
    vi.useFakeTimers();
    let markBodyStarted = () => {};
    let markCancelRequested = () => {};
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    const cancelRequested = new Promise<void>((resolve) => {
      markCancelRequested = resolve;
    });
    const responses: Array<(init?: Parameters<FetchLike>[1]) => ReturnType<FetchLike>> = [
      async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ qrcode: "q", qrcode_img_content: "u" }),
      }),
      () => pendingStreamingBodyResponse(markBodyStarted, markCancelRequested),
    ];
    const fetch: FetchLike = async (_url, init) => await responses.shift()!(init);

    const login = runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
      totalTimeoutMs: 1_000,
    });
    await bodyStarted;
    const resolved = expect(login).resolves.toEqual({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await cancelRequested;
    await resolved;
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

  it("aborts a pending QR initialization request", async () => {
    const controller = new AbortController();
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetch: FetchLike = async (_url, init) => {
      markFetchStarted();
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    };

    const login = runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
      signal: controller.signal,
    });
    await fetchStarted;
    controller.abort();

    await expect(login).resolves.toEqual({ kind: "aborted" });
  });

  it("aborts a pending QR refresh request", async () => {
    const controller = new AbortController();
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const responses: Array<(init?: Parameters<FetchLike>[1]) => ReturnType<FetchLike>> = [
      async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ qrcode: "q", qrcode_img_content: "u" }),
      }),
      async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: "expired" }),
      }),
      async (init) => {
        markRefreshStarted();
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    ];
    const fetch: FetchLike = async (_url, init) => await responses.shift()!(init);

    const login = runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
      signal: controller.signal,
    });
    await refreshStarted;
    controller.abort();

    await expect(login).resolves.toEqual({ kind: "aborted" });
  });

  it("omits sensitive transport details when the QR init request fails", async () => {
    const sensitiveDetail = "bot_token=secret-value qrcode=session-value";
    const fetch: FetchLike = async () => {
      throw new Error(`DNS lookup failed ${sensitiveDetail}`);
    };
    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });
    expect(result).toEqual({ kind: "error", message: "network: WeChat QR init request failed" });
    expect(JSON.stringify(result)).not.toContain(sensitiveDetail);
  });

  it("omits a sensitive QR initialization response body", async () => {
    const sensitiveBody = "bot_token=secret-value qrcode=session-value";
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 401,
      text: async () => sensitiveBody,
    });

    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });

    expect(result).toEqual({ kind: "error", message: "http: WeChat QR init returned 401" });
    expect(JSON.stringify(result)).not.toContain(sensitiveBody);
  });

  it("omits a sensitive QR refresh response body", async () => {
    const sensitiveBody = "bot_token=secret-value qrcode=session-value";
    const responses = [
      {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ qrcode: "expired-qr", qrcode_img_content: "https://example.com/qr" }),
      },
      { ok: true, status: 200, text: async () => JSON.stringify({ status: "expired" }) },
      { ok: false, status: 429, text: async () => sensitiveBody },
    ];
    const fetch: FetchLike = async () => responses.shift()!;

    const result = await runWechatHostQrLogin({
      fetch,
      renderQr: noopRender,
      log: noopLog,
      sleep: fastSleep,
    });

    expect(result).toEqual({ kind: "error", message: "http: WeChat QR init returned 429" });
    expect(JSON.stringify(result)).not.toContain(sensitiveBody);
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
