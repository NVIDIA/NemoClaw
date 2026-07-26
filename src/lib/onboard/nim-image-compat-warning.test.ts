// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  formatArm64NimImageCompatibilityWarning,
  shouldWarnAboutArm64NimImageCompatibility,
  warnAboutArm64NimImageCompatibility,
} from "./nim-image-compat-warning";

describe("arm64 NIM image compatibility warning", () => {
  it("warns only when Local NIM is available on Linux arm64 DGX platforms", () => {
    expect(
      shouldWarnAboutArm64NimImageCompatibility({
        arch: "arm64",
        platform: "linux",
        gpu: { platform: "spark" },
        nimLocalAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldWarnAboutArm64NimImageCompatibility({
        arch: "arm64",
        platform: "linux",
        gpu: { spark: true },
        nimLocalAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldWarnAboutArm64NimImageCompatibility({
        arch: "arm64",
        platform: "linux",
        gpu: { platform: "station" },
        nimLocalAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldWarnAboutArm64NimImageCompatibility({
        arch: "x64",
        platform: "linux",
        gpu: { platform: "spark" },
        nimLocalAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldWarnAboutArm64NimImageCompatibility({
        arch: "arm64",
        platform: "linux",
        gpu: { platform: "linux" },
        nimLocalAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldWarnAboutArm64NimImageCompatibility({
        arch: "arm64",
        platform: "linux",
        gpu: { platform: "spark" },
        nimLocalAvailable: false,
      }),
    ).toBe(false);
  });

  it("describes image/platform compatibility without claiming Local NIM will fail", () => {
    const lines = formatArm64NimImageCompatibilityWarning({ gpu: { platform: "station" } });

    expect(lines.join("\n")).toContain("Linux arm64 DGX Station");
    expect(lines.join("\n")).toContain("linux/arm64 manifests");
    expect(lines.join("\n")).toContain("will try the selected image/platform digest");
    expect(lines.join("\n")).not.toMatch(/will fail|does not work/i);
  });

  it("prints the warning once through the logger", () => {
    const log = vi.fn();

    expect(
      warnAboutArm64NimImageCompatibility({
        arch: "arm64",
        platform: "linux",
        gpu: { platform: "spark" },
        nimLocalAvailable: true,
        log,
      }),
    ).toBe(true);

    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "",
      "  Warning: Local NVIDIA NIM is experimental on Linux arm64 DGX Spark hosts.",
      "  Some NIM images may not publish linux/arm64 manifests.",
      "  NemoClaw will try the selected image/platform digest when possible; if Docker reports no matching platform, choose NVIDIA Endpoints, vLLM, or another provider.",
      "",
    ]);
  });
});
