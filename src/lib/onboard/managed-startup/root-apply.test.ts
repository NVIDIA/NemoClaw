// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { selectManagedStartupApplicationRuntimeEnvironment } from "./root-apply";

describe("managed startup root application environment", () => {
  it("canonicalizes the enabled MCP shadow diagnostics value", () => {
    expect(
      selectManagedStartupApplicationRuntimeEnvironment({
        NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: " 1 ",
      }),
    ).toEqual({ NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1" });
  });

  it.each(["true", "0", " "])("omits unsupported MCP shadow diagnostics value %j", (value) => {
    expect(
      selectManagedStartupApplicationRuntimeEnvironment({
        NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: value,
      }),
    ).toEqual({});
  });

  it("omits an unset MCP shadow diagnostics value", () => {
    expect(selectManagedStartupApplicationRuntimeEnvironment({})).toEqual({});
  });
});
