// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  isMockParityRelevantSourceChange,
  type MockParityManifest,
  validateMockParity,
} from "../scripts/checks/e2e-mock-parity";

const live = "test/e2e/live/example.test.ts";
const fast = "test/e2e/support/example.test.ts";
const TAGGED_NEW_SOURCE = "// @module-tag e2e/credential-free\n";
const exists = (file: string) => file === live || file === fast;

function manifest(entries: MockParityManifest["entries"]): MockParityManifest {
  return { version: 1, entries };
}

describe("changed live E2E mock parity", () => {
  it("treats module-tag-only diffs as metadata", () => {
    expect(
      isMockParityRelevantSourceChange(
        "// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n",
        "// SPDX-License-Identifier: Apache-2.0\n// @module-tag e2e/credential-free\n\nexport {};\n",
      ),
    ).toBe(false);
    expect(
      isMockParityRelevantSourceChange(
        `${"// @module"}-tag retired/value\n\nexport {};\n`,
        "// @module-tag e2e/credential-free\n\nexport {};\n",
      ),
    ).toBe(false);
    expect(
      isMockParityRelevantSourceChange(
        "// old terminology\nexport {};\n",
        "// current terminology\nexport {};\n",
      ),
    ).toBe(false);
    expect(
      isMockParityRelevantSourceChange(
        "// @module-tag e2e/credential-free\n\nexport {};\n",
        "// @module-tag e2e/credential-free\n\nexport const changed = true;\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "export const fixture = `before\nafter`;\n",
        "export const fixture = `before\n// @module-tag e2e/credential-free\nafter`;\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n",
        "// SPDX-License-Identifier: Apache-2.0\n/* @module-tag e2e/credential-free */\n\nexport {};\n",
      ),
    ).toBe(false);
    expect(isMockParityRelevantSourceChange(null, null)).toBe(true);
    expect(isMockParityRelevantSourceChange(null, TAGGED_NEW_SOURCE)).toBe(true);
  });

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
