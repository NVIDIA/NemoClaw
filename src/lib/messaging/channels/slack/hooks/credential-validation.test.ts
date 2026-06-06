// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CurlProbeResult } from "../../../../adapters/http/probe";

vi.mock("../../../../adapters/http/probe", () => ({
  runCurlProbe: vi.fn(),
}));

import { runCurlProbe } from "../../../../adapters/http/probe";
import {
  validateSlackAppToken,
  validateSlackBotToken,
  validateSlackCredentials,
} from "./credential-validation";

function probe(body: string, overrides: Partial<CurlProbeResult> = {}): CurlProbeResult {
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
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION;
});

function curlArgs(): string[] {
  return vi.mocked(runCurlProbe).mock.calls[0][0];
}

function curlConfigPath(args: string[]): string {
  const index = args.indexOf("--config");
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1];
}

describe("Slack token validation", () => {
  it("validates bot tokens with auth.test", () => {
    let configPath = "";
    let configText = "";
    vi.mocked(runCurlProbe).mockImplementation((args, opts) => {
      configPath = curlConfigPath(args);
      expect(opts?.trustedConfigFiles).toContain(configPath);
      configText = fs.readFileSync(configPath, "utf8");
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      return probe('{"ok":true,"user_id":"U123"}');
    });

    expect(validateSlackBotToken("xoxb-valid-bot")).toEqual({ ok: true });
    const args = curlArgs();
    expect(args).toContain("https://slack.com/api/auth.test");
    expect(args.join("\n")).not.toContain("xoxb-valid-bot");
    expect(args.join("\n")).not.toContain("Authorization: Bearer");
    expect(configText).toContain("Authorization: Bearer xoxb-valid-bot");
    expect(fs.existsSync(configPath)).toBe(false);
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
    vi.mocked(runCurlProbe).mockReturnValue(
      probe('{"ok":true,"url":"wss://wss-primary.slack.com/link"}'),
    );

    expect(validateSlackAppToken("xapp-valid-app")).toEqual({ ok: true });
    expect(curlArgs()).toContain("https://slack.com/api/apps.connections.open");
    expect(curlArgs().join("\n")).not.toContain("xapp-valid-app");
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

  it("skips live Slack API probes when explicitly requested", () => {
    process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";

    const result = validateSlackCredentials({
      botToken: "xoxb-offline-bot",
      appToken: "xapp-offline-app",
    });

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining("NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION is set"),
    });
    expect(vi.mocked(runCurlProbe)).not.toHaveBeenCalled();
  });

  it.each(["ratelimited", "request_timeout"])(
    "treats documented transient Slack API error %s as indeterminate",
    (error) => {
      vi.mocked(runCurlProbe).mockReturnValue(probe(JSON.stringify({ ok: false, error })));

      const result = validateSlackBotToken("xoxb-transient-bot");

      expect(result).toMatchObject({ ok: false, kind: "indeterminate", error });
    },
  );

  it("does not treat undocumented Slack API errors as transient based only on the error body", () => {
    vi.mocked(runCurlProbe).mockReturnValue(
      probe('{"ok":false,"error":"internal_error"}'),
    );

    const result = validateSlackBotToken("xoxb-internal-error");

    expect(result).toMatchObject({ ok: false, kind: "rejected", error: "internal_error" });
  });

  it("treats unreadable Slack API responses as indeterminate", () => {
    vi.mocked(runCurlProbe).mockReturnValue(probe("not json"));

    expect(validateSlackBotToken("xoxb-valid-looking")).toMatchObject({
      ok: false,
      kind: "indeterminate",
      tokenKind: "bot",
    });
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
