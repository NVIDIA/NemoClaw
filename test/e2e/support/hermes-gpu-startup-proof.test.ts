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
const NON_FALLBACK_DISCLOSURE_CASES = [
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[0]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[1]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[2]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[3]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[4]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[0]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[1]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[2]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[3]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[4]],
] as const;

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

  it.each(HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS)(
    "rejects fallback output that omits %s (#9362)",
    (missingFragment) => {
      const output = [
        HEALTHY_NEW_GATEWAY,
        "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
        ...HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS.filter(
          (fragment) => fragment !== missingFragment,
        ),
      ].join("\n");

      expect(() =>
        assertHermesGpuStartupOutputContract("compatibility-fallback", output),
      ).toThrow();
    },
  );

  it.each(NON_FALLBACK_DISCLOSURE_CASES)(
    "rejects fallback disclosure in %s output: %s (#9362)",
    (route, fragment) => {
      expect(() =>
        assertHermesGpuStartupOutputContract(route, `${HEALTHY_NEW_GATEWAY}\n${fragment}`),
      ).toThrow();
    },
  );
});
