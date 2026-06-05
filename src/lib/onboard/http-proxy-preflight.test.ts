// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { redactProxyCredentials, warnIfHostProxyMissesLoopback } from "./http-proxy-preflight";

describe("redactProxyCredentials (#2616)", () => {
  it("returns plain proxy URLs unchanged", () => {
    expect(redactProxyCredentials("http://127.0.0.1:8118")).toBe("http://127.0.0.1:8118");
    expect(redactProxyCredentials("http://corp-proxy.example.com:3128")).toBe(
      "http://corp-proxy.example.com:3128",
    );
  });

  it("redacts user:password basic-auth from proxy URLs", () => {
    const redacted = redactProxyCredentials("http://alice:s3cret@proxy.example.com:3128");
    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("s3cret");
    expect(redacted).toContain("****");
    expect(redacted).toContain("proxy.example.com:3128");
  });

  it("redacts username-only basic-auth", () => {
    const redacted = redactProxyCredentials("http://token123@proxy.example.com:3128");
    expect(redacted).not.toContain("token123");
    expect(redacted).toContain("****");
  });

  it("falls back to regex redaction for non-URL-parseable strings", () => {
    // Some users set HTTP_PROXY to malformed strings; we should still redact.
    const redacted = redactProxyCredentials("//alice:s3cret@host");
    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("s3cret");
  });
});

describe("warnIfHostProxyMissesLoopback (#2616)", () => {
  it("does not warn when no HTTP_PROXY is set", () => {
    const lines: string[] = [];
    const fired = warnIfHostProxyMissesLoopback({}, (line) => lines.push(line));
    expect(fired).toBe(false);
    expect(lines).toEqual([]);
  });

  it("does not warn when NO_PROXY already includes localhost", () => {
    const lines: string[] = [];
    const fired = warnIfHostProxyMissesLoopback(
      { http_proxy: "http://127.0.0.1:8118", NO_PROXY: "localhost,127.0.0.1" },
      (line) => lines.push(line),
    );
    expect(fired).toBe(false);
    expect(lines).toEqual([]);
  });

  it("warns when NO_PROXY only has localhost (127.0.0.1 still proxied) (CodeRabbit #3801)", () => {
    const lines: string[] = [];
    const fired = warnIfHostProxyMissesLoopback(
      { http_proxy: "http://127.0.0.1:8118", NO_PROXY: "localhost" },
      (line) => lines.push(line),
    );
    expect(fired).toBe(true);
    expect(lines.join("\n")).toContain("export NO_PROXY=localhost,127.0.0.1");
  });

  it("warns when NO_PROXY only has 127.0.0.1 (localhost still proxied) (CodeRabbit #3801)", () => {
    const lines: string[] = [];
    const fired = warnIfHostProxyMissesLoopback(
      { http_proxy: "http://127.0.0.1:8118", NO_PROXY: "127.0.0.1" },
      (line) => lines.push(line),
    );
    expect(fired).toBe(true);
    expect(lines.join("\n")).toContain("export NO_PROXY=localhost,127.0.0.1");
  });

  it("warns when HTTP_PROXY is set without NO_PROXY=localhost", () => {
    const lines: string[] = [];
    const fired = warnIfHostProxyMissesLoopback(
      { http_proxy: "http://127.0.0.1:8118" },
      (line) => lines.push(line),
    );
    expect(fired).toBe(true);
    expect(lines.join("\n")).toContain("HTTP_PROXY/http_proxy is set");
    expect(lines.join("\n")).toContain("Detected proxy: http://127.0.0.1:8118");
    expect(lines.join("\n")).toContain("export NO_PROXY=localhost,127.0.0.1");
  });

  it("redacts credentials in the proxy URL it logs (CodeRabbit #3801)", () => {
    const lines: string[] = [];
    warnIfHostProxyMissesLoopback(
      { http_proxy: "http://alice:s3cret@proxy.example.com:3128" },
      (line) => lines.push(line),
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain("alice");
    expect(joined).not.toContain("s3cret");
    expect(joined).toContain("****");
    expect(joined).toContain("proxy.example.com:3128");
  });

  it("respects uppercase HTTP_PROXY too", () => {
    const lines: string[] = [];
    const fired = warnIfHostProxyMissesLoopback(
      { HTTP_PROXY: "http://corp-proxy:3128" },
      (line) => lines.push(line),
    );
    expect(fired).toBe(true);
    expect(lines.join("\n")).toContain("corp-proxy:3128");
  });
});
