// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "../fixtures/e2e-test.ts";
import {
  parseWindowsMxcOpenClawQualificationEnvironment,
  prepareWindowsMxcOpenClawArchiveArtifact,
  runWindowsMxcOpenClawProcessContainerQualification,
  WINDOWS_MXC_OPENCLAW_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
  type WindowsMxcOpenClawQualificationReceipt,
} from "./windows-mxc-openclaw-process-container-helpers.ts";

const qualificationTest =
  process.env.NEMOCLAW_RUN_WINDOWS_MXC_OPENCLAW_E2E === "1" ? test : test.skip;
// A cold Windows ARM64 host can spend more than 45 minutes in the mandatory
// full-tree identity scans and startup for one cycle. Keep the qualification
// bounded without racing either of the two complete sandbox lifecycles.
const QUALIFICATION_TIMEOUT_MS = 150 * 60_000;
const EXPECTED_STARTUP_OBSERVATION = {
  outcome: "ready",
  gatewayExitCode: null,
  versionExitCode: 0,
} as const;

function expectQualificationReceipt(
  receipt: WindowsMxcOpenClawQualificationReceipt,
  expectedConfiguration: WindowsMxcOpenClawQualificationReceipt["configuration"],
  expectedCleanup: WindowsMxcOpenClawQualificationReceipt["cleanup"],
): void {
  expect([receipt.schemaVersion, receipt.verdict]).toEqual([
    WINDOWS_MXC_OPENCLAW_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
    "pass",
  ]);
  expect(receipt.qualificationMode).toBe("authoritative");
  expect(receipt.configuration).toEqual(expectedConfiguration);
  expect(receipt.cleanup).toEqual(expectedCleanup);
  expect([
    receipt.checks.forwardAuthenticatedHealth,
    receipt.checks.forwardedChatExactReply,
  ]).toEqual([true, true]);
  expect(receipt.startup).toEqual(EXPECTED_STARTUP_OBSERVATION);
  expect(receipt.providerLifecycle).toSatisfy(({ create, cleanup, failures }) => {
    return (
      create?.outcome === "ready" &&
      create.resourceState === "active" &&
      cleanup?.outcome === "not-created" &&
      cleanup.resourceState === "absent" &&
      failures.length === 0
    );
  });
}

qualificationTest(
  "repeats forwarded chat and cleanup for the inactive native OpenClaw process_container candidate (#8178)",
  {
    timeout: QUALIFICATION_TIMEOUT_MS,
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
    const preparedOpenClaw = await prepareWindowsMxcOpenClawArchiveArtifact(inputs, progress);
    const expectedConfiguration = {
      artifactStaging: "pinned-archive-read-only-reused",
      declaredHostPreparation: inputs.declaredHostPreparation,
      egressProxy: true,
      networkDefaultPolicy: "block",
      networkPosture: "host-egress-proxy",
      allowGraphicalUi: true,
      allowInputInjection: false,
      clipboard: "none",
      pcCapabilities: ["privateNetworkClientServer"],
      pcAllowLocalNetwork: false,
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
      providerRecoveryAttempted: true,
      retainedSandboxName: null,
      runDirectoryRemoved: true,
      sensitiveRuntimeArtifactsRemoved: true,
    } as const;

    try {
      progress.phase("start OpenClaw and verify in-sandbox readiness plus filesystem enforcement");
      const firstReceipt = await runWindowsMxcOpenClawProcessContainerQualification(
        inputs,
        progress,
        preparedOpenClaw,
      );
      expectQualificationReceipt(firstReceipt, expectedConfiguration, expectedCleanup);

      progress.phase("repeat sandbox creation, chat, and cleanup without stale state");
      const secondReceipt = await runWindowsMxcOpenClawProcessContainerQualification(
        inputs,
        progress,
        preparedOpenClaw,
      );
      expectQualificationReceipt(secondReceipt, expectedConfiguration, expectedCleanup);
    } finally {
      preparedOpenClaw.release();
    }
  },
);
