// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assessWindowsMxcProcessContainerCandidate,
  parseWindowsBuild,
  WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION,
} from "./host-qualification";

describe("native Windows/MXC process_container host qualification", () => {
  it("returns a candidate at the exact inactive x64 build floor (#8178)", () => {
    expect(
      assessWindowsMxcProcessContainerCandidate({
        platform: "win32",
        nativeArchitecture: "x64",
        release: "10.0.26100",
      }),
    ).toEqual({
      candidate: true,
      contractVersion: WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION,
      platform: "win32",
      nativeArchitecture: "x64",
      windowsBuild: 26100,
    });
  });

  it("accepts a newer Windows revision without treating it as the build (#8178)", () => {
    expect(
      assessWindowsMxcProcessContainerCandidate({
        platform: "win32",
        nativeArchitecture: "x64",
        release: "10.0.28000.1836",
      }),
    ).toMatchObject({ candidate: true, windowsBuild: 28000 });
  });

  it("rejects WSL and every other non-Windows host (#8178)", () => {
    expect(
      assessWindowsMxcProcessContainerCandidate({
        platform: "linux",
        nativeArchitecture: "x64",
        release: "6.6.87.2-microsoft-standard-WSL2",
      }),
    ).toMatchObject({ candidate: false, reason: "non-windows-host" });
  });

  it("rejects an emulated x64 process on a native ARM64 host (#8178)", () => {
    expect(
      assessWindowsMxcProcessContainerCandidate({
        platform: "win32",
        nativeArchitecture: "arm64",
        release: "10.0.28000",
      }),
    ).toMatchObject({ candidate: false, reason: "unqualified-architecture" });
  });

  it("fails closed below the process_container candidate build floor (#8178)", () => {
    expect(
      assessWindowsMxcProcessContainerCandidate({
        platform: "win32",
        nativeArchitecture: "x64",
        release: "10.0.26099",
      }),
    ).toMatchObject({
      candidate: false,
      reason: "windows-build-below-candidate-floor",
    });
  });

  it.each([
    "",
    "10",
    "10.0",
    "10.0.build",
    "6.6.87.2-microsoft-standard-WSL2",
  ])("fails closed when release %j is not a Windows build form (#8178)", (release) => {
    expect(
      assessWindowsMxcProcessContainerCandidate({
        platform: "win32",
        nativeArchitecture: "x64",
        release,
      }),
    ).toMatchObject({ candidate: false, reason: "unknown-windows-build" });
  });
});

describe("Windows build parsing", () => {
  it.each([
    ["10.0.26100", 26100],
    ["10.0.26300.8553", 26300],
    [" 10.0.28000.1836 ", 28000],
  ])("extracts the build from %s (#8178)", (release, expected) => {
    expect(parseWindowsBuild(release)).toBe(expected);
  });
});
