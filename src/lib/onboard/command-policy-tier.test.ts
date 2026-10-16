// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveOnboardOptions, runOnboardCommand } from "./command";
import { listPolicyTierNames } from "../policy/tiers";
import type { OnboardFlags } from "./command-support";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

function resolve(
  flags: OnboardFlags,
  overrides: Partial<Parameters<typeof resolveOnboardOptions>[1]> = {},
) {
  return resolveOnboardOptions(flags, {
    env: {},
    error: () => {},
    exit: exitWithCode,
    listPolicyTiers: listPolicyTierNames,
    ...overrides,
  });
}

describe("onboard --policy-tier (#13180)", () => {
  it("accepts exact --policy-tier names and rejects unknown or Portable use (#13180)", () => {
    expect(resolve({ "policy-tier": "restricted" }).requestedPolicyTier).toBe("restricted");
    expect(resolve({}).requestedPolicyTier).toBeNull();

    const errors: string[] = [];
    const error = (message?: string) => errors.push(String(message));
    expect(() => resolve({ "policy-tier": "locked" }, { error })).toThrow("exit:1");
    expect(() => resolve({ "policy-tier": " Restricted " }, { error })).toThrow("exit:1");
    expect(() =>
      resolve({ "policy-tier": "open", "experimental-profile": "portable" }, { error }),
    ).toThrow("exit:1");
    // Resume is checked against the recorded session tier during session bootstrap.
    expect(resolve({ "policy-tier": "open", resume: true }).requestedPolicyTier).toBe("open");
    expect(errors).toEqual([
      "  Unknown policy tier: locked. Valid: restricted, balanced, open, personal",
      "  Unknown policy tier:  Restricted . Valid: restricted, balanced, open, personal",
      "  --policy-tier cannot be used with the Portable profile.",
    ]);
  });

  it("carries --policy-tier on the run options without mutating the environment (#13180)", async () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_POLICY_TIER: "open" };
    const seen: Array<string | null> = [];
    await runOnboardCommand({
      flags: { "policy-tier": "restricted" },
      env,
      listPolicyTiers: listPolicyTierNames,
      runOnboard: async (options) => {
        seen.push(options.requestedPolicyTier);
        expect(env.NEMOCLAW_POLICY_TIER).toBe("open");
      },
    });
    expect(seen).toEqual(["restricted"]);
    expect(env).toEqual({ NEMOCLAW_POLICY_TIER: "open" });
  });

  it("leaves the tier prompt in charge when the flag is absent", async () => {
    await runOnboardCommand({
      flags: {},
      env: { NEMOCLAW_POLICY_TIER: "open" },
      runOnboard: async (options) => {
        expect(options.requestedPolicyTier).toBeNull();
      },
    });
  });
});
