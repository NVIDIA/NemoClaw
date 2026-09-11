// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliOpenShellGatewayReuseObserver } from "./gateway-reuse-cli";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

const target = { kind: "named", gatewayName: "nemoclaw" } as const;
const named = "Gateway: nemoclaw\nGateway endpoint: https://127.0.0.1:8080/";
const healthy = "Gateway: nemoclaw\nStatus: Connected\nServer: https://127.0.0.1:8080/";

describe("gateway reuse CLI observation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("pins status and metadata probes to the frozen runtime without mutation", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, output: healthy })
      .mockResolvedValue({ status: 0, output: named });
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
      ["gateway", "info", "-g", "nemoclaw"],
      ["gateway", "info"],
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
      expectedOptions,
    ]);
    expect(capture.mock.calls.map(([, options]) => options.env.OPENSHELL_GATEWAY_ENDPOINT)).toEqual(
      [undefined, undefined, undefined],
    );
  });
  it("preserves registration after a status authentication failure", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({
        status: 0,
        output: `${healthy}\nError: authentication failed secret-token`,
      })
      .mockResolvedValue({ status: 0, output: named });
    const observed = await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({
      target,
    });
    expect(observed).toMatchObject({
      healthy: false,
      shouldSelect: false,
      error: { kind: "authentication" },
    });
    expect(JSON.stringify(observed)).not.toContain("secret-token");
  });
  it("blocks recovery when unreachable status has no named metadata", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 1, output: "Error: connection refused" })
      .mockResolvedValue({ status: 0, output: "" });
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
      .mockResolvedValue({ status: 0, output: `Gateway: nemoclaw\nGateway endpoint: ${endpoint}` });
    expect(
      await createCliOpenShellGatewayReuseObserver(capture).observeGatewayReuse({
        target,
        expectedGatewayPort: 8080,
      }),
    ).toMatchObject({ endpointBinding: "mismatch" });
  });
});
