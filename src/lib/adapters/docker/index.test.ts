// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const runCaptureMock = vi.fn();

vi.mock("../../runner", () => ({
  ROOT: "/repo/root",
  run: (...args: unknown[]) => runMock(...args),
  runCapture: (...args: unknown[]) => runCaptureMock(...args),
}));

import {
  dockerBuild,
  dockerContainerInspectFormat,
  dockerInfoFormat,
  dockerListVolumesByPrefix,
  dockerPull,
  dockerRemoveVolumesByPrefix,
  dockerRmi,
  dockerRunDetached,
} from "./index";

describe("docker helpers", () => {
  beforeEach(() => {
    runMock.mockReset();
    runCaptureMock.mockReset();
    runMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    runCaptureMock.mockReturnValue("");
  });

  it("prefixes docker argv for pull/build/run/rmi helpers", () => {
    dockerPull("ghcr.io/example/image:latest");
    dockerBuild("Dockerfile", "example:tag", "/tmp/build");
    dockerRunDetached(["--name", "example", "busybox:latest"]);
    dockerRmi("example:tag");

    expect(runMock.mock.calls).toEqual([
      [["docker", "pull", "ghcr.io/example/image:latest"], {}],
      [["docker", "build", "-f", "Dockerfile", "-t", "example:tag", "/tmp/build"], {}],
      [["docker", "run", "-d", "--name", "example", "busybox:latest"], {}],
      [["docker", "rmi", "example:tag"], {}],
    ]);
  });

  it("prefixes docker argv for info/inspect capture helpers", () => {
    dockerInfoFormat("{{.KernelVersion}}", { ignoreError: true });
    dockerContainerInspectFormat("{{.State.Status}}", "example-container", {
      ignoreError: true,
    });

    expect(runCaptureMock.mock.calls).toEqual([
      [["docker", "info", "--format", "{{.KernelVersion}}"], { ignoreError: true }],
      [
        [
          "docker",
          "inspect",
          "--type",
          "container",
          "--format",
          "{{.State.Status}}",
          "example-container",
        ],
        { ignoreError: true },
      ],
    ]);
  });

  it("filters docker volume names by exact prefix", () => {
    runCaptureMock.mockReturnValue(
      [
        "openshell-cluster-nemoclaw",
        "openshell-cluster-nemoclaw-cache",
        "openshell-cluster-nemoclaw-2",
        "not-a-match",
        "",
      ].join("\n"),
    );

    const names = dockerListVolumesByPrefix("openshell-cluster-nemoclaw");

    expect(names).toEqual([
      "openshell-cluster-nemoclaw",
      "openshell-cluster-nemoclaw-cache",
      "openshell-cluster-nemoclaw-2",
    ]);
  });

  it("removes only volumes returned by the prefix probe", () => {
    runCaptureMock.mockReturnValue("openshell-cluster-nemoclaw\nopenshell-cluster-nemoclaw-cache\n");

    const removed = dockerRemoveVolumesByPrefix("  openshell-cluster-nemoclaw  ", {
      ignoreError: true,
    });

    expect(removed).toEqual([
      "openshell-cluster-nemoclaw",
      "openshell-cluster-nemoclaw-cache",
    ]);
    expect(runMock).toHaveBeenCalledWith(
      [
        "docker",
        "volume",
        "rm",
        "openshell-cluster-nemoclaw",
        "openshell-cluster-nemoclaw-cache",
      ],
      { ignoreError: true },
    );
  });

  it("rejects empty volume prefixes", () => {
    expect(() => dockerListVolumesByPrefix("   ")).toThrow(/prefix must be a non-empty string/);
    expect(() => dockerRemoveVolumesByPrefix("\t")).toThrow(/prefix must be a non-empty string/);
  });

  it("treats failed volume probes as empty when ignoreError is set", () => {
    runCaptureMock.mockImplementation(() => {
      throw new Error("docker unavailable");
    });

    expect(dockerRemoveVolumesByPrefix("openshell-cluster-nemoclaw", { ignoreError: true })).toEqual(
      [],
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it("skips volume removal when the probe finds no matches", () => {
    runCaptureMock.mockReturnValue("");

    const removed = dockerRemoveVolumesByPrefix("openshell-cluster-nemoclaw");

    expect(removed).toEqual([]);
    expect(runMock).not.toHaveBeenCalled();
  });
});
