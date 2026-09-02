// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { expect, test } from "../fixtures/e2e-test.ts";
import {
  EXTERNAL_GATEWAY_HEALTH_TIMEOUT_MS,
  runPackagedBlueprintRunnerStatus,
  startPreparedExternalTlsGateway,
} from "./external-gateway-health-helpers.ts";

test(
  "Blueprint Runner observes OpenShell public health over explicit HTTPS and CA (#9872)",
  {
    timeout: EXTERNAL_GATEWAY_HEALTH_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm the exact OpenShell gateway and SDK prerequisites",
        "launch a TLS gateway without client-certificate authentication",
        "observe public health through the exact Blueprint Runner artifact",
      ],
    },
  },
  async ({ artifacts, cleanup, progress, shellProbe, skip }) => {
    const prepared = await startPreparedExternalTlsGateway({
      artifacts,
      cleanup,
      progress,
      shellProbe,
      skip,
    });
    expect(fs.existsSync(prepared.authenticationPath)).toBe(false);

    progress.phase("observe public health through the exact Blueprint Runner artifact");
    const status = await runPackagedBlueprintRunnerStatus(shellProbe, prepared);

    expect(fs.existsSync(prepared.authenticationPath)).toBe(false);
    expect(status.compatibility).toBe("compatible");
    expect(status.gateway).toEqual({
      release: prepared.expectedRelease,
      status: "healthy",
    });
    await artifacts.writeJson("external-gateway-health.json", {
      expectedRelease: prepared.expectedRelease,
      reportedRelease: prepared.expectedRelease,
      runner: "dist/lib/blueprint-runner.js",
      status: "healthy",
      transport: "https-explicit-ca",
    });
  },
);
