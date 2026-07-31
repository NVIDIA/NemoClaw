// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseOpenShellSandboxId } from "./sandbox-identity";

describe("OpenShell sandbox identity parsing", () => {
  it("accepts one exact durable ID with optional terminal color", () => {
    expect(parseOpenShellSandboxId("Name: alpha\nID: sandbox-alpha\n")).toBe("sandbox-alpha");
    expect(parseOpenShellSandboxId("\u001b[32mId: sandbox.alpha_2\u001b[0m\n")).toBe(
      "sandbox.alpha_2",
    );
  });

  it("rejects ambiguous or non-canonical IDs", () => {
    expect(parseOpenShellSandboxId("ID: first\nID: second\n")).toBeNull();
    expect(parseOpenShellSandboxId("ID: sandbox/alpha\n")).toBeNull();
    expect(parseOpenShellSandboxId("id: sandbox-alpha\n")).toBeNull();
  });
});
