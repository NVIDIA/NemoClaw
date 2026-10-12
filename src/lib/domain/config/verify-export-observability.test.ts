// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { validateConfigExportWithPinnedV1 } from "../../../../test/support/v1-config-consumer";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { entry, managedWorkload, profileInput, snapshot } from "./export-source-test-fixture";

function openClawTelemetrySnapshot() {
  return snapshot({
    registry: entry({
      workload: managedWorkload(
        profileInput({
          environment: {
            NEMOCLAW_OPENCLAW_OTEL: "1",
            NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
            NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "research-assistant",
            NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
          },
        }),
      ),
    }),
  });
}

describe("OpenClaw observability export (#12144)", () => {
  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "preserves OTLP settings through the pinned v1 parser and native OpenClaw adapter (#12144)",
    testTimeoutOptions(12 * 60_000),
    async () => {
      const exported = await exportSnapshots([openClawTelemetrySnapshot()]);
      expect(exported.outcome.ok).toBe(true);
      const evidence = validateConfigExportWithPinnedV1(exported.writeStdout.mock.calls[0]![0]);
      expect(evidence.revision).toBe("42a26d90f1f6207cc35b5053556db67c86ce759f");
      expect(evidence.openclawNativeSettings?.alpha).toMatchObject({
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://host.openshell.internal:4318",
            serviceName: "research-assistant",
            sampleRate: 0.5,
            protocol: "http/protobuf",
            traces: true,
            metrics: false,
            logs: false,
          },
        },
        diagnosticsPlugin: { enabled: true },
      });
    },
  );
});
