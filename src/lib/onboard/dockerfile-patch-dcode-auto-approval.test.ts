// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { patchDcodeAutoApprovalDockerArg } from "./dockerfile-patch";

describe("DCode auto-approval Dockerfile patch", () => {
  it("rewrites the single exact managed build argument (#6478)", () => {
    expect(
      patchDcodeAutoApprovalDockerArg(
        "FROM scratch\nARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled\n",
        "thread-opt-in",
      ),
    ).toBe("FROM scratch\nARG NEMOCLAW_DCODE_AUTO_APPROVAL=thread-opt-in\n");
    expect(
      patchDcodeAutoApprovalDockerArg(
        "ARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled # stale comment\n",
        "thread-opt-in",
      ),
    ).toBe("ARG NEMOCLAW_DCODE_AUTO_APPROVAL=thread-opt-in\n");
  });

  it.each([
    ["a missing instruction", "FROM scratch\n"],
    [
      "duplicate instructions",
      "ARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled\nARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled\n",
    ],
    ["a commented instruction", "# ARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled\n"],
  ])("fails closed for %s (#6478)", (_label, dockerfile) => {
    expect(() => patchDcodeAutoApprovalDockerArg(dockerfile, "thread-opt-in")).toThrow(
      "exactly one ARG NEMOCLAW_DCODE_AUTO_APPROVAL",
    );
  });
});
