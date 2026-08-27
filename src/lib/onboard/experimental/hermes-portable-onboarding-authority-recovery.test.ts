// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_POLICY as POLICY,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import { runHermesPortableOnboardingTransaction } from "./hermes-portable-onboarding";
import {
  hermesPortableReceiptDirectory,
  publishHermesPortableSuccessorReceipt,
} from "./hermes-portable-receipt";

const SANDBOX = "alpha";
let stateDir: string;
let policyPath: string;

function input() {
  return createHermesPortableTestInput(stateDir, policyPath);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-authority-recovery-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable onboarding authority recovery", () => {
  it("leaves a pre-existing active schema-5 receipt for probe-only migration (#10423)", async () => {
    const fixture = createHermesPortableTransactionFixture(input());
    await runHermesPortableOnboardingTransaction(input(), fixture.value);
    const authorityPath = path.join(
      hermesPortableReceiptDirectory(SANDBOX, stateDir),
      "authority.json",
    );
    fs.unlinkSync(authorityPath);
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

    const resumed = await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(resumed.active.successor).toBeUndefined();
    expect(fs.existsSync(authorityPath)).toBe(false);
  });

  it("finishes only an interrupted schema-6 publication during active resume (#10423)", async () => {
    const fixture = createHermesPortableTransactionFixture(input());
    await runHermesPortableOnboardingTransaction(input(), fixture.value);
    const authorityPath = path.join(
      hermesPortableReceiptDirectory(SANDBOX, stateDir),
      "authority.json",
    );
    fs.unlinkSync(authorityPath);
    await withMcpLifecycleLock(
      SANDBOX,
      async () => {
        expect(() =>
          publishHermesPortableSuccessorReceipt(SANDBOX, stateDir, {
            afterCanonicalLink: () => {
              throw new Error("simulated schema-6 process exit");
            },
          }),
        ).toThrow("simulated schema-6 process exit");
      },
      { stateDir: path.join(stateDir, "state") },
    );
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

    const resumed = await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(resumed.active.successor?.receipt.schemaVersion).toBe(6);
    expect(fs.statSync(authorityPath).nlink).toBe(1);
  });
});
