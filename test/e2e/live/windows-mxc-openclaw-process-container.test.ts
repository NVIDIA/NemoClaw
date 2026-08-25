// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "../fixtures/e2e-test.ts";
import {
  parseWindowsMxcOpenClawQualificationEnvironment,
  runWindowsMxcOpenClawProcessContainerQualification,
} from "./windows-mxc-openclaw-process-container-helpers.ts";

const qualificationTest =
  process.env.NEMOCLAW_RUN_WINDOWS_MXC_OPENCLAW_E2E === "1" ? test : test.skip;

qualificationTest(
  "repeats forwarded chat and cleanup for the inactive native OpenClaw process_container candidate (#8178)",
  {
    timeout: 18 * 60_000,
    meta: {
      e2ePhases: [
        "qualify the Windows host and validate exact artifact identities",
        "start OpenClaw and verify in-sandbox readiness plus filesystem enforcement",
        "forward authenticated traffic and require the exact mock-backed chat reply",
        "delete the sandbox and verify registry plus OpenClaw process cleanup",
        "repeat sandbox creation, chat, and cleanup without stale state",
      ],
    },
  },
  async ({ progress }) => {
    progress.phase("qualify the Windows host and validate exact artifact identities");
    const inputs = parseWindowsMxcOpenClawQualificationEnvironment(process.env);
    const expectedConfiguration = {
      declaredHostPreparation: "wxc-host-prep-prepare-system-drive",
      egressProxy: true,
      pcCapabilities: ["privateNetworkClientServer"],
      pcLeastPrivilege: false,
      shareAtDriveRoot: true,
    } as const;
    const expectedCleanup = {
      boundedStopMarkerNeeded: false,
      emergencyForwardTerminationNeeded: false,
      emergencyGatewayTerminationNeeded: false,
      emergencyProcessTerminationNeeded: false,
      forwardListenerStopped: true,
      forwardProcessStopped: true,
      gatewayProcessStopped: true,
      openClawProcessStopped: true,
      runDirectoryRemoved: true,
      sandboxDeleteRetried: false,
      sensitiveRuntimeArtifactsRemoved: true,
    } as const;

    progress.phase("start OpenClaw and verify in-sandbox readiness plus filesystem enforcement");
    const firstReceipt = await runWindowsMxcOpenClawProcessContainerQualification(inputs, progress);
    expect(firstReceipt.verdict).toBe("pass");
    expect(firstReceipt.configuration).toEqual(expectedConfiguration);
    expect(firstReceipt.checks.forwardAuthenticatedHealth).toBe(true);
    expect(firstReceipt.checks.forwardedChatExactReply).toBe(true);
    expect(firstReceipt.cleanup).toEqual(expectedCleanup);

    progress.phase("repeat sandbox creation, chat, and cleanup without stale state");
    const secondReceipt = await runWindowsMxcOpenClawProcessContainerQualification(
      inputs,
      progress,
    );
    expect(secondReceipt.verdict).toBe("pass");
    expect(secondReceipt.configuration).toEqual(expectedConfiguration);
    expect(secondReceipt.checks.forwardAuthenticatedHealth).toBe(true);
    expect(secondReceipt.checks.forwardedChatExactReply).toBe(true);
    expect(secondReceipt.cleanup).toEqual(expectedCleanup);
  },
);
