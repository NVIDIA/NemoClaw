// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ManifestRecord } from "./definition-types";
import { detectAgentHostOs, readHostOs, requireAgentHostOsSupported } from "./host-os";

describe("agent host operating system qualification", () => {
  it("reads an absent host_os field as no host restriction", () => {
    expect(readHostOs({})).toBeNull();
  });

  it.each(["linux", "macos", "wsl", "windows", null] as const)(
    "accepts an unrestricted agent on a %s host",
    (host) => {
      expect(() =>
        requireAgentHostOsSupported({ name: "hermes", hostOs: null }, host),
      ).not.toThrow();
    },
  );

  it("reads a distinct host_os allow-list from the manifest", () => {
    expect(readHostOs({ host_os: ["linux", "macos"] })).toEqual(["linux", "macos"]);
  });

  it.each<[string, ManifestRecord]>([
    ["an empty list", { host_os: [] }],
    ["an unknown value", { host_os: ["linux", "freebsd"] }],
    ["a duplicate value", { host_os: ["linux", "linux"] }],
    ["a scalar", { host_os: "linux" }],
  ])("rejects a host_os field that is %s", (_label, record) => {
    expect(() => readHostOs(record)).toThrow(
      "Agent manifest field 'host_os' must list distinct values from: linux, macos, wsl, windows",
    );
  });

  it.each([
    ["darwin", false, "macos"],
    ["win32", false, "windows"],
    ["linux", true, "wsl"],
    ["linux", false, "linux"],
    ["freebsd", false, null],
  ] as const)("classifies platform %s with WSL %s as %s", (platform, isWsl, expected) => {
    expect(detectAgentHostOs({ platform, isWsl })).toBe(expected);
  });

  it("accepts a native Linux host for a Linux-only agent", () => {
    expect(() =>
      requireAgentHostOsSupported({ name: "pi", hostOs: ["linux"] }, "linux"),
    ).not.toThrow();
  });

  it.each([
    ["macos", "macOS"],
    ["wsl", "WSL"],
    ["windows", "Windows"],
    [null, "an unrecognized operating system"],
  ] as const)("refuses a Linux-only agent on a %s host", (host, name) => {
    expect(() => requireAgentHostOsSupported({ name: "pi", hostOs: ["linux"] }, host)).toThrow(
      `Agent 'pi' is supported only on native Linux hosts; this host is ${name}.`,
    );
  });
});
