// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  extractPullRequestBaseSha,
  extractTrustedCreateRequireAllowlists,
  trustedCreateRequireExpansionFailure,
} from "../.github/actions/ci-static-checks/create-require-ratchet.mts";

describe("base-trusted createRequire ratchet", () => {
  it("extracts only literal reviewed allowlists from either checker extension (#7056)", () => {
    const source = [
      'export const CLI_CREATE_REQUIRE_FILES = ["src/a.test.ts"] as const;',
      'export const TEST_SUPPORT_CREATE_REQUIRE_FILES = ["test/helper.ts"] as const;',
    ].join("\n");

    for (const fileName of ["test-create-require-budget.ts", "test-create-require-budget.mts"]) {
      expect(extractTrustedCreateRequireAllowlists(source, fileName)).toEqual({
        cli: ["src/a.test.ts"],
        testSupport: ["test/helper.ts"],
      });
    }
    expect(() =>
      extractTrustedCreateRequireAllowlists(
        [
          "const dynamicPath = getPath();",
          "export const CLI_CREATE_REQUIRE_FILES = [dynamicPath] as const;",
          "export const TEST_SUPPORT_CREATE_REQUIRE_FILES = [] as const;",
        ].join("\n"),
      ),
    ).toThrow("CLI_CREATE_REQUIRE_FILES must be a literal string array");
  });

  it("rejects additions relative to the trusted base while permitting removals (#7056)", () => {
    expect(
      trustedCreateRequireExpansionFailure(
        { cli: ["src/a.test.ts"], testSupport: [] },
        { cli: ["src/a.test.ts", "src/retired.test.ts"], testSupport: ["test/retired.ts"] },
      ),
    ).toBeNull();

    expect(
      trustedCreateRequireExpansionFailure(
        { cli: ["src/a.test.ts", "src/new.test.ts"], testSupport: ["test/new.ts"] },
        { cli: ["src/a.test.ts"], testSupport: [] },
      ),
    ).toBe(
      [
        "createRequire allowlists must not expand relative to the trusted base.",
        "- CLI_CREATE_REQUIRE_FILES: src/new.test.ts",
        "- TEST_SUPPORT_CREATE_REQUIRE_FILES: test/new.ts",
      ].join("\n"),
    );
  });

  it("accepts only a validated base revision from the pull-request event (#7056)", () => {
    const revision = "a".repeat(40);
    expect(
      extractPullRequestBaseSha(JSON.stringify({ pull_request: { base: { sha: revision } } })),
    ).toBe(revision);
    expect(() => extractPullRequestBaseSha('{"pull_request":{"base":{"sha":"HEAD^"}}}')).toThrow(
      "pull-request event does not contain a valid base commit SHA",
    );
  });
});
