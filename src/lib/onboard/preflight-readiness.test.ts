// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assessHost, parseDockerNvidiaRuntimeAvailable, planHostAdvisories } from "./preflight";

describe("readiness-facing host preflight", () => {
  it("accepts only an absolute OpenShell command path from an injected host transport (#7411)", () => {
    const assessWithCommandVResult = (commandVResult: string) =>
      assessHost({
        platform: "darwin",
        env: {},
        dockerInfoOutput: "",
        gpuProbeImpl: () => false,
        runCaptureImpl: (command: readonly string[]) =>
          command.at(-1) === "openshell" ? commandVResult : "",
      });

    expect(assessWithCommandVResult("/usr/local/bin/openshell").openshellInstalled).toBe(true);
    expect(assessWithCommandVResult("openshell").openshellInstalled).toBe(false);
    expect(assessWithCommandVResult("alias openshell='echo unexpected'").openshellInstalled).toBe(
      false,
    );
  });

  it("distinguishes configured, absent, and unreported NVIDIA runtimes (#7411)", () => {
    expect(parseDockerNvidiaRuntimeAvailable('{"Runtimes":{"runc":{},"nvidia":{}}}')).toBe(true);
    expect(parseDockerNvidiaRuntimeAvailable('{"Runtimes":{"runc":{}}}')).toBe(false);
    expect(parseDockerNvidiaRuntimeAvailable('{"ServerVersion":"27.0"}')).toBeUndefined();
  });

  it("does not duplicate the canonical unsupported-runtime finding as an advisory (#7411)", () => {
    const host = assessHost({
      platform: "darwin",
      env: {},
      dockerInfoOutput: '{"ServerVersion":"5.0.0","Name":"Podman Engine"}',
      gpuProbeImpl: () => false,
      runCaptureImpl: () => "",
    });

    expect(host.isUnsupportedRuntime).toBe(true);
    expect(planHostAdvisories(host).some(({ id }) => id.includes("unsupported"))).toBe(false);
  });
});
