// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { type MockParityManifest, validateMockParity } from "../scripts/checks/e2e-mock-parity";

const live = "test/e2e/live/example.test.ts";
const fast = "test/e2e/support/example.test.ts";
const exists = (file: string) => file === live || file === fast;

function manifest(entries: MockParityManifest["entries"]): MockParityManifest {
  return { version: 1, entries };
}

describe("changed live E2E mock parity", () => {
  it("accepts a changed live E2E mapped to a fast PR test", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("rejects a changed live E2E without a parity decision", () => {
    expect(
      validateMockParity({ manifest: manifest([]), changedFiles: [live], fileExists: exists }),
    ).toEqual([`${live}: changed live E2E needs an entry in test/e2e/mock-parity.json`]);
  });

  it("rejects mappings to missing or non-PR tests", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: ["test/e2e/live/not-fast.test.ts", fast] }]),
        changedFiles: [live],
        fileExists: (file) => file === live,
      }),
    ).toEqual([
      `${live}: mapped fast test does not exist: ${fast}`,
      `${live}: test/e2e/live/not-fast.test.ts is not collected by a fast PR test project`,
    ]);
  });

  it("accepts an explicit decision for behavior that cannot be mocked", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveOnlyReason: "Requires public TLS and provider auth" }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("reports a non-string live-only reason as a validation error", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveOnlyReason: 42 as unknown as string }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([`${live}: liveOnlyReason must be a string`]);
  });
});
