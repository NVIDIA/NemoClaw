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
  "qualifies the inactive native OpenClaw process_container candidate through OpenShell (#8178)",
  {
    timeout: 8 * 60_000,
    meta: {
      e2ePhases: [
        "qualify the Windows host and validate exact artifact identities",
        "start OpenClaw and verify in-sandbox readiness plus filesystem enforcement",
        "delete the sandbox and verify registry plus OpenClaw process cleanup",
      ],
    },
  },
  async ({ progress }) => {
    progress.phase("qualify the Windows host and validate exact artifact identities");
    const inputs = parseWindowsMxcOpenClawQualificationEnvironment(process.env);

    progress.phase("start OpenClaw and verify in-sandbox readiness plus filesystem enforcement");
    const receipt = await runWindowsMxcOpenClawProcessContainerQualification(inputs, progress);

    expect(receipt.verdict).toBe("pass");
    expect(receipt.configuration).toEqual({ pcLeastPrivilege: true });
    expect(receipt.cleanup).toEqual({
      boundedStopMarkerNeeded: false,
      emergencyGatewayTerminationNeeded: false,
      emergencyProcessTerminationNeeded: false,
      gatewayProcessStopped: true,
      openClawProcessStopped: true,
      runDirectoryRemoved: true,
      sandboxDeleteRetried: false,
      sensitiveRuntimeArtifactsRemoved: true,
    });
  },
);
