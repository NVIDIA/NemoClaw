// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ preparePortableExperimentalHost: vi.fn() }));

vi.mock("./experimental/portable-host-preparation", () => ({
  preparePortableExperimentalHost: mocks.preparePortableExperimentalHost,
}));

import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import {
  rejectUnsupportedContainerRuntime,
  runFatalOnboardRuntimePreflight,
} from "./fatal-runtime-preflight";
import type { HostAssessment } from "./preflight";

function hostWithRuntime(runtime: HostAssessment["runtime"]): HostAssessment {
  return {
    platform: process.platform,
    isWsl: false,
    runtime,
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: runtime === "podman",
    isHeadlessLikely: false,
    hasNvidiaGpu: false,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: false,
    notes: [],
  };
}

describe("rejectUnsupportedContainerRuntime (#7320)", () => {
  // The Docker-driver gateway path is forced on Linux and Apple Silicon macOS;
  // the reject gate only fires there. Gate the test on the same predicate via
  // it.skipIf (not an in-body `if`) so it runs on the Linux CI runner.
  it.skipIf(!isLinuxDockerDriverGatewayEnabled())(
    "exits when Podman is detected on a Docker-driver gateway platform",
    () => {
      const exit = vi.fn(() => {
        throw new Error("exit");
      });
      expect(() =>
        rejectUnsupportedContainerRuntime(hostWithRuntime("podman"), exit as never),
      ).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it("does not exit for a supported Docker runtime", () => {
    const exit = vi.fn();
    rejectUnsupportedContainerRuntime(hostWithRuntime("docker"), exit as never);
    expect(exit).not.toHaveBeenCalled();
  });

  it.skipIf(!isLinuxDockerDriverGatewayEnabled())(
    "allows Podman only when the portable profile is explicit",
    () => {
      vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
      const exit = vi.fn();
      rejectUnsupportedContainerRuntime(hostWithRuntime("podman"), exit as never);
      expect(exit).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    },
  );
});

describe("runFatalOnboardRuntimePreflight", () => {
  it("prepares the portable host before probing the container runtime", () => {
    mocks.preparePortableExperimentalHost.mockImplementationOnce(() => {
      throw new Error("portable host prepared");
    });

    expect(() => runFatalOnboardRuntimePreflight({}, { nonInteractive: true })).toThrow(
      "portable host prepared",
    );
    expect(mocks.preparePortableExperimentalHost).toHaveBeenCalledWith(process.env);
  });
});
