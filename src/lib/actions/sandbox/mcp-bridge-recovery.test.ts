// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  inspectHermesMcpReconciliationRefusal,
  processRecoveryMcpReconciliationRefusal,
} from "./mcp-bridge-recovery";

describe("Hermes MCP recovery boundary (#6257)", () => {
  it("continues when runtime intent matches", () => {
    expect(
      inspectHermesMcpReconciliationRefusal("alpha", () => ({
        ok: true,
        state: "matched",
      })),
    ).toBeNull();
  });

  it("sanitizes a reconciliation refusal once at the shared boundary", () => {
    expect(
      inspectHermesMcpReconciliationRefusal("alpha", () => ({
        ok: false,
        state: "mismatch",
        detail: "\u001b[31mdrifted\u001b[0m\nFORGED",
      })),
    ).toEqual({ detail: "drifted FORGED" });
  });

  it.each([true, false])("maps refusal into the process recovery contract (%s)", (wasRunning) => {
    expect(
      processRecoveryMcpReconciliationRefusal("alpha", wasRunning, () => ({
        ok: false,
        state: "error",
        detail: "runtime mismatch",
      })),
    ).toEqual({
      checked: true,
      wasRunning,
      recovered: false,
      forwardRecovered: false,
      mcpReconciliationRefused: true,
      mcpReconciliationReason: "runtime mismatch",
    });
  });
});
