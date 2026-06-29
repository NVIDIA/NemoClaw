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
