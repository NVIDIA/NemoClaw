// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CUA_FRAMEWORK_FEATURE_ENV,
  CUA_QUALIFICATION_FEATURE_ENV,
  isCuaFrameworkEnabled,
  isCuaQualificationEnabled,
  requireCuaFrameworkEnabled,
} from "./feature";

describe("CUA framework activation (#7750)", () => {
  it("uses the dedicated CUA framework flag", () => {
    expect(CUA_FRAMEWORK_FEATURE_ENV).toBe("NEMOCLAW_CUA_ENABLED");
    expect(isCuaFrameworkEnabled({ NEMOCLAW_CUA_ENABLED: "1" })).toBe(true);
    expect(() => requireCuaFrameworkEnabled({})).toThrow(
      "use the controlled Brev Launchable activation",
    );
    expect(() => requireCuaFrameworkEnabled({ NEMOCLAW_CUA_ENABLED: "1" })).not.toThrow();
  });

  it.each([[undefined], [""], ["true"], ["0"], ["01"], [" 1"], ["1 "]])(
    "keeps CUA disabled for the flag value %j",
    (value) => {
      expect(isCuaFrameworkEnabled({ NEMOCLAW_CUA_ENABLED: value })).toBe(false);
    },
  );

  it("requires the framework flag before candidate qualification", () => {
    expect(CUA_QUALIFICATION_FEATURE_ENV).toBe("NEMOCLAW_CUA_QUALIFICATION");
    expect(isCuaQualificationEnabled({ NEMOCLAW_CUA_QUALIFICATION: "1" })).toBe(false);
    expect(
      isCuaQualificationEnabled({
        NEMOCLAW_CUA_ENABLED: "1",
        NEMOCLAW_CUA_QUALIFICATION: "1",
      }),
    ).toBe(true);
  });

  it.each([[undefined], [""], ["true"], ["0"], ["01"], [" 1"], ["1 "]])(
    "keeps candidate qualification disabled for the flag value %j",
    (value) => {
      expect(
        isCuaQualificationEnabled({
          NEMOCLAW_CUA_ENABLED: "1",
          NEMOCLAW_CUA_QUALIFICATION: value,
        }),
      ).toBe(false);
    },
  );
});
