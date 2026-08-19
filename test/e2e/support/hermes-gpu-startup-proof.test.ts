// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertHermesGpuStartupOutputContract,
  HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS,
} from "../live/hermes-gpu-startup-proof.ts";

const HEALTHY_NEW_GATEWAY = [
  "Starting OpenShell Docker-driver gateway...",
  "Docker-driver gateway is healthy",
].join("\n");

describe("Hermes GPU startup output contract", () => {
  it.each(["native-success", "compatibility-only"] as const)(
    "accepts %s output without legacy Docker container progress text (#9362)",
    (route) => {
      expect(() => assertHermesGpuStartupOutputContract(route, HEALTHY_NEW_GATEWAY)).not.toThrow();
    },
  );

  it("accepts fallback output only with the complete operator disclosure (#9362)", () => {
    const output = [
      HEALTHY_NEW_GATEWAY,
      "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
      ...HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS,
    ].join("\n");

    expect(() =>
      assertHermesGpuStartupOutputContract("compatibility-fallback", output),
    ).not.toThrow();
  });

  it("rejects fallback output that omits an operator disclosure fragment (#9362)", () => {
    const output = [
      HEALTHY_NEW_GATEWAY,
      "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
      ...HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS.slice(1),
    ].join("\n");

    expect(() => assertHermesGpuStartupOutputContract("compatibility-fallback", output)).toThrow();
  });
});
