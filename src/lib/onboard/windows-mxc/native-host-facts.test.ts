// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { observeWindowsMxcNativeHostFacts } from "./native-host-facts";

describe("inactive native Windows MXC host observation", () => {
  it.each([
    ["x86_64", "x64"],
    ["AMD64", "x64"],
    ["aarch64", "arm64"],
    ["arm64", "arm64"],
  ])("maps native machine %s to %s (#8178)", (machine, nativeArchitecture) => {
    expect(
      observeWindowsMxcNativeHostFacts({
        platform: "win32",
        machine: () => machine,
        release: () => "10.0.28120.2760",
      }),
    ).toEqual({
      platform: "win32",
      nativeArchitecture,
      release: "10.0.28120.2760",
    });
  });

  it("reports a WSL host with its observed Linux platform (#8178)", () => {
    expect(
      observeWindowsMxcNativeHostFacts({
        platform: "linux",
        machine: () => "x86_64",
        release: () => "6.6.87.2-microsoft-standard-WSL2",
      }),
    ).toEqual({
      platform: "linux",
      nativeArchitecture: "x64",
      release: "6.6.87.2-microsoft-standard-WSL2",
    });
  });
});
