// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createConnectHarness,
  useConnectFlowProcessLifecycle,
} from "../../../../test/support/connect-flow-test-harness";

describe("connectSandbox unknown recorded agent", () => {
  useConnectFlowProcessLifecycle();

  it("probe-only names an unknown recorded agent and escapes it (#12208)", async () => {
    const harness = createConnectHarness({
      readinessPublicationResult: {
        kind: "validation-failed",
        category: "config",
        unknownAgent: "bad\u202e",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain(
      'final launch-readiness validation failed because the recorded agent "bad\\\\u202e" is unknown, so recreate the sandbox with a supported agent.',
    );
    expect(output).not.toContain("\u202e");
  });
});
