// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as probe from "../adapters/http/probe";
import { probeAnthropicEndpoint } from "./probe-anthropic";

describe("probeAnthropicEndpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes the Anthropic API key through a trusted --config tmpfile and reports success", () => {
    let capturedArgv: readonly string[] = [];
    let configContents = "";
    let configPath = "";
    const spy = vi.spyOn(probe, "runCurlProbe").mockImplementation((argv, opts) => {
      capturedArgv = argv;
      const configIndex = argv.indexOf("--config");
      configPath = configIndex >= 0 ? argv[configIndex + 1] : "";
      configContents = configPath ? fs.readFileSync(configPath, "utf8") : "";
      expect(opts?.trustedConfigFiles).toEqual([configPath]);
      return {
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: "{}",
        stderr: "",
        message: "HTTP 200",
      };
    });

    const result = probeAnthropicEndpoint(
      "https://api.anthropic.com",
      "claude-test",
      "sk-ant-secret",
    );

    expect(spy).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      api: "anthropic-messages",
      label: "Anthropic Messages API",
    });
    expect(capturedArgv.join(" ")).not.toContain("sk-ant-secret");
    expect(capturedArgv.join(" ")).not.toContain("x-api-key:");
    expect(configContents).toContain('header = "x-api-key: sk-ant-secret"');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(capturedArgv.at(-1)).toBe("https://api.anthropic.com/v1/messages");
  });

  it("returns a structured failure when the curl probe returns a non-2xx status", () => {
    vi.spyOn(probe, "runCurlProbe").mockReturnValue({
      ok: false,
      httpStatus: 401,
      curlStatus: 0,
      body: '{"error":{"message":"invalid api key"}}',
      stderr: "",
      message: "HTTP 401: invalid api key",
    });

    const result = probeAnthropicEndpoint(
      "https://api.anthropic.com/",
      "claude-test",
      "sk-ant-bad",
    );

    expect(result.ok).toBe(false);
    expect(result.failures?.[0]).toMatchObject({
      name: "Anthropic Messages API",
      httpStatus: 401,
      curlStatus: 0,
    });
    expect(result.message).toContain("HTTP 401");
  });

  it("converts an auth-config setup failure into the same structured probe-failure shape", () => {
    const spy = vi.spyOn(probe, "runCurlProbe");
    // Force createXApiKeyAuthConfig to throw by stubbing the os.tmpdir lookup
    // via fs.mkdtempSync — this is the same boundary that runCurlProbe-side
    // failure conversion guards in onboard-probes (#5975 review note PRA-2).
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    const result = probeAnthropicEndpoint(
      "https://api.anthropic.com",
      "claude-test",
      "sk-ant-secret",
    );

    expect(spy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ENOSPC");
    expect(result.failures?.[0]).toMatchObject({
      name: "curl auth config",
      httpStatus: 0,
      curlStatus: 0,
    });
    mkdtempSpy.mockRestore();
  });
});
