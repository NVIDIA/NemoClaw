// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import {
  asExportedConfig,
  exportedAgentList,
} from "../../../../test/support/config-export-document";
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
    expect(exportedAgentList(sandbox)[0]!.inference.routes[0]!.overrides).toEqual({
      model: "gpt-5",
      contextWindow: 131072,
    });
    expect(sandbox.harness).toEqual({
      kind: "openclaw",
      interfaces: { dashboard: { port: 18789 } },
    });
  });
});
