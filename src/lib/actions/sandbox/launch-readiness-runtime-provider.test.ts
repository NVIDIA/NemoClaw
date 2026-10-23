// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "../../agent/defs";
import { entry } from "../../../../test/helpers/native-launch-readiness.ts";
import { buildLaunchReadinessRegistryProjection } from "./launch-readiness";

const SANDBOX = entry();

describe("launch readiness runtime-provider projection", () => {
  it("accepts qualification-registered providers without a provider-name branch", () => {
    const projection = buildLaunchReadinessRegistryProjection(
      { ...SANDBOX, openshellDriver: "podman" },
      loadAgent("openclaw"),
    ) as { openshellDriver: string };

    expect(projection.openshellDriver).toBe("podman");
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        { ...SANDBOX, openshellDriver: "unregistered-runtime" },
        loadAgent("openclaw"),
      ),
    ).toThrow();
  });

  it("rejects in-progress lifecycle and policy mutations", () => {
    const agent = loadAgent("openclaw");
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        { ...SANDBOX, pendingRouteReservation: true, reservationSessionId: "session" },
        agent,
      ),
    ).toThrow();
  });
});
