// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProbeResult } from "./types";

vi.mock("../adapters/http/probe", () => ({
  runCurlProbe: vi.fn(),
}));

import { runCurlProbe } from "../adapters/http/probe";
import {
  validateSlackAppToken,
  validateSlackBotToken,
  validateSlackCredentials,
} from "./slack-validation";

function probe(body: string, overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    ok: true,
    httpStatus: 200,
    curlStatus: 0,
    body,
    stderr: "",
    message: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(runCurlProbe).mockReset();
});

describe("Slack token validation", () => {
  it("validates bot tokens with auth.test", () => {
    vi.mocked(runCurlProbe).mockReturnValue(probe('{"ok":true,"user_id":"U123"}'));

    expect(validateSlackBotToken("xoxb-valid-bot")).toEqual({ ok: true });
    expect(vi.mocked(runCurlProbe).mock.calls[0][0]).toContain("https://slack.com/api/auth.test");
    expect(vi.mocked(runCurlProbe).mock.calls[0][0]).toContain(
      "Authorization: Bearer xoxb-valid-bot",
    );
  });

  it.each(["invalid_auth", "token_revoked", "not_authed"])(
    "rejects bot token error %s",
    (error) => {
      vi.mocked(runCurlProbe).mockReturnValue(probe(JSON.stringify({ ok: false, error })));

      const result = validateSlackBotToken("xoxb-bad-bot");

      expect(result).toMatchObject({ ok: false, kind: "rejected", tokenKind: "bot", error });
      if (!result.ok) expect(result.message).toContain(error);
    },
  );

  it("validates app tokens with apps.connections.open", () => {
    vi.mocked(runCurlProbe).mockReturnValue(probe('{"ok":true,"url":"wss://wss-primary.slack.com/link"}'));

    expect(validateSlackAppToken("xapp-valid-app")).toEqual({ ok: true });
    expect(vi.mocked(runCurlProbe).mock.calls[0][0]).toContain(
      "https://slack.com/api/apps.connections.open",
    );
  });

  it.each(["invalid_auth", "missing_scope", "not_allowed_token_type"])(
    "rejects app token error %s",
    (error) => {
      vi.mocked(runCurlProbe).mockReturnValue(probe(JSON.stringify({ ok: false, error })));

      const result = validateSlackAppToken("xapp-bad-app");

      expect(result).toMatchObject({ ok: false, kind: "rejected", tokenKind: "app", error });
      if (!result.ok) expect(result.message).toContain(error);
    },
  );

  it("returns the first rejected credential when validating a bot/app pair", () => {
    vi.mocked(runCurlProbe).mockReturnValue(
      probe('{"ok":false,"error":"invalid_auth"}'),
    );

    expect(
      validateSlackCredentials({ botToken: "xoxb-bad-bot", appToken: "xapp-not-checked" }),
    ).toMatchObject({ ok: false, credential: "bot", error: "invalid_auth" });
    expect(vi.mocked(runCurlProbe)).toHaveBeenCalledTimes(1);
  });

  it("validates the app token after the bot token passes", () => {
    vi.mocked(runCurlProbe)
      .mockReturnValueOnce(probe('{"ok":true}'))
      .mockReturnValueOnce(probe('{"ok":false,"error":"missing_scope"}'));

    expect(
      validateSlackCredentials({ botToken: "xoxb-valid-bot", appToken: "xapp-missing-scope" }),
    ).toMatchObject({ ok: false, credential: "app", error: "missing_scope" });
  });

  it("treats network failures as indeterminate without leaking token material", () => {
    const token = "xoxb-sensitive-token-value";
    vi.mocked(runCurlProbe).mockReturnValue(
      probe("", {
        ok: false,
        httpStatus: 0,
        curlStatus: 28,
        stderr: `timeout while using ${token}`,
        message: `curl failed while using ${token}`,
      }),
    );

    const result = validateSlackBotToken(token);

    expect(result).toMatchObject({ ok: false, kind: "indeterminate", tokenKind: "bot" });
    if (!result.ok) expect(result.message).not.toContain(token);
  });
});
