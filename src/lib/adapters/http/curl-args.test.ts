// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateCurlProbeArgs } from "./curl-args";

describe("validateCurlProbeArgs — credential-leak defence", () => {
  it("rejects an inline Authorization header so credentials cannot reach argv", () => {
    expect(() =>
      validateCurlProbeArgs([
        "-sS",
        "-H",
        "Authorization: Bearer nvapi-secret",
        "https://example.test/v1/models",
      ]),
    ).toThrow(/must not carry credentials inline/);
  });

  it("rejects an inline x-api-key header so Anthropic credentials cannot reach argv", () => {
    expect(() =>
      validateCurlProbeArgs([
        "-sS",
        "-H",
        "x-api-key: sk-ant-secret",
        "https://example.test/v1/models",
      ]),
    ).toThrow(/must not carry credentials inline/);
  });

  it("rejects a ?key=<value> URL so query-param credentials cannot reach argv", () => {
    expect(() =>
      validateCurlProbeArgs(["-sS", "https://example.test/v1/models?key=AIzaFakeKey123"]),
    ).toThrow(/key query parameter/);
  });

  it.each([
    "session_token",
    "id_token",
    "auth_token",
    "client_secret",
    "api-key",
    "x-api-key",
    "access_key",
    "access-key",
    "password",
    "credential",
  ])("rejects a credential-shaped %s query parameter so secrets cannot reach argv", (paramName) => {
    expect(() =>
      validateCurlProbeArgs([
        "-sS",
        `https://example.test/v1/models?${paramName}=should-not-appear`,
      ]),
    ).toThrow(new RegExp(`${paramName} query parameter`));
  });

  it("rejects an inline proxy-authorization header so proxy credentials cannot reach argv", () => {
    expect(() =>
      validateCurlProbeArgs([
        "-sS",
        "--proxy-header",
        "Proxy-Authorization: Basic ZGVhZDpiZWVm",
        "https://example.test/v1/models",
      ]),
    ).toThrow(/must not carry credentials inline/);
  });

  it("rejects -L/--location flags by default so probe URLs cannot widen the SSRF surface", () => {
    expect(() => validateCurlProbeArgs(["-sS", "-L", "https://example.test/v1/models"])).toThrow(
      /allowRedirects/,
    );
    expect(() =>
      validateCurlProbeArgs(["-sS", "--location", "https://example.test/v1/models"]),
    ).toThrow(/allowRedirects/);
  });

  it("accepts -L/--location only when the caller explicitly opts in", () => {
    expect(() =>
      validateCurlProbeArgs(["-sfL", "https://example.test/v1/models"], { allowRedirects: true }),
    ).not.toThrow();
  });

  it("rejects --next so a single probe cannot trigger multiple transfers", () => {
    expect(() =>
      validateCurlProbeArgs(["-sS", "--next", "https://example.test/v1/models"]),
    ).toThrow(/multiple transfers/);
  });

  it("rejects a header read from @file so the on-disk credential cannot reach argv", () => {
    expect(() =>
      validateCurlProbeArgs(["-sS", "-H", "@/etc/passwd", "https://example.test/v1/models"]),
    ).toThrow(/must not read headers from a file/);
  });

  it("rejects an untrusted --config path even when trustedConfigFiles is unset", () => {
    expect(() =>
      validateCurlProbeArgs([
        "-sS",
        "--config",
        "/tmp/attacker/auth.conf",
        "https://example.test/v1/models",
      ]),
    ).toThrow(/config file is not trusted/);
  });

  it("accepts a trusted --config tmpfile route for credential headers", () => {
    expect(() =>
      validateCurlProbeArgs(
        [
          "-sS",
          "--config",
          "/tmp/nemoclaw-curl-auth-abc/auth.conf",
          "https://example.test/v1/models",
        ],
        { trustedConfigFiles: ["/tmp/nemoclaw-curl-auth-abc/auth.conf"] },
      ),
    ).not.toThrow();
  });
});
