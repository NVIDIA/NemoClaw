// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/ports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/ports")>()),
  VLLM_PORT: 19_000,
}));

import {
  COMPATIBLE_ENDPOINT_GATEWAY_PORTS,
  gatewayReachableCompatibleEndpointUrl,
} from "./compatible-endpoint-gateway-route";

describe("configured vLLM compatible endpoint gateway routing", () => {
  it("rewrites only the configured vLLM port through the OpenShell host bridge", () => {
    expect(COMPATIBLE_ENDPOINT_GATEWAY_PORTS).toContain(19_000);
    expect(COMPATIBLE_ENDPOINT_GATEWAY_PORTS).not.toContain(8000);
    expect(
      gatewayReachableCompatibleEndpointUrl("compatible-endpoint", "http://127.0.0.1:19000/v1"),
    ).toBe("http://host.openshell.internal:19000/v1");
    expect(
      gatewayReachableCompatibleEndpointUrl("compatible-endpoint", "http://127.0.0.1:8000/v1"),
    ).toBe("http://127.0.0.1:8000/v1");
  });
});
