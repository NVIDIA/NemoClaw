// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
  dockerForceRm: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerCapture: mocks.dockerCapture,
  dockerForceRm: mocks.dockerForceRm,
}));

import {
  getImageGlibcVersion,
  imageMeetsMinimumGlibc,
  parseGlibcVersion,
  versionGte,
} from "./image-compatibility";

function mockProbeOutputs(outputs: readonly string[]): void {
  let probeIndex = 0;
  mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
    args[0] === "run" ? (outputs[probeIndex++] ?? "") : "",
  );
}

function mockRetainedProbeContainer(): void {
  let retainedContainerName = "";
  mocks.dockerCapture.mockImplementation((args: readonly string[]) => {
    switch (args[0]) {
      case "run":
        retainedContainerName = String(args[3]);
        return "";
      case "container":
        return retainedContainerName;
      default:
        return "";
    }
  });
}

function throwCleanupVerificationError(): never {
  throw new Error("Docker daemon unavailable during cleanup verification");
}

function mockCleanupVerificationFailure(): void {
  mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
    args[0] === "run" ? "" : throwCleanupVerificationError(),
  );
}

describe("sandbox base-image glibc compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
      args[0] === "run" ? "ldd (GNU libc) 2.41" : "",
    );
    mocks.dockerForceRm.mockReturnValue({ error: undefined, status: 0 });
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
        expect.stringMatching(/^nemoclaw-glibc-probe-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
        "--entrypoint",
        "/usr/bin/ldd",
        "nemoclaw:test",
        "--version",
      ],
      { ignoreError: true, timeout: 20_000 },
    );
  });

  it("retries a probe with missing output and removes its retained container (#8375)", () => {
    mockProbeOutputs(["", "ldd (Debian GLIBC 2.41-12+deb13u3) 2.41"]);

    expect(getImageGlibcVersion("nemoclaw:cold")).toBe("2.41");

    const probeCalls = mocks.dockerCapture.mock.calls.filter((call) => call[0]?.[0] === "run");
    expect(probeCalls.map((call) => call[1]?.timeout)).toEqual([20_000, 120_000]);
    const containerNames = probeCalls.map((call) => call[0]?.[3]);
    expect(new Set(containerNames)).toHaveProperty("size", 2);
    expect(mocks.dockerForceRm).toHaveBeenCalledWith(containerNames[0], {
      ignoreError: true,
      suppressOutput: true,
      timeout: 20_000,
    });
    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      [
        "container",
        "ls",
        "--all",
        "--filter",
        `name=^/${containerNames[0]}$`,
        "--format",
        "{{.Names}}",
      ],
      { timeout: 20_000 },
    );
  });

  it("removes both retained containers when both probe attempts return no output (#8375)", () => {
    mocks.dockerCapture.mockReturnValue("");

    expect(getImageGlibcVersion("nemoclaw:cold")).toBeNull();

    const probeCalls = mocks.dockerCapture.mock.calls.filter((call) => call[0]?.[0] === "run");
    expect(probeCalls.map((call) => call[1]?.timeout)).toEqual([20_000, 120_000]);
    const containerNames = probeCalls.map((call) => call[0]?.[3]);
    expect(new Set(containerNames)).toHaveProperty("size", 2);
    expect(mocks.dockerForceRm.mock.calls).toEqual(
      containerNames.map((containerName) => [
        containerName,
        { ignoreError: true, suppressOutput: true, timeout: 20_000 },
      ]),
    );
    const absenceChecks = mocks.dockerCapture.mock.calls.filter(
      (call) => call[0]?.[0] === "container",
    );
    expect(absenceChecks).toHaveLength(2);
  });

  it("accepts a failed removal only when the retained container is already absent (#8375)", () => {
    mocks.dockerForceRm.mockReturnValue({ error: undefined, status: 1 });
    mockProbeOutputs(["", "ldd (GNU libc) 2.41"]);

    expect(getImageGlibcVersion("nemoclaw:cold")).toBe("2.41");
    expect(mocks.dockerCapture.mock.calls.filter((call) => call[0]?.[0] === "run")).toHaveLength(2);
  });

  it.each([
    [{ error: undefined, status: 1 }, "returned status 1"],
    [
      { error: new Error("Docker removal failed"), status: null },
      "failed before returning an exit status",
    ],
  ])("stops before retry when cleanup %s leaves the retained container present (#8375)", (removal, expectedStatus) => {
    mocks.dockerForceRm.mockReturnValue(removal);
    mockRetainedProbeContainer();

    expect(() => getImageGlibcVersion("nemoclaw:cold")).toThrow(
      new RegExp(`cleanup ${expectedStatus}; container nemoclaw-glibc-probe-.+ is still present`),
    );
    expect(mocks.dockerCapture.mock.calls.filter((call) => call[0]?.[0] === "run")).toHaveLength(1);
  });

  it("stops before retry when retained-container absence cannot be verified (#8375)", () => {
    mockCleanupVerificationFailure();

    expect(() => getImageGlibcVersion("nemoclaw:cold")).toThrow(
      "Docker daemon unavailable during cleanup verification",
    );
    expect(mocks.dockerCapture.mock.calls.filter((call) => call[0]?.[0] === "run")).toHaveLength(1);
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
