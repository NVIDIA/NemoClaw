// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSandbox = vi.hoisted(() => vi.fn());
const dockerCapture = vi.hoisted(() => vi.fn());
const dockerExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("../../state/registry", () => ({
  getSandbox,
}));

vi.mock("../docker/run", () => ({
  dockerCapture,
}));

vi.mock("../docker/exec", () => ({
  dockerExecFileSync,
}));

import {
  K3S_CONTAINER,
  kubectlExecArgv,
  privilegedSandboxExec,
  privilegedSandboxExecArgv,
  selectDockerDriverSandboxContainer,
} from "./privileged-exec";

describe("selectDockerDriverSandboxContainer", () => {
  it("returns the exact docker-driver sandbox container when present", () => {
    expect(
      selectDockerDriverSandboxContainer("demo", "docker", "openshell-demo\nopenshell-other"),
    ).toBe("openshell-demo");
  });

  it("falls back to a prefix match", () => {
    expect(
      selectDockerDriverSandboxContainer("demo", "docker", "openshell-other\nopenshell-demo-abc"),
    ).toBe("openshell-demo-abc");
  });

  it("prefers an exact match over a prefix match even when the prefix appears first", () => {
    expect(
      selectDockerDriverSandboxContainer(
        "demo",
        "docker",
        "openshell-demo-abc\nopenshell-demo\nopenshell-demo-xyz",
      ),
    ).toBe("openshell-demo");
  });

  it("returns null for the legacy kubernetes driver", () => {
    expect(
      selectDockerDriverSandboxContainer("demo", "kubernetes", "openshell-demo\n"),
    ).toBeNull();
  });

  it("returns null when no container matches", () => {
    expect(selectDockerDriverSandboxContainer("demo", "docker", "openshell-other\n")).toBeNull();
  });
});

describe("kubectlExecArgv", () => {
  it("builds a kubectl exec via the K3s container", () => {
    expect(kubectlExecArgv("alpha", ["whoami"])).toEqual([
      "exec",
      K3S_CONTAINER,
      "kubectl",
      "exec",
      "-n",
      "openshell",
      "alpha",
      "-c",
      "agent",
      "--",
      "whoami",
    ]);
  });

  it("wraps non-root users with runuser", () => {
    expect(kubectlExecArgv("alpha", ["whoami"], { user: "linuxbrew" })).toEqual([
      "exec",
      K3S_CONTAINER,
      "kubectl",
      "exec",
      "-n",
      "openshell",
      "alpha",
      "-c",
      "agent",
      "--",
      "runuser",
      "-u",
      "linuxbrew",
      "--",
      "whoami",
    ]);
  });

  it("threads -i for stdin", () => {
    const argv = kubectlExecArgv("alpha", ["bash", "-s"], { stdin: true });
    expect(argv.filter((s) => s === "-i")).toHaveLength(2);
  });
});

describe("privilegedSandboxExecArgv", () => {
  beforeEach(() => {
    getSandbox.mockReset();
    dockerCapture.mockReset();
  });

  it("uses docker exec --user when the driver is docker", () => {
    getSandbox.mockReturnValue({ openshellDriver: "docker" });
    dockerCapture.mockReturnValue("openshell-alpha\n");
    expect(privilegedSandboxExecArgv("alpha", ["whoami"])).toEqual([
      "exec",
      "--user",
      "root",
      "openshell-alpha",
      "whoami",
    ]);
  });

  it("falls back to kubectl exec when no docker-driver container resolves", () => {
    getSandbox.mockReturnValue({ openshellDriver: "kubernetes" });
    const argv = privilegedSandboxExecArgv("alpha", ["whoami"]);
    expect(argv[0]).toBe("exec");
    expect(argv).toContain(K3S_CONTAINER);
    expect(argv).toContain("kubectl");
  });

  it("threads user through the docker --user flag", () => {
    getSandbox.mockReturnValue({ openshellDriver: "docker" });
    dockerCapture.mockReturnValue("openshell-alpha\n");
    expect(
      privilegedSandboxExecArgv("alpha", ["brew", "install", "hello"], { user: "linuxbrew" }),
    ).toEqual([
      "exec",
      "--user",
      "linuxbrew",
      "openshell-alpha",
      "brew",
      "install",
      "hello",
    ]);
  });
});

describe("privilegedSandboxExec", () => {
  beforeEach(() => {
    getSandbox.mockReset();
    dockerCapture.mockReset();
    dockerExecFileSync.mockReset();
  });

  it("forwards input as stdin and returns the captured output", () => {
    getSandbox.mockReturnValue({ openshellDriver: "docker" });
    dockerCapture.mockReturnValue("openshell-alpha\n");
    dockerExecFileSync.mockReturnValue("ok\n");
    const out = privilegedSandboxExec("alpha", ["bash", "-s"], { input: "echo ok" });
    expect(out).toBe("ok\n");
    const [argv, opts] = dockerExecFileSync.mock.calls[0] ?? [];
    expect(argv).toContain("-i");
    expect((opts as { input?: string }).input).toBe("echo ok");
  });
});
