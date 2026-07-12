// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  gatewayDestroySkipMessage,
  OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE,
  preservedRegistryUnrecoverableWarnings,
  providerDeleteSkipMessage,
} from "./messaging";

describe("uninstall no-op delete wording (#6520, #3456)", () => {
  it("describes the actual state instead of 'Deleted … skipped'", () => {
    expect(OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE).toBe(
      "OpenShell sandboxes already removed or unreachable",
    );
    expect(providerDeleteSkipMessage("nvidia-nim")).toBe(
      "Provider 'nvidia-nim' already removed or unreachable",
    );
    expect(gatewayDestroySkipMessage("nemoclaw")).toBe(
      "Gateway 'nemoclaw' already removed or unreachable",
    );
  });
});

describe("preservedRegistryUnrecoverableWarnings (#6520)", () => {
  it("warns with remediation when sandboxes.json is preserved", () => {
    const lines = preservedRegistryUnrecoverableWarnings(
      ["rebuild-backups", "backups", "sandboxes.json"],
      "nemoclaw",
    );
    const joined = lines.join("\n");
    expect(joined).toContain("sandboxes.json");
    expect(joined).toContain("cannot be recovered automatically");
    expect(joined).toContain("'nemoclaw <name> destroy'");
    expect(joined).toContain("'nemoclaw onboard'");
    expect(joined).toContain("--destroy-user-data");
  });

  it("stays silent when sandboxes.json is not being preserved", () => {
    expect(preservedRegistryUnrecoverableWarnings(["rebuild-backups"], "nemoclaw")).toEqual([]);
  });
});
