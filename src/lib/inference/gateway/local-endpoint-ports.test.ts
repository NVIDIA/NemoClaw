// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { isProtectedLocalInferencePort } from "./local-endpoint-ports";

vi.mock("../../state/gateway-registry", () => ({
  resolveHome: () => "/test-home",
  listRecordedGatewayPorts: () => [12345],
  listRecordedModelRouterPorts: () => [12346],
}));

describe("local inference endpoint port reservations", () => {
  it.each([
    { name: "ordinary backend", port: 11434, options: {}, protected: false },
    { name: "default gateway", port: 8080, options: {}, protected: true },
    { name: "recorded gateway", port: 12345, options: {}, protected: true },
    { name: "retained router", port: 12346, options: {}, protected: true },
    {
      name: "router despite proxy authority",
      port: 12346,
      options: { ownedProxy: true },
      protected: true,
    },
    { name: "unowned proxy", port: OLLAMA_PROXY_PORT, options: {}, protected: true },
    {
      name: "owned proxy",
      port: OLLAMA_PROXY_PORT,
      options: { ownedProxy: true },
      protected: false,
    },
    {
      name: "gateway despite proxy authority",
      port: 12345,
      options: { ownedProxy: true },
      protected: true,
    },
  ])("protects $name at selection time (#12558)", ({ port, options, protected: expected }) => {
    expect(isProtectedLocalInferencePort(port, options)).toBe(expected);
  });
});
