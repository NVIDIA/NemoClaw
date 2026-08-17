// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assertEndpointResolvesPublic } from "../../inference/endpoint-ssrf-preflight";
import { buildBoundedCurlProbeSpawnArgs, validateCurlProbeArgs } from "./curl-args";

describe("validateCurlProbeArgs — credential-leak defence", () => {
  it("allows a fixed response-byte cap for bounded llama.cpp probes (#8161)", () => {
    expect(
      validateCurlProbeArgs(["-sS", "--max-filesize", "262144", "http://127.0.0.1:8081/v1/models"])
        .args,
    ).toEqual(["-sS", "--max-filesize", "262144"]);
  });

  it("rebuilds bounded llama.cpp probe argv from validated fields (#8161)", () => {
    expect(
      buildBoundedCurlProbeSpawnArgs(
        ["-sS", "--max-filesize", "262144"],
        "http://127.0.0.1:8081/v1/models",
        "\n__NEMOCLAW_HTTP_STATUS_test__:",
      ),
    ).toEqual([
      "-sS",
      "--max-filesize",
      "262144",
      "-w",
      "\n__NEMOCLAW_HTTP_STATUS_test__:%{http_code}",
      "http://127.0.0.1:8081/v1/models",
    ]);
  });

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
  ])(
    "rejects a credential-shaped %s query parameter so secrets cannot reach argv (#5048)",
    (paramName) => {
      expect(() =>
        validateCurlProbeArgs([
          "-sS",
          `https://example.test/v1/models?${paramName}=should-not-appear`,
        ]),
      ).toThrow(new RegExp(`${paramName} query parameter`));
    },
  );

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

  it("accepts an exact preflight-authorized private --resolve mapping (#6861)", async () => {
    const preflight = await assertEndpointResolvesPublic(
      "https://llm.corp.example/v1/models",
      async () => [{ address: "10.0.0.8", family: 4 }],
      { trustedPrivateHosts: ["llm.corp.example"] },
    );
    expect(() =>
      validateCurlProbeArgs(
        ["-sS", "--resolve", "llm.corp.example:443:10.0.0.8", "https://llm.corp.example/v1/models"],
        {
          pinnedAddresses: ["10.0.0.8"],
          trustedPrivateCapability: preflight.trustedPrivateCapability,
        },
      ),
    ).not.toThrow();
  });

  it("rejects capability reuse for a different host on the same private address (#8176)", async () => {
    const preflight = await assertEndpointResolvesPublic(
      "https://a.corp.example/v1/models",
      async () => [{ address: "10.0.0.8", family: 4 }],
      { trustedPrivateHosts: ["a.corp.example"] },
    );

    expect(() =>
      validateCurlProbeArgs(
        ["-sS", "--resolve", "b.corp.example:443:10.0.0.8", "https://b.corp.example/v1/models"],
        {
          pinnedAddresses: ["10.0.0.8"],
          trustedPrivateCapability: preflight.trustedPrivateCapability,
        },
      ),
    ).toThrow(/capability host 'a\.corp\.example' does not match 'b\.corp\.example'/);
  });

  it("canonicalizes an expanded ULA answer before curl pin validation (#8176)", async () => {
    const endpointUrl = "https://llm.corp.example/v1/models";
    const preflight = await assertEndpointResolvesPublic(
      endpointUrl,
      async () => [{ address: "fd00:0:0:0:0:0:0:10", family: 6 }],
      { trustedPrivateHosts: ["llm.corp.example"] },
    );

    expect(preflight.addresses).toEqual(["fd00::10"]);
    expect(() =>
      validateCurlProbeArgs(["-sS", "--resolve", "llm.corp.example:443:[fd00::10]", endpointUrl], {
        pinnedAddresses: preflight.addresses,
        trustedPrivateCapability: preflight.trustedPrivateCapability,
      }),
    ).not.toThrow();
  });

  it.each(
    [
        "llm.corp.example:443:10.0.0.8",
        "llm.corp.example:443:93.184.216.34",
        "llm.corp.example:443:10.0.0.8,93.184.216.34,8.8.8.8",
      ],
  )(
    "requires the exact mixed public and private pin set at the curl boundary [%s] (#8176)",
    async (mapping) => {
      const endpointUrl = "https://llm.corp.example/v1/models";
      const preflight = await assertEndpointResolvesPublic(
        endpointUrl,
        async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.8", family: 4 },
        ],
        { trustedPrivateHosts: ["llm.corp.example"] },
      );
      const options = {
        pinnedAddresses: preflight.addresses,
        trustedPrivateCapability: preflight.trustedPrivateCapability,
      };

      expect(() =>
        validateCurlProbeArgs(
          ["-sS", "--resolve", "llm.corp.example:443:10.0.0.8,93.184.216.34", endpointUrl],
          options,
        ),
      ).not.toThrow();

      expect(() =>
        validateCurlProbeArgs(["-sS", "--resolve", mapping, endpointUrl], options),
      ).toThrow(/exactly match pinnedAddresses/);

      expect(() =>
        validateCurlProbeArgs(
          ["-sS", "--resolve", "llm.corp.example:443:10.0.0.8,93.184.216.34", endpointUrl],
          { pinnedAddresses: preflight.addresses },
        ),
      ).toThrow(/unauthorized private address/);
    },
  );

  it("rejects a forged private authorization even when the address is otherwise trustable (#6861)", () => {
    expect(() =>
      validateCurlProbeArgs(
        ["-sS", "--resolve", "llm.corp.example:443:10.0.0.8", "https://llm.corp.example/v1/models"],
        {
          pinnedAddresses: ["10.0.0.8"],
          trustedPrivateCapability: { addresses: ["10.0.0.8"] } as never,
        },
      ),
    ).toThrow(/not issued by the SSRF preflight/);
  });

  it("does not trust a process-global mutable capability registry (#6861)", () => {
    const forged = { addresses: ["10.0.0.8"] } as never;
    const registryKey = Symbol.for("nemoclaw.trusted-private-endpoint-capability-registry");
    const previousRegistry = Object.getOwnPropertyDescriptor(globalThis, registryKey);
    Object.defineProperty(globalThis, registryKey, {
      configurable: true,
      value: new WeakSet([forged]),
    });
    try {
      expect(() =>
        validateCurlProbeArgs(
          [
            "-sS",
            "--resolve",
            "llm.corp.example:443:10.0.0.8",
            "https://llm.corp.example/v1/models",
          ],
          { pinnedAddresses: ["10.0.0.8"], trustedPrivateCapability: forged },
        ),
      ).toThrow(/not issued by the SSRF preflight/);
    } finally {
      previousRegistry === undefined
        ? Reflect.deleteProperty(globalThis, registryKey)
        : Object.defineProperty(globalThis, registryKey, previousRegistry);
    }
  });

  it("requires a valid capability to match an exact private IP URL when no DNS pin is needed (#6861)", async () => {
    const preflight = await assertEndpointResolvesPublic(
      "http://10.0.0.8/v1/models",
      async () => [],
      { trustedPrivateHosts: ["10.0.0.8"] },
    );
    const options = {
      pinnedAddresses: [],
      trustedPrivateCapability: preflight.trustedPrivateCapability,
    };
    expect(() =>
      validateCurlProbeArgs(["-sS", "http://10.0.0.8/v1/models"], options),
    ).not.toThrow();
    expect(() => validateCurlProbeArgs(["-sS", "http://10.0.0.9/v1/models"], options)).toThrow(
      /capability host '10\.0\.0\.8' does not match '10\.0\.0\.9'/,
    );
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
