// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerCapture: mocks.dockerCapture,
}));

import {
  getImageGlibcVersion,
  imageMeetsMinimumGlibc,
  parseGlibcVersion,
  versionGte,
} from "./image-compatibility";

describe("sandbox base-image glibc compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
      args[0] === "run" ? "ldd (GNU libc) 2.41" : "",
    );
  });

  it.each([
    ["\nldd (GNU libc) 2.17\nCopyright (C) Free Software Foundation", "2.17"],
    ["ldd (Debian GLIBC 2.41-12+deb13u2) 2.41\nCopyright notice", "2.41"],
    ["ldd wrapper\nGNU C Library (Ubuntu GLIBC 2.39-0ubuntu8.6)", "2.39"],
    ["musl libc (x86_64)\nVersion 1.2.5", null],
    [null, null],
  ])("parses glibc from representative ldd output %#", (output, expected) => {
    expect(parseGlibcVersion(output)).toBe(expected);
  });

  it.each([
    ["2.41", "2.39", true],
    ["2.39", "2.39", true],
    ["2.39.1", "2.39", true],
    ["2.38.9", "2.39", false],
    ["2.9", "2.10", false],
  ])("compares %s against minimum %s", (version, minimum, expected) => {
    expect(versionGte(version, minimum)).toBe(expected);
  });

  it("reads the image glibc version through the Docker adapter", () => {
    mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
      args[0] === "run" ? "ldd (GNU libc) 2.41\nCopyright notice" : "",
    );

    expect(getImageGlibcVersion("nemoclaw:test")).toBe("2.41");
    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      [
        "run",
        "--rm",
        "--name",
        expect.stringMatching(/^nemoclaw-glibc-probe-\d+-\d+$/),
        "--entrypoint",
        "/usr/bin/ldd",
        "nemoclaw:test",
        "--version",
      ],
      { ignoreError: true, timeout: 20_000 },
    );
  });

  it("retries a probe with missing output and removes its retained container (#8375)", () => {
    mocks.dockerCapture
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("ldd (Debian GLIBC 2.41-12+deb13u3) 2.41");

    expect(getImageGlibcVersion("nemoclaw:cold")).toBe("2.41");

    const probeCalls = mocks.dockerCapture.mock.calls.filter((call) => call[0]?.[0] === "run");
    expect(probeCalls.map((call) => call[1]?.timeout)).toEqual([20_000, 120_000]);
    const containerNames = probeCalls.map((call) => call[0]?.[3]);
    expect(new Set(containerNames)).toHaveProperty("size", 2);
    const cleanupNames = mocks.dockerCapture.mock.calls
      .filter((call) => call[0]?.[0] === "rm")
      .map((call) => call[0]?.[2]);
    expect(cleanupNames).toEqual([containerNames[0]]);
  });

  it("does not retry non-empty incompatible output", () => {
    mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
      args[0] === "run" ? "musl libc (x86_64)\nVersion 1.2.5" : "",
    );

    expect(getImageGlibcVersion("nemoclaw:musl")).toBeNull();
    expect(mocks.dockerCapture.mock.calls.filter((call) => call[0]?.[0] === "run")).toHaveLength(1);
  });

  it.each([
    ["ldd (GNU libc) 2.41", "2.39", { ok: true, version: "2.41" }],
    ["ldd (GNU libc) 2.36", "2.39", { ok: false, version: "2.36" }],
    ["musl libc (x86_64)\nVersion 1.2.5", "2.39", { ok: false, version: null }],
  ])("enforces the minimum glibc version %#", (output, minimum, expected) => {
    mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
      args[0] === "run" ? output : "",
    );

    expect(imageMeetsMinimumGlibc("nemoclaw:test", minimum)).toEqual(expected);
  });
});
