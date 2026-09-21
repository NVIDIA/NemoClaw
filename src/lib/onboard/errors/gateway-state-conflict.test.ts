// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it } from "vitest";
import { runOnboardCommand } from "../command";
import { GatewayStateConflictError } from "./gateway-state-conflict";
import { printOnboardResumeHint, resetOnboardResumeHintForTests } from "../resume-hint";

afterEach(resetOnboardResumeHintForTests);

it.each([
  { kind: "generic", options: undefined, recovery: "", expectedHints: true },
  {
    kind: "tailored",
    options: { hasRecoveryGuidance: true },
    recovery: " Use a different sandbox name, gateway port, and gateway state directory.",
    expectedHints: false,
  },
])(
  "reports $kind state conflicts with the appropriate recovery handoff",
  async ({ options, recovery, expectedHints }) => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: { "experimental-profile": "portable" },
        env: {},
        runOnboard: async () => {
          throw new GatewayStateConflictError(
            `Gateway state conflicts with this run.${recovery}\nOPENAI_API_KEY=state-secret`,
            options,
          );
        },
        error: (message = "") => errors.push(message),
        exit: (code) => {
          throw new Error(`exit:${String(code)}`);
        },
      }),
    ).rejects.toThrow("exit:1");

    const output = errors.join("\n");
    expect(output).toContain("Gateway state conflicts with this run");
    expect(output).toContain("OPENAI_API_KEY=<REDACTED>");
    expect(output).not.toContain("state-secret");
    expect(output).not.toContain(".js:");
    expect(output).not.toContain("    at ");
    printOnboardResumeHint(true, (message) => errors.push(message));
    expect(errors.join("\n").includes("onboard --resume")).toBe(expectedHints);
    expect(errors.join("\n").includes("onboard --experimental-profile portable --fresh")).toBe(
      expectedHints,
    );
  },
);
