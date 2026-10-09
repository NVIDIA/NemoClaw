// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliOpenShellGatewayReuseObserver } from "./gateway-reuse-cli";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

const target = { kind: "named", gatewayName: "nemoclaw" } as const;
const healthy = "Gateway: nemoclaw\nStatus: Connected\nServer: https://127.0.0.1:8080/";
const registry = JSON.stringify([
  { name: "nemoclaw", endpoint: "https://127.0.0.1:8080/", active: true },
]);

describe("gateway reuse CLI observation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("pins status and metadata probes to the frozen runtime without mutation", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, output: healthy })
      .mockResolvedValue({ status: 0, output: registry });
    const result = await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({
      target,
      runtimeSelection: {
        gatewayName: "nemoclaw",
        workspace: "default",
        localTlsDir: "/recorded/tls",
      },
      expectedGatewayPort: 8080,
    });
    expect(result).toMatchObject({ healthy: true, namedMetadata: true, endpointBinding: "match" });
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["status", "-g", "nemoclaw"],
      ["gateway", "list", "-o", "json"],
    ]);
    const expectedOptions = expect.objectContaining({
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      replaceEnv: true,
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw",
        OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
      }),
    });
    expect(capture.mock.calls.map(([, options]) => options)).toEqual([
      expectedOptions,
      expectedOptions,
    ]);
    expect(capture.mock.calls.map(([, options]) => options.env.OPENSHELL_GATEWAY_ENDPOINT)).toEqual(
      [undefined, undefined],
    );
  });
  it("uses the supplied read-only child environment without inventing workspace authority", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, output: healthy })
      .mockResolvedValue({ status: 0, output: registry });
    const environment = { HOME: "/readiness", OPENSHELL_GATEWAY: "nemoclaw" };
    const observed = await createCliOpenShellGatewayReuseObserver(
      capture,
      environment,
    ).observeGatewayReuse({ target, expectedGatewayPort: 8080 });
    expect(observed).toMatchObject({ healthy: true, endpointBinding: "match" });
    expect(capture.mock.calls.map(([, options]) => options.env)).toEqual([
      environment,
      environment,
    ]);
    expect(capture.mock.calls.every(([, options]) => options.replaceEnv === true)).toBe(true);
  });
  it("parses registry JSON from stdout without treating stderr diagnostics as schema", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, output: healthy })
      .mockResolvedValueOnce({
        status: 0,
        output: `${registry}\nwarning: system registration shadowed`,
        stdout: registry,
        stderr: "warning: system registration shadowed",
      });

    expect(
      await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({
        target,
        expectedGatewayPort: 8080,
      }),
    ).toMatchObject({ healthy: true, namedMetadata: true, endpointBinding: "match" });
  });
  it("preserves registration after a status authentication failure", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({
        status: 0,
        output: `${healthy}\nError: authentication failed secret-token`,
      })
      .mockResolvedValue({ status: 0, output: registry });
    const observed = await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({
      target,
    });
    expect(observed).toMatchObject({
      healthy: false,
      shouldSelect: false,
      error: { kind: "authentication" },
    });
    expect(JSON.stringify(observed)).not.toContain("secret-token");
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it("stops immediately when the named metadata probe times out", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, output: healthy })
      .mockResolvedValueOnce({
        status: null,
        output: "",
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      });
    const observed = await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({
      target,
      timeoutMs: 100,
    });
    expect(observed.error?.kind).toBe("timeout");
    expect(capture).toHaveBeenCalledTimes(2);
  });
  it("blocks recovery when unreachable status has no named metadata", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 1, output: "Error: connection refused" })
      .mockResolvedValue({ status: 0, output: "[]" });
    expect(
      await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({ target }),
    ).toMatchObject({ healthy: false, shouldSelect: false, error: { kind: "schema" } });
  });
  it.each([
    "https://foreign.invalid:8080",
    "https://127.0.0.1:8091",
    "https://127.0.0.1:8080/path",
    "https://user:secret@127.0.0.1:8080",
  ])("rejects endpoint binding %s", async (endpoint) => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, output: healthy })
      .mockResolvedValue({
        status: 0,
        output: JSON.stringify([{ name: "nemoclaw", endpoint, active: true }]),
      });
    expect(
      await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({
        target,
        expectedGatewayPort: 8080,
      }),
    ).toMatchObject({ endpointBinding: "mismatch" });
  });
  it("rejects malformed or ambiguous gateway registry output", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, output: healthy })
      .mockResolvedValueOnce({
        status: 0,
        output: JSON.stringify([
          { name: "nemoclaw", endpoint: "https://127.0.0.1:8080/", active: true },
          { name: "other", endpoint: "https://127.0.0.1:8090/", active: true },
        ]),
      });

    expect(
      await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({ target }),
    ).toMatchObject({ error: { kind: "schema" } });
  });
});
