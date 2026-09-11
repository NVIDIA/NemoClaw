// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import { hermesPortableReceiptDirectory } from "./hermes-portable-receipt";
import { runHermesPortableOnboardingTransaction } from "./hermes-portable-onboarding";
import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_POLICY,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";

let stateDir: string;
let policyPath: string;
const input = () => createHermesPortableTestInput(stateDir, policyPath);
const deps = () => createHermesPortableTransactionFixture(input());
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-policy-wait-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, HERMES_PORTABLE_TEST_POLICY, { mode: 0o600 });
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable onboarding policy observation", () => {
  it.each([
    { outcome: "resolve", settle: () => undefined },
    {
      outcome: "reject",
      settle: () => {
        throw new Error("policy observation unavailable");
      },
    },
  ])(
    "holds registry publication and the lifecycle lock until policy observation $outcome",
    async ({ outcome, settle }) => {
      const fixture = deps();
      const capture = fixture.value.capturePolicy!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const capturePolicy: typeof capture = async (...args) => {
        entered();
        await gate;
        settle();
        return capture(...args);
      };
      const completion = runHermesPortableOnboardingTransaction(input(), {
        ...fixture.value,
        capturePolicy,
      });
      const result =
        outcome === "reject"
          ? expect(completion).rejects.toThrow("policy")
          : expect(completion).resolves.toMatchObject({ active: { receipt: { phase: "active" } } });
      await pending;
      let contenderEntered = false;
      const contender = withMcpLifecycleLock(
        "alpha",
        async () => {
          contenderEntered = true;
        },
        { stateDir: path.join(stateDir, "state") },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(contenderEntered).toBe(false);
      expect(fixture.events).not.toContain("registry");
      const activePath = path.join(
        hermesPortableReceiptDirectory("alpha", stateDir),
        "active.json",
      );
      expect(fs.existsSync(activePath)).toBe(false);
      release();
      await result;
      await contender;
      expect(contenderEntered).toBe(true);
      expect(fs.existsSync(activePath)).toBe(outcome === "resolve");
      expect(fixture.events.includes("registry")).toBe(outcome === "resolve");
    },
  );

  it("rejects sandbox replacement during policy observation before container enrollment", async () => {
    const fixture = deps();
    const capture = fixture.value.capturePolicy!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const capturePolicy: typeof capture = async (...args) => {
      entered();
      await gate;
      return capture(...args);
    };
    let absent = false;
    const observeSandbox: typeof fixture.value.observeSandbox = (...args) =>
      absent ? { kind: "absent" } : fixture.value.observeSandbox(...args);
    const completion = expect(
      runHermesPortableOnboardingTransaction(input(), {
        ...fixture.value,
        capturePolicy,
        observeSandbox,
      }),
    ).rejects.toThrow("live sandbox authority changed during policy observation");
    await pending;
    absent = true;
    release();
    await completion;
    expect(fixture.events).not.toContain("registry");
    expect(
      fs.existsSync(
        path.join(hermesPortableReceiptDirectory("alpha", stateDir), "configuring.json"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(hermesPortableReceiptDirectory("alpha", stateDir), "active.json")),
    ).toBe(false);
  });
});
