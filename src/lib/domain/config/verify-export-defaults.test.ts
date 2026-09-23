// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { validateOpenClawExportWithPinnedV1 } from "../../../../test/support/v1-config-consumer";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { snapshot, tunedSnapshot } from "./export-source-test-fixture";

describe("effective v1alpha1 export defaults (#12132)", () => {
  it("preserves source values whether their startup inputs were explicit or omitted", async () => {
    const baseline = await exportSnapshots([snapshot()]);
    const explicit = await exportSnapshots([
      tunedSnapshot({
        NEMOCLAW_CONTEXT_WINDOW: "131072",
        NEMOCLAW_MAX_TOKENS: "4096",
        NEMOCLAW_REASONING: "false",
        NEMOCLAW_REASONING_EFFORT: "default",
        NEMOCLAW_AGENT_TIMEOUT: "600",
      }),
    ]);
    expect(explicit.outcome.ok).toBe(true);
    expect(explicit.writeStdout.mock.calls).toEqual(baseline.writeStdout.mock.calls);
    const config = asExportedConfig(YAML.parse(explicit.writeStdout.mock.calls[0]![0]));
    const sandbox = config.spec.sandboxes[0]!;
    expect(sandbox.agent.inference.routes[0]!.overrides).toEqual({
      model: "gpt-5",
      contextWindow: 131072,
    });
    expect(sandbox.harness).toEqual({
      kind: "openclaw",
      interfaces: { dashboard: { port: 18789 } },
    });
    expect(sandbox).not.toHaveProperty("image");
  });

  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "preserves defaults through the pinned v1 parser and native OpenClaw generation (#12132)",
    testTimeoutOptions(12 * 60_000),
    async () => {
      const exported = await exportSnapshots([snapshot()]);
      expect(exported.outcome.ok).toBe(true);
      expect(validateOpenClawExportWithPinnedV1(exported.writeStdout.mock.calls[0]![0])).toEqual({
        revision: "88c6600c06b0937907290362eef86912052c4ad0",
        contextWindow: 131072,
      });
    },
  );
});
