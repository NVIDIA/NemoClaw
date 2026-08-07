// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  legacyOpenshellSandboxSshHost,
  OPENSHELL_DEFAULT_WORKSPACE,
  openshellSandboxSshHost,
  resolveOpenshellSandboxSshHost,
} from "./sandbox-ssh-host";

describe("OpenShell sandbox SSH host", () => {
  it("uses the workspace-qualified v0.0.99 alias for the default workspace (#8497)", () => {
    expect(OPENSHELL_DEFAULT_WORKSPACE).toBe("default");
    expect(openshellSandboxSshHost("alpha")).toBe("openshell-alpha.default");
  });

  it("recognizes the legacy alias used before the gateway upgrade (#8497)", () => {
    expect(legacyOpenshellSandboxSshHost("alpha")).toBe("openshell-alpha");
    expect(
      resolveOpenshellSandboxSshHost("alpha", "Host openshell-alpha\n  HostName 127.0.0.1\n"),
    ).toBe("openshell-alpha");
  });

  it("prefers the workspace-qualified alias when both exact aliases are declared (#8497)", () => {
    expect(
      resolveOpenshellSandboxSshHost(
        "alpha",
        "Host openshell-alpha openshell-alpha.default\n  HostName 127.0.0.1\n",
      ),
    ).toBe("openshell-alpha.default");
  });

  it("rejects wildcard, negated, or unrelated host declarations (#8497)", () => {
    expect(
      resolveOpenshellSandboxSshHost(
        "alpha",
        "Host * !openshell-alpha openshell-alpha-* openshell-other.default\n",
      ),
    ).toBeNull();
  });
});
