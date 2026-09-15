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
  it.each([
    [
      "responding non-gateway",
      { status: 0, output: "plain HTTP responder" },
      "did not prove the expected gateway identity",
    ],
    [
      "unreachable endpoint",
      { status: 1, output: "client error (Connect): Connection refused" },
      "Is it running?",
    ],
  ])(
    "distinguishes a %s through the production recovery path (#11414)",
    async (_label, result, expected) => {
      vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "http://127.0.0.1:18081");
      const capture = vi.fn().mockResolvedValue(result);
      gatewayRuntimeDependencies.observeGateway =
        createCliOpenShellGatewayObserver(capture).observeGateway;
      const reportFailure = vi.fn();

      await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

      expect(reportFailure.mock.calls[0][0].join("\n")).toContain(expected);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0][0]).toEqual(["status"]);
      expect(capture.mock.calls[0][1]).toMatchObject({
        env: { OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:18081" },
        replaceEnv: true,
      });
    },
  );
});
