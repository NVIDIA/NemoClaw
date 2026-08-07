// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { OPENSHELL_DEFAULT_WORKSPACE, openshellSandboxSshHost } from "./sandbox-ssh-host";

describe("OpenShell sandbox SSH host", () => {
  it("uses the workspace-qualified v0.0.99 alias for the default workspace (#8497)", () => {
    expect(OPENSHELL_DEFAULT_WORKSPACE).toBe("default");
    expect(openshellSandboxSshHost("alpha")).toBe("openshell-alpha.default");
  });
});
