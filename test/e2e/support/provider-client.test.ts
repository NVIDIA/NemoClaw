// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ProviderClient, trustedProviderEndpoint } from "../fixtures/clients/index.ts";
import { FakeRunner } from "./helpers/fake-client-runner.ts";

describe("E2E provider client", () => {
  it("provider client parses JSON from curl output", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);

    await expect(
      provider.getJson(trustedProviderEndpoint("http://127.0.0.1:8080/health")),
    ).resolves.toEqual({ ok: true });
    expect(runner.calls[0]).toEqual({
      command: "curl",
      args: ["-fsS", "http://127.0.0.1:8080/health"],
      options: {
        artifactName: "curl-http-127.0.0.1-8080-health",
        redactionValues: [],
      },
    });
  });

  it("provider client posts JSON bodies with --data-raw", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/chat/completions", {
      allowedHosts: ["api.example.test"],
    });

    await expect(
      provider.requestJson(endpoint, {
        body: '{"messages":[]}',
        curlMaxTimeSeconds: 5,
        headers: ["Content-Type: application/json"],
      }),
    ).resolves.toMatchObject({ json: { ok: true } });

    expect(runner.calls[0]?.args).toEqual([
      "-fsS",
      "--max-time",
      "5",
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      '{"messages":[]}',
      "https://api.example.test/v1/chat/completions",
    ]);
  });

  it.each([
    { body: "@/etc/passwd" },
    { headers: ["@/tmp/headers"] },
    { headers: ["Authorization: Bearer token\nX-Leak: value"] },
    { curlMaxTimeSeconds: 0 },
    { curlMaxTimeSeconds: -1 },
    { curlMaxTimeSeconds: Number.NaN },
    { curlMaxTimeSeconds: Number.POSITIVE_INFINITY },
  ])(
    "provider client rejects curl-sensitive request options before command construction [case %#]",
    async (options) => {
      const endpoint = trustedProviderEndpoint("https://api.example.test/v1/models", {
        allowedHosts: ["api.example.test"],
      });

      const runner = new FakeRunner();
      const provider = new ProviderClient(runner);

      await expect(provider.requestJson(endpoint, options)).rejects.toThrow(
        /@file|CR or LF|finite positive/,
      );
      expect(runner.calls).toEqual([]);
    },
  );

  it("provider client does not follow redirects after endpoint validation", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/models", {
      allowedHosts: ["api.example.test"],
    });

    await provider.getJson(endpoint);

    expect(runner.calls[0]?.args).toEqual(["-fsS", "https://api.example.test/v1/models"]);
    expect(runner.calls[0]?.args).not.toContain("-L");
  });

  it("provider endpoint rejects unsafe schemes, hosts, and userinfo", () => {
    expect(() => trustedProviderEndpoint("file:///etc/passwd")).toThrow(/protocol/);
    expect(() => trustedProviderEndpoint("http://example.com/health")).toThrow(/loopback/);
    expect(() => trustedProviderEndpoint("https://api.example.test/models")).toThrow(
      /allowedHosts/,
    );
    expect(() => trustedProviderEndpoint("http://169.254.169.254/latest/meta-data")).toThrow(
      /blocked/,
    );
    expect(() => trustedProviderEndpoint("https://token@example.com/models")).toThrow(
      /credentials/,
    );
    expect(() =>
      trustedProviderEndpoint("https://api.example.test/models", {
        allowedHosts: ["api.other.test"],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      trustedProviderEndpoint("https://10.0.0.1/models", {
        allowedHosts: ["10.0.0.1"],
      }),
    ).toThrow(/private or link-local/);
    expect(() =>
      trustedProviderEndpoint("https://[fd00::1]/models", {
        allowedHosts: ["fd00::1"],
      }),
    ).toThrow(/private or link-local/);
  });

  it("provider endpoint allows loopback HTTP, including IPv6 loopback", () => {
    expect(trustedProviderEndpoint("http://127.0.0.1:8080/health").url).toBe(
      "http://127.0.0.1:8080/health",
    );
    expect(trustedProviderEndpoint("http://[::1]:8080/health").url).toBe(
      "http://[::1]:8080/health",
    );
  });

  it("provider client sanitizes labels and redacts credential-bearing query values", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint(
      "https://api.example.test/v1/models?api_key=query-token-value",
      { allowedHosts: ["api.example.test"] },
    );

    await expect(provider.getJson(endpoint)).resolves.toEqual({ ok: true });

    expect(runner.calls[0]?.options?.artifactName).toBe("curl-https-api.example.test-v1-models");
    expect(runner.calls[0]?.options?.redactionValues).toEqual(
      expect.arrayContaining(["api_key=query-token-value", "query-token-value"]),
    );
  });

  it("provider client builds reachability probes from trusted endpoints", async () => {
    const runner = new FakeRunner();
    runner.stdout = "204";
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint("https://inference-api.nvidia.com/v1", {
      allowedHosts: ["inference-api.nvidia.com"],
    });

    await expect(provider.probeReachability(endpoint)).resolves.toMatchObject({ stdout: "204" });

    expect(runner.calls.at(-1)).toMatchObject({
      command: "curl",
      args: [
        "-sS",
        "--connect-timeout",
        "10",
        "--max-time",
        "20",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "https://inference-api.nvidia.com/v1",
      ],
    });
  });

  it("provider endpoint validation rejects metadata SSRF targets before reachability probes", () => {
    expect(() => trustedProviderEndpoint("http://169.254.169.254/latest/meta-data")).toThrow(
      /private or link-local|blocked/,
    );
    expect(() =>
      trustedProviderEndpoint("https://metadata.google.internal/computeMetadata/v1"),
    ).toThrow(/blocked/);
  });

  it("provider client reports invalid JSON without echoing response body", async () => {
    const runner = new FakeRunner();
    runner.stdout = "not-json with query-token-value";
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint(
      "https://api.example.test/v1/models?api_key=query-token-value",
      { allowedHosts: ["api.example.test"] },
    );

    await expect(provider.getJson(endpoint)).rejects.toThrow(/provider response was not JSON/);
    await expect(provider.getJson(endpoint)).rejects.not.toThrow(/query-token-value|not-json/);
  });

  it("provider client failure labels omit query strings", async () => {
    const runner = new FakeRunner();
    runner.exitCode = 22;
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint(
      "https://api.example.test/v1/models?api_key=query-token-value",
      {
        allowedHosts: ["api.example.test"],
      },
    );

    await expect(provider.getJson(endpoint)).rejects.toThrow(
      "curl https://api.example.test/v1/models failed: exit=22",
    );
    await expect(provider.getJson(endpoint)).rejects.not.toThrow(/query-token-value|api_key/);
  });
});
