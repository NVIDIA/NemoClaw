// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type CredentialsProviderDeleteWithRecoveryResult,
  formatResetOutcome,
} from "../../src/lib/actions/credentials/reset";

function result(
  over: Partial<CredentialsProviderDeleteWithRecoveryResult>,
): CredentialsProviderDeleteWithRecoveryResult {
  return {
    ok: false,
    detachedSandboxes: [],
    recoveryFailures: [],
    ...over,
  };
}

describe("formatResetOutcome (#5560)", () => {
  it("reports a clean removal when no detach was needed", () => {
    const outcome = formatResetOutcome("my-assistant-brave-search", result({ ok: true }));
    expect(outcome.ok).toBe(true);
    expect(outcome.lines[0]).toContain("Removed provider 'my-assistant-brave-search'");
    expect(outcome.lines.join("\n")).toContain("onboard");
  });

  it("surfaces the still-attached sandboxes with a detach hint when recovery fails", () => {
    const outcome = formatResetOutcome(
      "my-assistant-brave-search",
      result({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "FailedPrecondition: provider attached to sandbox(es): my-assistant",
          attachedSandboxes: ["my-assistant"],
        },
        recoveryFailures: [
          {
            sandbox: "my-assistant",
            error: { kind: "command", reason: "failed", message: "detach refused" },
          },
        ],
      }),
    );
    expect(outcome.ok).toBe(false);
    const text = outcome.lines.join("\n");
    expect(text).toContain("still attached to sandbox(es): my-assistant");
    expect(text).toContain("openshell sandbox provider detach <sandbox> my-assistant-brave-search");
    expect(text).toContain("FailedPrecondition");
  });

  it("hints when the argument looks like an env var name instead of a provider", () => {
    const outcome = formatResetOutcome("BRAVE_API_KEY", result({ ok: false }));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("looks like a credential env variable name");
  });
});
