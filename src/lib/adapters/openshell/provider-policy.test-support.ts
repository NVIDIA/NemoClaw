// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

export const absentPolicy = {
  status: 0,
  stdout: JSON.stringify({ revisions: [], next_page_token: "" }),
  stderr: "",
};
export function fixture(policy = absentPolicy) {
  return vi.fn(async (args: string[]) => {
    if (args[0] !== "policy") throw new Error("Unexpected provider-policy command");
    if (args[1] === "list") {
      return policy === absentPolicy
        ? absentPolicy
        : {
            status: 0,
            stdout: JSON.stringify({ revisions: [{ scope: "global" }], next_page_token: "" }),
            stderr: "",
          };
    }
    return policy;
  });
}
