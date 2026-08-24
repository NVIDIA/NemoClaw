// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import { reapplyMessagingManifestAfterOpenClawDoctor } from "./rebuild-messaging-phase";

describe("rebuild messaging policy authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("withholds messaging success when authority changes during config application (#9833)", async () => {
    vi.spyOn(MessagingSetupApplier, "applyAgentConfigAtOpenShell").mockResolvedValue({
      appliedHooks: ["telegram-config"],
      appliedTargets: ["openclaw-config"],
    } as never);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const log = vi.fn();
    const refusal = new PolicyAuthorityRefusalError("policy authority changed");

    await expect(
      reapplyMessagingManifestAfterOpenClawDoctor(
        "alpha",
        { agent: "openclaw", buildSteps: [] } as never,
        log,
        vi.fn(async () => {
          throw refusal;
        }),
      ),
    ).rejects.toBe(refusal);

    expect(consoleLog.mock.calls.flat().join("\n")).not.toContain(
      "Messaging manifest config reapplied",
    );
    expect(log.mock.calls.flat().join("\n")).not.toContain("messaging manifest reapply: targets=");
  });
});
