// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { checkInstallerRuntime, versionGte, versionMajor } from "./version";

describe("installer version helpers", () => {
  it("matches shell version_gte semantics", () => {
    expect(versionGte("1.2.3", "1.2.3")).toBe(true);
    expect(versionGte("2.0.0", "1.9.9")).toBe(true);
    expect(versionGte("0.17.0", "0.18.0")).toBe(false);
    expect(versionGte("0.19.0", "0.18.0")).toBe(true);
    expect(versionGte("0.18.1", "0.18.0")).toBe(true);
    expect(versionGte("0.18.0", "0.18.1")).toBe(false);
    expect(versionGte("22.16", "22.16.0")).toBe(true);
    expect(versionGte("22.16.0-rc.1", "22.16.0")).toBe(false);
  });

  it("extracts numeric major versions with optional v prefix", () => {
    expect(versionMajor("v22.16.0")).toBe(22);
    expect(versionMajor("10.9.4")).toBe(10);
    expect(versionMajor("bad")).toBeNull();
  });

  it("classifies supported and unsupported installer runtimes", () => {
    expect(checkInstallerRuntime({ nodeVersion: "v22.16.0", npmVersion: "10.0.0" })).toEqual({
      ok: true,
      nodeVersion: "v22.16.0",
      npmVersion: "10.0.0",
    });
    expect(checkInstallerRuntime({ nodeVersion: "v22.15.0", npmVersion: "10.0.0" })).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(checkInstallerRuntime({ nodeVersion: "v22.16.0", npmVersion: "9.9.9" })).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(checkInstallerRuntime({ nodeVersion: "unknown", npmVersion: "10.0.0" })).toEqual({
      ok: false,
      reason: "invalid-node-version",
    });
    expect(checkInstallerRuntime({ nodeVersion: "v22.16.0", npmVersion: "wat" })).toEqual({
      ok: false,
      reason: "invalid-npm-version",
    });
  });
});
