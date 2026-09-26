// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { entry, managedWorkload, profileInput, snapshot } from "./export-source-test-fixture";

function additionalAgentSnapshot(manifest: unknown, environment: NodeJS.ProcessEnv = {}) {
  return snapshot({
    registry: entry({
      workload: managedWorkload(
        profileInput({
          environment: { ...environment, NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(manifest) },
        }),
      ),
    }),
  });
}

describe("read-only secondary-agent export", () => {
  it("refuses a secondary agent pending the v1 roster decision (#12131)", async () => {
    const observed = additionalAgentSnapshot([{ id: "researcher", tools: { allow: ["read"] } }]);
    const result = await exportSnapshots([observed, observed]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        findings: expect.arrayContaining([
          expect.objectContaining({ field: "spec.sandboxes[].agent", category: "unsupported" }),
        ]),
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it("refuses every multi-agent roster without publishing partial output (#12131)", async () => {
    const manifest = {
      agents: [
        { id: "researcher", tools: { allow: ["read"] } },
        { id: "reviewer", tools: { allow: ["read"] } },
      ],
    };
    const observed = additionalAgentSnapshot(manifest);
    const result = await exportSnapshots([observed, observed]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        findings: expect.arrayContaining([
          expect.objectContaining({ field: "spec.sandboxes[].agent", category: "unsupported" }),
        ]),
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
});
