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
    mocks.dockerCapture.mockReturnValue("ldd (GNU libc) 2.41\nCopyright notice");

    expect(getImageGlibcVersion("nemoclaw:test")).toBe("2.41");
    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      ["run", "--rm", "--entrypoint", "/usr/bin/ldd", "nemoclaw:test", "--version"],
      { ignoreError: true, timeout: 20_000 },
    );
  });

  it.each([
    ["ldd (GNU libc) 2.41", "2.39", { ok: true, version: "2.41" }],
    ["ldd (GNU libc) 2.36", "2.39", { ok: false, version: "2.36" }],
    ["musl libc (x86_64)\nVersion 1.2.5", "2.39", { ok: false, version: null }],
  ])("enforces the minimum glibc version %#", (output, minimum, expected) => {
    mocks.dockerCapture.mockReturnValue(output);

    expect(imageMeetsMinimumGlibc("nemoclaw:test", minimum)).toEqual(expected);
  });
});
