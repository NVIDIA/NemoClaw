// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  encodeIlinkClientVersion,
  fetchWechatQrSession,
  pollWechatQrStatus,
  WechatQrError,
  WECHAT_ILINK_BOOTSTRAP_BASE_URL,
  WECHAT_ILINK_DEFAULT_BOT_TYPE,
  type FetchLike,
} from "../../../dist/ext/wechat/qr";

type Capture = { url: string; init?: { method?: string; headers?: Record<string, string> } };

function makeFetch(
  responder: (req: Capture) => { ok: boolean; status: number; body: string },
): { fetch: FetchLike; calls: Capture[] } {
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
      body: JSON.stringify({ qrcode: "qrcode-cookie", qrcode_img_content: "https://example.com/qr" }),
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

  it("wraps non-2xx responses in a typed WechatQrError so callers can branch on .kind", async () => {
    const { fetch } = makeFetch(() => ({ ok: false, status: 503, body: "gateway down" }));
    await expect(fetchWechatQrSession({ fetch })).rejects.toMatchObject({
      name: "WechatQrError",
      kind: "http",
      status: 503,
    });
  });

  it("rejects responses missing qrcode or qrcode_img_content fields with a parse error", async () => {
    const { fetch } = makeFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ qrcode: "ok-but-no-img" }),
    }));
    await expect(fetchWechatQrSession({ fetch })).rejects.toBeInstanceOf(WechatQrError);
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

  it("treats 5xx gateway hiccups (e.g. Cloudflare 524) as 'wait'", async () => {
    const { fetch } = makeFetch(() => ({ ok: false, status: 524, body: "" }));
    const result = await pollWechatQrStatus({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qrcode-cookie",
      fetch,
    });
    expect(result.status).toBe("wait");
  });

  it("surfaces 4xx responses as a typed WechatQrError", async () => {
    const { fetch } = makeFetch(() => ({ ok: false, status: 401, body: "unauthorized" }));
    await expect(
      pollWechatQrStatus({
        baseUrl: "https://ilinkai.weixin.qq.com",
        qrcode: "qrcode-cookie",
        fetch,
      }),
    ).rejects.toMatchObject({ name: "WechatQrError", kind: "http", status: 401 });
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
});
