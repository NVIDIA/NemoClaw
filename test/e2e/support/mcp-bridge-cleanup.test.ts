// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { shouldRetryMcpMutationAfterConcurrencyConflict } from "../live/mcp-bridge-cleanup.ts";

describe("MCP mutation concurrency retry", () => {
  it("retries the explicit OpenShell optimistic-concurrency response", () => {
    expect(
      shouldRetryMcpMutationAfterConcurrencyConflict(
        "Failed to detach provider: sandbox was modified by another operation.\nPlease retry the command.",
      ),
    ).toBe(true);
  });

  it.each([
    "Failed to detach provider: permission denied",
    "sandbox was modified by another operation.",
    "Please retry the command.",
  ])("does not retry another failure: %s", (output) => {
    expect(shouldRetryMcpMutationAfterConcurrencyConflict(output)).toBe(false);
  });
});
