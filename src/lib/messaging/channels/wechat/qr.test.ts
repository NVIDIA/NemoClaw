// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  encodeIlinkClientVersion,
  fetchWechatQrSession,
  pollWechatQrStatus,
  WechatQrError,
  WECHAT_ILINK_BOOTSTRAP_BASE_URL,
  WECHAT_ILINK_DEFAULT_BOT_TYPE,
  WECHAT_ILINK_MAX_RESPONSE_BYTES,
  type FetchLike,
} from "./qr";

type Capture = {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; redirect?: "error" };
};

const testServers: Server[] = [];

async function listenLoopback(server: Server): Promise<string> {
  testServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function makeFetch(responder: (req: Capture) => { ok: boolean; status: number; body: string }): {
  fetch: FetchLike;
  calls: Capture[];
} {
  const calls: Capture[] = [];
  const fetch: FetchLike = async (url, init) => {
    const capture = { url, init };
    calls.push(capture);
    const reply = responder(capture);
    return {
      ok: reply.ok,
      status: reply.status,
      text: async () => reply.body,
    };
  };
  return { fetch, calls };
}

function makePendingBodyFetch(): { fetch: FetchLike; bodyStarted: Promise<void> } {
  let markBodyStarted = () => {};
  const bodyStarted = new Promise<void>((resolve) => {
    markBodyStarted = resolve;
  });
  const fetch: FetchLike = async (_url, init) => ({
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
  return { fetch, bodyStarted };
}

function makeStreamingBodyFetch(bodyText: string): {
  fetch: FetchLike;
  usedTextFallback: () => boolean;
} {
  let textFallbackUsed = false;
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bodyText));
        controller.close();
      },
    }),
    text: async () => {
      textFallbackUsed = true;
      return bodyText;
    },
  });
  return { fetch, usedTextFallback: () => textFallbackUsed };
}

function makePendingStreamingBodyFetch(initialBody = ""): {
  fetch: FetchLike;
  bodyStarted: Promise<void>;
  cancelRequested: Promise<void>;
} {
  let markBodyStarted = () => {};
  let markCancelRequested = () => {};
  const bodyStarted = new Promise<void>((resolve) => {
    markBodyStarted = resolve;
  });
  const cancelRequested = new Promise<void>((resolve) => {
    markCancelRequested = resolve;
  });
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(initialBody));
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
  return { fetch, bodyStarted, cancelRequested };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    testServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("encodeIlinkClientVersion", () => {
  it("packs SemVer parts into iLink's uint32 layout", () => {
    expect(encodeIlinkClientVersion("2.1.7")).toBe((2 << 16) | (1 << 8) | 7);
    expect(encodeIlinkClientVersion("0.0.0")).toBe(0);
    expect(encodeIlinkClientVersion("1.0.11")).toBe((1 << 16) | 11);
  });

  it("treats missing or non-numeric parts as zero so we never throw on init", () => {
    expect(encodeIlinkClientVersion("")).toBe(0);
    expect(encodeIlinkClientVersion("abc.def")).toBe(0);
  });
});

describe("fetchWechatQrSession", () => {
  it("hits the bootstrap iLink host with bot_type=3 and the iLink-App-Id header", async () => {
    const { fetch, calls } = makeFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        qrcode: "qrcode-cookie",
        qrcode_img_content: "https://example.com/qr",
      }),
    }));

    const session = await fetchWechatQrSession({ fetch });
    expect(session.qrcode).toBe("qrcode-cookie");
    expect(session.qrcodeUrl).toBe("https://example.com/qr");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(
      `${WECHAT_ILINK_BOOTSTRAP_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${WECHAT_ILINK_DEFAULT_BOT_TYPE}`,
    );
    expect(call.init?.method).toBe("GET");
    expect(call.init?.headers?.["iLink-App-Id"]).toBe("bot");
  });

  it("blocks native transport redirects before bootstrap or polling contacts the target (#10606)", async () => {
    let redirectedRequests = 0;
    const redirectedTarget = await listenLoopback(
      createServer((_request, response) => {
        redirectedRequests += 1;
        response.end('{"status":"wait"}');
      }),
    );
    const redirector = await listenLoopback(
      createServer((_request, response) => {
        response.writeHead(302, { location: redirectedTarget });
        response.end();
      }),
    );

    await expect(
      fetchWechatQrSession({ bootstrapBaseUrl: redirector, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ kind: "network", message: "WeChat QR init request failed" });
    await expect(
      pollWechatQrStatus({ baseUrl: redirector, qrcode: "qrcode-cookie", timeoutMs: 1_000 }),
    ).resolves.toEqual({ status: "wait" });
    expect(redirectedRequests).toBe(0);
  });

  it("wraps non-2xx responses without forwarding their body", async () => {
    const sensitiveBody = "bot_token=secret-value qrcode=session-value";
    const { fetch } = makeFetch(() => ({ ok: false, status: 503, body: sensitiveBody }));
    const error = await fetchWechatQrSession({ fetch }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "WechatQrError",
      kind: "http",
      status: 503,
    });
    expect(String(error)).not.toContain(sensitiveBody);
  });

  it("rejects responses missing qrcode or qrcode_img_content fields with a parse error", async () => {
    const { fetch } = makeFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ qrcode: "ok-but-no-img" }),
    }));
    await expect(fetchWechatQrSession({ fetch })).rejects.toBeInstanceOf(WechatQrError);
  });

  it("times out while the QR response body is pending (#10606)", async () => {
    vi.useFakeTimers();
    const { fetch, bodyStarted } = makePendingBodyFetch();

    const pending = fetchWechatQrSession({ fetch, timeoutMs: 1_000 });
    await bodyStarted;
    const rejected = expect(pending).rejects.toMatchObject({
      kind: "network",
      message: "WeChat QR init request timed out after 1000ms",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });

  it("cancels while the QR response body is pending (#10606)", async () => {
    const { fetch, bodyStarted, cancelRequested } = makePendingStreamingBodyFetch();
    const controller = new AbortController();

    const pending = fetchWechatQrSession({ fetch, signal: controller.signal });
    await bodyStarted;
    controller.abort();
    await cancelRequested;

    await expect(pending).rejects.toMatchObject({
      kind: "network",
      message: "WeChat QR init request was cancelled",
    });
  });

  it("rejects an oversized QR response before parsing sensitive content (#10606)", async () => {
    const secret = "bot_token=secret-value qrcode=session-value";
    const oversizedBody = JSON.stringify({
      qrcode: secret,
      qrcode_img_content: "https://example.com/qr",
      padding: "x".repeat(WECHAT_ILINK_MAX_RESPONSE_BYTES),
    });
    const { fetch, usedTextFallback } = makeStreamingBodyFetch(oversizedBody);
    vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock").mockImplementation(() => {
      throw new Error("release failed");
    });
    const error = await fetchWechatQrSession({ fetch }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "parse",
      message: "WeChat QR init response exceeded the size limit",
    });
    expect(String(error)).not.toContain(secret);
    expect(usedTextFallback()).toBe(false);
  });

  it("rejects an oversized QR response when stream cancellation never settles (#10606)", async () => {
    vi.useFakeTimers();
    const { fetch, cancelRequested } = makePendingStreamingBodyFetch(
      "x".repeat(WECHAT_ILINK_MAX_RESPONSE_BYTES + 1),
    );
    let outcome: unknown;

    void fetchWechatQrSession({ fetch, timeoutMs: 10 }).catch((error: unknown) => {
      outcome = error;
    });
    await cancelRequested;
    await vi.advanceTimersByTimeAsync(10);

    expect(outcome).toMatchObject({
      kind: "parse",
      message: "WeChat QR init response exceeded the size limit",
    });
  });
});

describe("pollWechatQrStatus", () => {
  it("parses confirmed responses and surfaces the bot_token / metadata fields", async () => {
    const { fetch } = makeFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        status: "confirmed",
        bot_token: "secret-bot-token",
        ilink_bot_id: "bot-123",
        baseurl: "https://idc-7.weixin.qq.com",
        ilink_user_id: "user-abc",
      }),
    }));
    const result = await pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qrcode-cookie",
      fetch,
    });
    expect(result.status).toBe("confirmed");
    expect(result.bot_token).toBe("secret-bot-token");
    expect(result.ilink_bot_id).toBe("bot-123");
    expect(result.baseurl).toBe("https://idc-7.weixin.qq.com");
    expect(result.ilink_user_id).toBe("user-abc");
  });

  it("does not leak the polling origin or secret-ish qrcode token in debug logging", async () => {
    const qrToken = "secret-qr-cookie";
    const debugEvents: string[] = [];
    const { fetch, calls } = makeFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ status: "wait" }),
    }));

    await pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: qrToken,
      fetch,
      onDebug: (event) => debugEvents.push(event),
    });

    expect(calls[0]?.url).toContain(`qrcode=${qrToken}`);
    const debugText = debugEvents.join("\n");
    expect(debugText).toContain(
      "poll request → validated iLink endpoint /ilink/bot/get_qrcode_status",
    );
    expect(debugText).not.toContain("ilinkai.weixin.qq.com");
    expect(debugText).not.toContain(qrToken);
    expect(debugText).not.toContain("qrcode=");
  });

  it("returns 'wait' on transport-level failure so the orchestrator simply retries", async () => {
    const failing: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qrcode-cookie",
      fetch: failing,
    });
    expect(result.status).toBe("wait");
  });

  it("does not forward transport failure details through debug events", async () => {
    const debugEvents: string[] = [];
    const sensitiveDetail = "bot_token=secret-value qrcode=session-value";
    const failing: FetchLike = async () => {
      throw new Error(
        `${sensitiveDetail} while polling https://idc-37.weixin.qq.com/ilink/bot/get_qrcode_status`,
      );
    };

    await expect(
      pollWechatQrStatus({
        baseUrl: "https://idc-37.weixin.qq.com",
        qrcode: "qrcode-cookie",
        fetch: failing,
        onDebug: (event) => debugEvents.push(event),
      }),
    ).resolves.toEqual({ status: "wait" });

    expect(debugEvents).toContain("poll transport error (treated as wait)");
    expect(debugEvents.join("\n")).not.toContain(sensitiveDetail);
    expect(debugEvents.join("\n")).not.toContain("idc-37.weixin.qq.com");
  });

  it("cancels 5xx response bodies before treating them as 'wait'", async () => {
    let cancelRequested = false;
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 524,
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelRequested = true;
          return new Promise<void>(() => {});
        },
      }),
      text: async () => {
        throw new Error("5xx response body must not be read");
      },
    });
    const result = await pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qrcode-cookie",
      fetch,
    });
    expect(result.status).toBe("wait");
    expect(cancelRequested).toBe(true);
  });

  it("surfaces 4xx responses without forwarding their body", async () => {
    const sensitiveBody = "bot_token=secret-value qrcode=session-value";
    const { fetch } = makeFetch(() => ({ ok: false, status: 401, body: sensitiveBody }));
    const error = await pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qrcode-cookie",
      fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "WechatQrError", kind: "http", status: 401 });
    expect(String(error)).not.toContain(sensitiveBody);
  });

  it("accepts a pre-aborted external signal as 'wait' rather than throwing", async () => {
    // External cancellation aborts the long-poll fetch; the function still
    // resolves with 'wait' so the orchestrator can re-check its own deadline.
    const { fetch } = makeFetch(() => ({ ok: true, status: 200, body: '{"status":"wait"}' }));
    const controller = new AbortController();
    controller.abort();
    const result = await pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qrcode-cookie",
      fetch,
      signal: controller.signal,
    });
    expect(result.status).toBe("wait");
  });

  it("returns wait when a successful poll body reaches its timeout (#10606)", async () => {
    vi.useFakeTimers();
    const { fetch, bodyStarted, cancelRequested } = makePendingStreamingBodyFetch();
    const debugEvents: string[] = [];

    const pending = pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qrcode-cookie",
      fetch,
      timeoutMs: 1_000,
      onDebug: (event) => debugEvents.push(event),
    });
    await bodyStarted;
    const resolved = expect(pending).resolves.toEqual({ status: "wait" });
    await vi.advanceTimersByTimeAsync(1_000);
    await cancelRequested;
    await resolved;
    expect(debugEvents).toContain("poll abort (treated as wait)");
  });

  it("rejects an oversized poll response without exposing its content (#10606)", async () => {
    const secret = "bot_token=secret-value qrcode=session-value";
    const oversizedBody = JSON.stringify({
      status: "wait",
      secret,
      padding: "x".repeat(WECHAT_ILINK_MAX_RESPONSE_BYTES),
    });
    const { fetch, usedTextFallback } = makeStreamingBodyFetch(oversizedBody);
    const debugEvents: string[] = [];
    const error = await pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qrcode-cookie",
      fetch,
      onDebug: (event) => debugEvents.push(event),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "parse",
      message: "WeChat QR status response exceeded the size limit",
    });
    expect(`${String(error)}\n${debugEvents.join("\n")}`).not.toContain(secret);
    expect(usedTextFallback()).toBe(false);
  });
});
