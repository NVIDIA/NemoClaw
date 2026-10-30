// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  gatewayDestroySkipMessage,
  OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE,
  preservedRegistryUnrecoverableWarnings,
  providerDeleteSkipMessage,
  sandboxCleanupReasonMessage,
} from "./messaging";

describe("uninstall no-op delete wording (#6520, #3456)", () => {
  it("describes the actual state instead of 'Deleted … skipped'", () => {
    expect(OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE).toBe(
      "OpenShell sandboxes already removed or unreachable",
    );
    expect(providerDeleteSkipMessage("nvidia-nim")).toBe(
      "Provider 'nvidia-nim' already removed or unreachable",
    );
    expect(gatewayDestroySkipMessage("nemoclaw")).toBe("Gateway 'nemoclaw' is already absent");
  });
});

describe("sandboxCleanupReasonMessage (#13443)", () => {
  const reasonOf = (diagnostic: string, message = "failed") =>
    sandboxCleanupReasonMessage({ diagnostic, error: { message } });

  it("uses the OpenShell diagnostic when OpenShell printed one", () => {
    expect(reasonOf("Error: status: Unavailable", "generic")).toBe(
      "Reason: Error: status: Unavailable",
    );
  });

  it.each([
    ["is empty", ""],
    ["has only whitespace", " \n "],
  ])("uses the error message when the diagnostic %s", (_case, diagnostic) => {
    expect(reasonOf(diagnostic, "connection refused")).toBe("Reason: connection refused");
  });

  it("flattens control characters and escape codes to one plain line", () => {
    expect(reasonOf("\u001b[31mboom\u001b[0m\r\nsecond\tline\u0007")).toBe(
      "Reason: boom second line",
    );
  });

  it("cuts output longer than 200 characters", () => {
    expect(reasonOf("x".repeat(500))).toBe(`Reason: ${"x".repeat(197)}...`);
  });

  it("says OpenShell gave no details when the diagnostic and message are blank", () => {
    expect(reasonOf(" \n ", "")).toBe("Reason: OpenShell gave no details.");
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
