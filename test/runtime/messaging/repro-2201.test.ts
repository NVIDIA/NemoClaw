// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeMessagingPlan } from "../../helpers/messaging-plan-fixtures";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../helpers/rebuild-flow-generic-harness";

installRebuildFlowTestHooks();

describe("rebuild uses the registry target instead of stale session state", () => {
  it("uses the registry OpenClaw target after Hermes was onboarded last (#2201)", async () => {
    const harness = createRebuildFlowHarness({ sessionSandboxName: "hermes" });
    harness.session.agent = "hermes";

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.session.agent).toBeNull();
  });

  it("uses the registry Hermes target after OpenClaw was onboarded last (#2201)", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { agent: "hermes" },
      sessionSandboxName: "openclaw",
    });
    harness.session.agent = null;

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.session.agent).toBe("hermes");
  });

  it("does not copy a messaging plan from another sandbox's session (#2201)", async () => {
    const harness = createRebuildFlowHarness({ sessionSandboxName: "hermes" });
    harness.session.agent = "hermes";
    harness.session.messagingPlan = makeMessagingPlan({
      sandboxName: "hermes",
      agent: "hermes",
      channels: ["telegram"],
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.session.messagingPlan).toBeNull();
  });
});

describe("rebuild forwards its stored custom Dockerfile", () => {
  it("passes the registry Dockerfile to recreate onboarding (#2301)", async () => {
    const fromDockerfile = path.resolve(import.meta.dirname, "../../..", "Dockerfile");
    const harness = createRebuildFlowHarness({ sandboxEntry: { fromDockerfile } });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.onboardSpy).toHaveBeenCalledWith(expect.objectContaining({ fromDockerfile }));
  });
});
