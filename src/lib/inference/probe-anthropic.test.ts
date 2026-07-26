// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as probe from "../adapters/http/probe";
import { getProbeRecovery } from "../validation-recovery";
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

  it("does not run the streaming probe unless probeStreaming is requested", () => {
    vi.spyOn(probe, "runCurlProbe").mockReturnValue({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: "{}",
      stderr: "",
      message: "HTTP 200",
    });
    const streamSpy = vi.spyOn(probe, "runAnthropicStreamingEventProbe").mockReturnValue({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      missingEvents: [],
      duplicateEvents: [],
      sequenceErrors: [],
      message: "",
    });

    const result = probeAnthropicEndpoint(
      "https://api.anthropic.com",
      "claude-test",
      "sk-ant-secret",
    );

    expect(result.ok).toBe(true);
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("validates the streaming event sequence when probeStreaming is set (#6289)", () => {
    vi.spyOn(probe, "runCurlProbe").mockReturnValue({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: "{}",
      stderr: "",
      message: "HTTP 200",
    });
    let streamingArgv: readonly string[] = [];
    let streamingOpts: probe.CurlProbeOptions | undefined;
    const streamSpy = vi
      .spyOn(probe, "runAnthropicStreamingEventProbe")
      .mockImplementation((argv, opts) => {
        streamingArgv = argv;
        streamingOpts = opts;
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          missingEvents: [],
          duplicateEvents: [],
          sequenceErrors: [],
          message: "",
        };
      });

    const result = probeAnthropicEndpoint(
      "https://custom.endpoint.test",
      "nvidia/nemotron-3-super-v3",
      "sk-custom-secret",
      { probeStreaming: true },
    );

    expect(result).toEqual({
      ok: true,
      api: "anthropic-messages",
      label: "Anthropic Messages API",
    });
    expect(streamSpy).toHaveBeenCalledOnce();
    expect(streamingArgv.at(-1)).toBe("https://custom.endpoint.test/v1/messages");
    expect(streamingArgv.join(" ")).toContain('"stream":true');
    expect(streamingArgv.join(" ")).not.toContain("sk-custom-secret");
    const configIndex = streamingArgv.indexOf("--config");
    const configPath = configIndex >= 0 ? streamingArgv[configIndex + 1] : "";
    expect(streamingOpts?.trustedConfigFiles).toEqual([configPath]);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("fails validation when the streaming event sequence is malformed", () => {
    vi.spyOn(probe, "runCurlProbe").mockReturnValue({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: "{}",
      stderr: "",
      message: "HTTP 200",
    });
    vi.spyOn(probe, "runAnthropicStreamingEventProbe").mockReturnValue({
      ok: false,
      httpStatus: 200,
      curlStatus: 0,
      missingEvents: [],
      duplicateEvents: ["message_start"],
      sequenceErrors: [],
      message:
        "Anthropic Messages streaming on this endpoint emits duplicate message_start " +
        "(2 events for one request). Agent runs use the streaming path and would fail " +
        "with an empty final response.",
    });

    const result = probeAnthropicEndpoint(
      "https://custom.endpoint.test",
      "nvidia/nemotron-3-super-v3",
      "sk-custom-secret",
      { probeStreaming: true },
    );

    expect(result.ok).toBe(false);
    expect(result.failures?.[0]).toMatchObject({
      name: "Anthropic Messages API (streaming)",
      httpStatus: 200,
      curlStatus: 0,
      diagnosticCodes: ["anthropic-streaming-duplicate-message-start"],
    });
    expect(result.message).toContain("duplicate message_start");
  });

  it("preserves streaming timeouts for transport recovery", () => {
    vi.spyOn(probe, "runCurlProbe").mockReturnValue({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: "{}",
      stderr: "",
      message: "HTTP 200",
    });
    vi.spyOn(probe, "runAnthropicStreamingEventProbe").mockReturnValue({
      ok: false,
      httpStatus: 200,
      curlStatus: 28,
      missingEvents: ["message_stop"],
      duplicateEvents: [],
      sequenceErrors: [],
      message: "Anthropic Messages streaming is missing required events: message_stop.",
    });

    const result = probeAnthropicEndpoint(
      "https://custom.endpoint.test",
      "nvidia/nemotron-3-super-v3",
      "sk-custom-secret",
      { probeStreaming: true },
    );

    expect(result.failures?.[0]).toMatchObject({
      name: "Anthropic Messages API (streaming)",
      httpStatus: 200,
      curlStatus: 28,
    });
    expect(getProbeRecovery(result)).toMatchObject({
      kind: "transport",
      retry: "retry",
      failure: { curlStatus: 28 },
    });
  });

  it("skips the streaming probe when the non-streaming probe already failed", () => {
    vi.spyOn(probe, "runCurlProbe").mockReturnValue({
      ok: false,
      httpStatus: 401,
      curlStatus: 0,
      body: "{}",
      stderr: "",
      message: "HTTP 401",
    });
    const streamSpy = vi.spyOn(probe, "runAnthropicStreamingEventProbe").mockReturnValue({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      missingEvents: [],
      duplicateEvents: [],
      sequenceErrors: [],
      message: "",
    });

    const result = probeAnthropicEndpoint(
      "https://custom.endpoint.test",
      "claude-test",
      "sk-ant-bad",
      { probeStreaming: true },
    );

    expect(result.ok).toBe(false);
    expect(streamSpy).not.toHaveBeenCalled();
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
