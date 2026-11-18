// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
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

describe("OpenClaw observability export (#12144, #14580)", () => {
  it("leaves OTLP settings out of the export and warns, because v1 has no equivalent", async () => {
    const exported = await exportSnapshots([openClawTelemetrySnapshot()]);
    expect(exported.outcome.ok).toBe(true);
    const raw = exported.writeStdout.mock.calls[0]![0];
    // The report header names the omitted settings; the YAML document must not carry them.
    const body = raw
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    expect(body).not.toContain("otlp");
    expect(body).not.toContain("research-assistant");
    expect(YAML.parse(raw).spec.sandboxes.alpha.harness).toEqual({
      kind: "nvidia.fabric.openclaw",
      runtime: { timeout_seconds: 600 },
    });
    expect(
      (exported.outcome as unknown as { omissions: { field: string }[] }).omissions.map(
        ({ field }) => field,
      ),
    ).toContain("observability");
  });
});
