// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the Telegram reachability + token-validation probe.
//
// Covers the warn-and-skip behavior introduced for #4238: when api.telegram.org
// is unreachable or the bot token is rejected, onboarding should drop the
// optional Telegram integration and continue — not abort. Mirrors the Brave
// optional-component path at src/lib/onboard/web-search-flow.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProbeResult } from "./types";

vi.mock("../adapters/http/probe", () => ({
  runCurlProbe: vi.fn(),
}));

import { runCurlProbe } from "../adapters/http/probe";
import { checkTelegramReachability, type TelegramReachabilityDeps } from "./telegram-reachability";

function probeOk(): ProbeResult {
  return { ok: true, httpStatus: 200, curlStatus: 0, body: '{"ok":true}', stderr: "", message: "" };
}
function probeHttpError(httpStatus: number): ProbeResult {
  return { ok: false, httpStatus, curlStatus: 0, body: "", stderr: "", message: "" };
}
function probeCurlError(curlStatus: number): ProbeResult {
  return { ok: false, httpStatus: 0, curlStatus, body: "", stderr: "", message: "" };
}

function makeDeps(overrides: Partial<TelegramReachabilityDeps> = {}): TelegramReachabilityDeps {
  return {
    isNonInteractive: vi.fn(() => true),
    note: vi.fn(),
    promptYesNoOrDefault: vi.fn(async () => true),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(runCurlProbe).mockReset();
  delete process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY;
});

describe("checkTelegramReachability", () => {
  it("returns { skipped: false } on HTTP 200 (token valid, network reachable)", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeOk());
    expect(await checkTelegramReachability("123:abc", makeDeps())).toEqual({ skipped: false });
  });

  it("returns { skipped: true } when curl exits 35 (TLS handshake failure)", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeCurlError(35));
    expect(await checkTelegramReachability("123:abc", makeDeps())).toEqual({ skipped: true });
  });

  it("returns { skipped: true } for every curl exit in TELEGRAM_NETWORK_CURL_CODES (non-interactive)", async () => {
    for (const code of [6, 7, 28, 35, 52, 56]) {
      vi.mocked(runCurlProbe).mockReturnValue(probeCurlError(code));
      expect(
        await checkTelegramReachability("123:abc", makeDeps()),
        `curlStatus=${code}`,
      ).toEqual({ skipped: true });
    }
  });

  it("returns { skipped: true } on HTTP 401 (token rejected by Telegram)", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeHttpError(401));
    expect(await checkTelegramReachability("123:abc", makeDeps())).toEqual({ skipped: true });
  });

  it("returns { skipped: true } on HTTP 404 (token rejected by Telegram)", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeHttpError(404));
    expect(await checkTelegramReachability("123:abc", makeDeps())).toEqual({ skipped: true });
  });

  it("returns { skipped: false } and skips the probe when NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1", async () => {
    process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
    expect(await checkTelegramReachability("123:abc", makeDeps())).toEqual({ skipped: false });
    expect(vi.mocked(runCurlProbe)).not.toHaveBeenCalled();
  });

  it("prompts 'Disable Telegram?' on interactive network failure and returns { skipped: true } when accepted", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeCurlError(7));
    const deps = makeDeps({
      isNonInteractive: vi.fn(() => false),
      promptYesNoOrDefault: vi.fn(async () => true),
    });
    const result = await checkTelegramReachability("123:abc", deps);
    expect(result).toEqual({ skipped: true });
    expect(deps.promptYesNoOrDefault).toHaveBeenCalledWith(
      expect.stringContaining("Disable Telegram"),
      null,
      true,
    );
  });

  it("calls process.exit(1) when interactive user declines the prompt", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeCurlError(7));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__test_exit_${code ?? 0}__`);
    }) as never);
    try {
      const deps = makeDeps({
        isNonInteractive: vi.fn(() => false),
        promptYesNoOrDefault: vi.fn(async () => false),
      });
      await expect(checkTelegramReachability("123:abc", deps)).rejects.toThrow("__test_exit_1__");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
