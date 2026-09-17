// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCliOpenShellGatewayObserver } from "../adapters/openshell/gateway-observer-cli";
import { gatewayRuntimeDependencies } from "../gateway-runtime-action";
import { recoverGatewayOrExit } from "./command-support";

const originalObserveGateway = gatewayRuntimeDependencies.observeGateway;

afterEach(() => {
  gatewayRuntimeDependencies.observeGateway = originalObserveGateway;
  vi.unstubAllEnvs();
});

describe("credential gateway endpoint diagnostics", () => {
  it("rejects an endpoint override through the production recovery path (#11414)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "http://127.0.0.1:18081");
    const capture = vi.fn().mockResolvedValue({ status: 0, output: "plain HTTP responder" });
    gatewayRuntimeDependencies.observeGateway =
      createCliOpenShellGatewayObserver(capture).observeGateway;
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

    const output = reportFailure.mock.calls[0][0].join("\n");
    expect(output).toContain("OPENSHELL_GATEWAY_ENDPOINT");
    expect(output).toContain("Unset OPENSHELL_GATEWAY_ENDPOINT");
    expect(output).not.toContain("correct OPENSHELL_GATEWAY_ENDPOINT");
    expect(capture).not.toHaveBeenCalled();
  });
});
