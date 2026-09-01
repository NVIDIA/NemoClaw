// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_POLICY as POLICY,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import { runHermesPortableOnboardingTransaction } from "./hermes-portable-onboarding";

let stateDir: string;
let policyPath: string;

function input() {
  return createHermesPortableTestInput(stateDir, policyPath);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-gateway-port-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable onboarding gateway-port recovery", () => {
  it("repairs a legacy configuring registry row without gateway port before active publication (#9211)", async () => {
    const fixture = createHermesPortableTransactionFixture(input(), {
      failAfterRegistry: true,
      omitRegistryGatewayPort: true,
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "registry-to-active exit",
    );
    expect(fixture.value.readRegistry()).not.toHaveProperty("gatewayPort");
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

    const resumed = await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(resumed.active.receipt.phase).toBe("active");
    expect(fixture.value.readRegistry()).toMatchObject({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    expect(fixture.events.filter((event) => event === "registry-update")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "create")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "registry")).toHaveLength(1);
  });

  it("does not repair a replacement row after gateway-port qualification (#10056)", async () => {
    const replacementGeneration = "44444444-4444-4444-8444-444444444444";
    const fixture = createHermesPortableTransactionFixture(input(), {
      failAfterRegistry: true,
      omitRegistryGatewayPort: true,
      beforeCompareAndSetRegistryGatewayPort: (current) => ({
        ...current!,
        lifecycleGeneration: replacementGeneration,
      }),
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "registry-to-active exit",
    );
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "registry gateway port repair did not complete",
    );
    expect(fixture.value.readRegistry()).toMatchObject({
      lifecycleGeneration: replacementGeneration,
      gatewayName: "nemoclaw",
    });
    expect(fixture.value.readRegistry()).not.toHaveProperty("gatewayPort");
    expect(fixture.events).not.toContain("registry-update");
  });
});
