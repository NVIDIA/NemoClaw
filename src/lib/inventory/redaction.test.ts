// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getSandboxInventory, getStatusReport, type SandboxEntry } from "./index";

const secret = 'api_key="example-not-a-real-value-1"';
const sandboxName = `alpha ${secret}`;

function recover(sandboxes: SandboxEntry[] = []) {
  return async () => ({ sandboxes, defaultSandbox: sandboxes[0]?.name ?? null });
}

describe("inventory redaction", () => {
  it("redacts every public sandbox field", async () => {
    const sandbox: SandboxEntry = {
      name: sandboxName,
      provider: `nvidia-prod ${secret}`,
      model: `nvidia/test ${secret}`,
      policies: [`pypi ${secret}`],
      agent: `openclaw ${secret}`,
      openshellVersion: `0.0.110 ${secret}`,
      recoveredFromGateway: true,
      livePhase: `Ready ${secret}`,
    };
    const inventory = await getSandboxInventory({
      recoverRegistryEntries: recover([sandbox]),
      getLiveInference: () => null,
      loadLastSession: () => null,
    });
    const status = getStatusReport({
      listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: sandboxName }),
      getLiveInference: () => null,
      showServiceStatus: () => undefined,
    });

    expect(inventory.sandboxes[0]).toMatchObject(status.sandboxes[0]!);
    expect(inventory.defaultSandbox).toBe(status.defaultSandbox);
    expect(JSON.stringify(inventory)).not.toContain("example-not-a-real-value-1");
  });

  it("redacts completed and incomplete onboarding sandbox names", async () => {
    const completed = await getSandboxInventory({
      recoverRegistryEntries: recover(),
      getLiveInference: () => null,
      loadLastSession: () => ({ sandboxName, steps: { sandbox: { status: "complete" } } }),
    });
    const incomplete = await getSandboxInventory({
      recoverRegistryEntries: recover([
        { name: sandboxName, pendingRouteReservation: true, reservationSessionId: "session" },
      ]),
      getLiveInference: () => null,
      loadLastSession: () => ({
        sessionId: "session",
        sandboxName,
        status: "failed",
        resumable: true,
        failure: { step: "inference", interrupted: true },
      }),
    });

    expect(completed.lastOnboardedSandbox).not.toContain("example-not-a-real-value-1");
    expect(incomplete.incompleteOnboarding?.name).not.toContain("example-not-a-real-value-1");
  });
});
