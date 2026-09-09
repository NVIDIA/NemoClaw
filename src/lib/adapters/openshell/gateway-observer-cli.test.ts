// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliOpenShellGatewayObserver } from "./gateway-observer-cli";

const request = { target: { kind: "named", gatewayName: "nemoclaw-8090" } } as const;
const connected = "Status: Connected\nGateway: nemoclaw-8090\n";
const info = "Gateway: nemoclaw-8090\n";
function captureFor(status: string, metadata: string, statusCode = 0, infoCode = 0) {
  return vi
    .fn()
    .mockResolvedValueOnce({ status: statusCode, output: status })
    .mockResolvedValueOnce({ status: infoCode, output: metadata });
}
afterEach(() => vi.unstubAllEnvs());

describe("CLI gateway observation", () => {
  it.each([
    [connected, info, 0, 0, "healthy_named", false],
    ["Status: Connected\nGateway: foreign", info, 0, 0, "connected_other", false],
    ["Gateway: nemoclaw-8090\nConnection refused", info, 1, 0, "named_unreachable", true],
    [
      "Gateway: nemoclaw-8090\nError: client error (Connect): Connection refused",
      info,
      0,
      0,
      "named_unreachable",
      true,
    ],
    ["Gateway: nemoclaw-8090\nStatus: Disconnected", info, 0, 0, "named_unhealthy", true],
    ["No gateway configured", "No gateway metadata found", 1, 1, "missing_named", true],
    [
      connected,
      "gateway info is not supported by this gateway version",
      0,
      1,
      "healthy_named",
      false,
    ],
    ["\u001b[32m" + connected + "\u001b[0m", info, 0, 0, "healthy_named", false],
  ])(
    "classifies status %s and metadata %s as %s",
    async (status, metadata, statusCode, infoCode, state, unavailable) => {
      const capture = captureFor(
        String(status),
        String(metadata),
        Number(statusCode),
        Number(infoCode),
      );
      const result = await createCliOpenShellGatewayObserver(capture).observeGateway(request);
      expect(result.state).toBe(state);
      expect(result.unavailable).toBe(unavailable);
      expect(result).not.toHaveProperty("status");
      expect(result).not.toHaveProperty("gatewayInfo");
      expect(capture.mock.calls.map(([args]) => args)).toEqual([
        ["status"],
        ["gateway", "info", "-g", "nemoclaw-8090"],
      ]);
      expect(
        capture.mock.calls.every(
          ([, opts]) =>
            opts.ignoreError && opts.includeStderr && opts.includeStreams && opts.timeout > 0,
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["authentication failed token=secret", "authentication"],
    ["permission denied", "authentication"],
    ["device identity required", "authentication"],
    ["expired token", "authentication"],
    ["handshake verification failed", "transport"],
    ["TLS certificate verification failed secret", "command"],
    ["protobuf decode error", "schema"],
    ["unexpected failure secret", "command"],
  ])("blocks recovery and redacts %s", async (output, kind) => {
    const capture = captureFor(connected, output, 0, 1);
    const result = await createCliOpenShellGatewayObserver(capture).observeGateway(request);
    expect(result).toMatchObject({
      state: "observation_failed",
      recoveryBlocked: true,
      error: { kind },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each(["", "???", "Gateway: nemoclaw-80900", "Gateway: nemoclaw-8090\nGateway: foreign"])(
    "does not infer healthy identity or absence from %s",
    async (metadata) => {
      const result = await createCliOpenShellGatewayObserver(
        captureFor(connected, metadata),
      ).observeGateway(request);
      expect(result).toMatchObject({ state: "observation_failed", recoveryBlocked: true });
    },
  );

  it("blocks recovery when connected status contradicts missing metadata", async () => {
    const capture = captureFor(connected, "No gateway metadata found", 0, 1);
    expect(await createCliOpenShellGatewayObserver(capture).observeGateway(request)).toMatchObject({
      state: "observation_failed",
      recoveryBlocked: true,
      error: { kind: "schema" },
    });
  });

  it("blocks recovery for an authentication Error line even when status exits zero", async () => {
    const capture = captureFor(`${connected}Error: authentication failed token=secret`, info);
    const result = await createCliOpenShellGatewayObserver(capture).observeGateway(request);
    expect(result).toMatchObject({
      state: "observation_failed",
      recoveryBlocked: true,
      error: { kind: "authentication" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not interpret a timeout as gateway absence", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: null,
      output: "",
      error: Object.assign(new Error("secret"), { code: "ETIMEDOUT" }),
    });
    expect(await createCliOpenShellGatewayObserver(capture).observeGateway(request)).toMatchObject({
      state: "observation_failed",
      error: { kind: "timeout" },
      recoveryBlocked: true,
    });
  });

  it("contains thrown transport diagnostics", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("secret"));
    const result = await createCliOpenShellGatewayObserver(capture).observeGateway(request);
    expect(result.recoveryBlocked).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects endpoint overrides before executing a probe", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.invalid");
    const capture = captureFor(connected, info);
    expect(
      (await createCliOpenShellGatewayObserver(capture).observeGateway(request)).recoveryBlocked,
    ).toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });

  it("uses frozen runtime authority without changing the parent environment (#10514)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "foreign");
    vi.stubEnv("OPENSHELL_TOKEN", "secret");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.invalid");
    const runtimeSelection = {
      gatewayName: "nemoclaw-8090",
      workspace: "default",
      localTlsDir: "/recorded/tls",
    };
    const capture = captureFor(connected, info);
    await createCliOpenShellGatewayObserver(capture).observeGateway({
      ...request,
      runtimeSelection,
    });
    expect(capture).toHaveBeenCalledTimes(2);
    const statusOptions = capture.mock.calls[0][1];
    expect(capture.mock.calls[1][1]).toEqual(statusOptions);
    expect(statusOptions).toMatchObject({
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "nemoclaw-8090",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
      },
    });
    expect(statusOptions.env.OPENSHELL_TOKEN).toBeUndefined();
    expect(statusOptions.env.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
    expect(process.env.OPENSHELL_GATEWAY).toBe("foreign");
  });

  it("rejects mismatched runtime authority without executing a probe", async () => {
    const capture = captureFor(connected, info);
    const result = await createCliOpenShellGatewayObserver(capture).observeGateway({
      ...request,
      runtimeSelection: { gatewayName: "foreign", workspace: "default" },
    });
    expect(result.error).toMatchObject({ kind: "command", reason: "invalid_request" });
    expect(capture).not.toHaveBeenCalled();
  });
});
