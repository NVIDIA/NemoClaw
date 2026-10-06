// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import { describe, expect, it } from "vitest";
import { isWsl as platformIsWsl } from "../platform";
import { isWsl, type WslDetectionOptions } from "./wsl";

describe("WSL host detection", () => {
  it.each([
    {
      name: "explicit true override",
      options: { isWsl: true, platform: "darwin" },
      expected: true,
    },
    {
      name: "explicit false override",
      options: { isWsl: false, platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } },
      expected: false,
    },
    {
      name: "macOS",
      options: { platform: "darwin", env: { WSL_INTEROP: "present" } },
      expected: false,
    },
    {
      name: "Windows",
      options: { platform: "win32", env: { WSL_INTEROP: "present" } },
      expected: false,
    },
    {
      name: "WSL distribution environment",
      options: { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "6.1.0" },
      expected: true,
    },
    {
      name: "WSL interop environment",
      options: { platform: "linux", env: { WSL_INTEROP: "present" }, release: "6.1.0" },
      expected: true,
    },
    {
      name: "Microsoft kernel release",
      options: { platform: "linux", env: {}, release: "6.6.87.2-Microsoft-standard-WSL2" },
      expected: true,
    },
    {
      name: "Microsoft proc version",
      options: {
        platform: "linux",
        env: {},
        release: "6.1.0",
        procVersion: "Linux microsoft WSL2",
      },
      expected: true,
    },
    {
      name: "native Linux",
      options: { platform: "linux", env: {}, release: "6.1.0" },
      expected: false,
    },
  ] satisfies Array<{ name: string; options: WslDetectionOptions; expected: boolean }>)(
    "preserves detection for $name (#10440)",
    ({ options, expected }) => {
      expect(isWsl(options)).toBe(expected);
    },
  );

  it("uses the current host when detection inputs are omitted (#10440)", () => {
    expect(isWsl()).toBe(
      process.platform === "linux" &&
        (Boolean(process.env.WSL_DISTRO_NAME) ||
          Boolean(process.env.WSL_INTEROP) ||
          /microsoft/i.test(os.release())),
    );
  });

  it("retains the same public platform detection entry point (#10440)", () => {
    expect(platformIsWsl).toBe(isWsl);
  });
});
