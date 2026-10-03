// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { connectExternalHttpOpenShellSdk } from "./sdk";

const target = { kind: "named", gatewayName: "nemoclaw-9443" } as const;

describe("external HTTP SDK connection", () => {
  it("passes only the verified endpoint without ambient tokens or TLS material (#11861)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_TOKEN", "token-canary");
    vi.stubEnv("OPENSHELL_TLS_KEY", "key-canary");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/credential-canary");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.example");
    const client = { raw: {} };
    const connect = vi.fn().mockResolvedValue(client);
    const result = await connectExternalHttpOpenShellSdk(target, "http://127.0.0.1:9443", {
      loadSdk: async () => ({ OpenShellClient: { connect } }),
    });
    expect(result).toBe(client);
    expect(connect).toHaveBeenCalledExactlyOnceWith({ gateway: "http://127.0.0.1:9443" });
  });

  it.each([
    "http://127.0.0.1:8080",
    "https://127.0.0.1:9443",
    "http://example.com:9443",
    "http://secret@127.0.0.1:9443",
  ])("rejects invalid connection intent before loading the SDK: %s (#11861)", async (endpoint) => {
    const connect = vi.fn();
    const loadSdk = vi.fn(async () => ({ OpenShellClient: { connect } }));
    await expect(connectExternalHttpOpenShellSdk(target, endpoint, { loadSdk })).rejects.toThrow(
      "does not match",
    );
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it("rejects ambient gateway selection (#11861)", async () => {
    await expect(
      connectExternalHttpOpenShellSdk({ kind: "selected" }, "http://127.0.0.1:9443"),
    ).rejects.toThrow("explicit gateway target");
  });

  it("honors cancellation before connecting after SDK loading (#11861)", async () => {
    const controller = new AbortController();
    const connect = vi.fn();
    const loadSdk = async () => {
      controller.abort();
      return { OpenShellClient: { connect } };
    };
    await expect(
      connectExternalHttpOpenShellSdk(target, "http://127.0.0.1:9443", {
        loadSdk,
        signal: controller.signal,
      }),
    ).rejects.toThrow("timed out");
    expect(connect).not.toHaveBeenCalled();
  });
});
