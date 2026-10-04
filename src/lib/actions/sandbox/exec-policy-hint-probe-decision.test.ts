// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { POLICY_HINT_SUPPRESS_ENV, shouldProbePolicyDenial } from "./exec-policy-hint";

describe("shouldProbePolicyDenial (#5978)", () => {
  it.each([
    ["success exit", 0, false, {}, false],
    ["genuine failure", 56, false, {}, true],
    ["failure but transport invocation error", 1, true, {}, false],
    ["failure suppressed with 1", 56, false, { [POLICY_HINT_SUPPRESS_ENV]: "1" }, false],
    ["failure suppressed with TRUE", 56, false, { [POLICY_HINT_SUPPRESS_ENV]: "TRUE" }, false],
    ["failure suppressed with True", 56, false, { [POLICY_HINT_SUPPRESS_ENV]: "True" }, false],
    ["failure suppressed with YES", 56, false, { [POLICY_HINT_SUPPRESS_ENV]: "YES" }, false],
    [
      "failure with opt-out explicitly disabled",
      56,
      false,
      { [POLICY_HINT_SUPPRESS_ENV]: "0" },
      true,
    ],
    [
      "failure with lowercase false opt-out disabled",
      56,
      false,
      { [POLICY_HINT_SUPPRESS_ENV]: "false" },
      true,
    ],
    [
      "failure with mixed-case False opt-out disabled",
      56,
      false,
      { [POLICY_HINT_SUPPRESS_ENV]: "False" },
      true,
    ],
    [
      "failure with uppercase FALSE opt-out disabled",
      56,
      false,
      { [POLICY_HINT_SUPPRESS_ENV]: "FALSE" },
      true,
    ],
  ])("decides probe-worthiness for %s", (_label, code, hadInvocationError, env, expected) => {
    expect(shouldProbePolicyDenial(code, hadInvocationError, env as NodeJS.ProcessEnv)).toBe(
      expected,
    );
  });
});
