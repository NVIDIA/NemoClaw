// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_POLICY,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import { runHermesPortableOnboardingTransaction } from "./hermes-portable-onboarding";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-image-test-"));
  fs.writeFileSync(path.join(stateDir, "create.yaml"), HERMES_PORTABLE_TEST_POLICY, {
    mode: 0o600,
  });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable image handoff", () => {
  it.each([
    ["build failure", { buildStatus: 125 }, "Podman image build failed"],
    ["missing local image", { inspectImageStatus: 1 }, "unavailable in the selected Podman store"],
    ["publish failure", { pushStatus: 125 }, "image publication"],
    [
      "missing registry image",
      { imageAvailable: false },
      "not visible in the managed local registry",
    ],
  ] as const)("stops before create after %s", async (_case, options, message) => {
    const input = createHermesPortableTestInput(stateDir, path.join(stateDir, "create.yaml"));
    const fixture = createHermesPortableTransactionFixture(input, options);
    await expect(runHermesPortableOnboardingTransaction(input, fixture.value)).rejects.toThrow(
      message,
    );
    expect(fixture.events).not.toContain("create");
  });
});
