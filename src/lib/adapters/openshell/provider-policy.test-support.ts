// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

export const absentPolicy = { status: 0, stdout: "", stderr: "No global policy history found\n" };
export function fixture(enabled = "true", policy = absentPolicy) {
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "policy") return policy;
    if (args[1] === "set") {
      enabled = "true";
      return { status: 0, stdout: "", stderr: "" };
    }
    return {
      status: 0,
      stdout: JSON.stringify({ scope: "global", settings: { providers_v2_enabled: enabled } }),
      stderr: "",
    };
  });
  return run;
}
