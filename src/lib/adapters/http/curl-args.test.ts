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
    "authorization",
    "passcode",
    "cookie",
    "dsn",
    "connection_string",
    "webhook_url",
    "password",
    "credential",
  ])("rejects a credential-shaped %s query parameter so secrets cannot reach argv (#5048)", (paramName) => {
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

  it("accepts only an exact public --resolve mapping for the probe destination (#6293)", () => {
    expect(() =>
      validateCurlProbeArgs(
        [
          "-sS",
          "--resolve",
          "example.test:443:93.184.216.34,[2606:2800:220:1:248:1893:25c8:1946]",
          "https://example.test/v1/models",
        ],
        { pinnedAddresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] },
      ),
    ).not.toThrow();
  });

  it.each([
    ["other.test:443:93.184.216.34", ["93.184.216.34"]],
    ["example.test:80:93.184.216.34", ["93.184.216.34"]],
    ["example.test:443:not-an-ip", ["not-an-ip"]],
    ["example.test:443:10.0.0.8", ["10.0.0.8"]],
    ["example.test:443:93.184.216.35", ["93.184.216.34"]],
  ])("rejects an unsafe or mismatched --resolve mapping %s (#6293)", (mapping, approved) => {
    expect(() =>
      validateCurlProbeArgs(["-sS", "--resolve", mapping, "https://example.test/v1/models"], {
        pinnedAddresses: approved,
      }),
    ).toThrow(/--resolve/);
  });

  it("rejects --resolve without an approved address capability (#6293)", () => {
    expect(() =>
      validateCurlProbeArgs([
        "-sS",
        "--resolve",
        "example.test:443:93.184.216.34",
        "https://example.test/v1/models",
      ]),
    ).toThrow(/pinnedAddresses/);
  });

  it("rejects repeated --resolve entries instead of letting curl drop earlier addresses (#6293)", () => {
    expect(() =>
      validateCurlProbeArgs(
        [
          "--resolve",
          "example.test:443:93.184.216.34",
          "--resolve",
          "example.test:443:93.184.216.34",
          "https://example.test/v1/models",
        ],
        { pinnedAddresses: ["93.184.216.34"] },
      ),
    ).toThrow(/only one --resolve/);
  });
});
