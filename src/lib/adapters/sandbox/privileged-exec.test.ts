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
  OPENSHELL_SANDBOX_NAME_LABEL,
  kubectlExecArgv,
  privilegedSandboxExec,
  privilegedSandboxExecArgv,
  resolveDockerDriverSandboxContainer,
  selectDockerDriverSandboxContainer,
  selectLabelledSandboxContainer,
} from "./privileged-exec";

describe("selectDockerDriverSandboxContainer", () => {
  it("returns the exact docker-driver sandbox container when present", () => {
    expect(
      selectDockerDriverSandboxContainer("demo", "docker", "openshell-demo\nopenshell-other"),
    ).toBe("openshell-demo");
  });

  it("does not return a prefix-matching container — that would risk cross-sandbox routing", () => {
    expect(
      selectDockerDriverSandboxContainer("demo", "docker", "openshell-other\nopenshell-demo-abc"),
    ).toBeNull();
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

describe("selectLabelledSandboxContainer", () => {
  it("returns the canonical container when present", () => {
    expect(
      selectLabelledSandboxContainer("demo", "openshell-demo-sbx-abc\nopenshell-demo"),
    ).toBe("openshell-demo");
  });

  it("falls back to the first labelled container when canonical name is absent", () => {
    expect(selectLabelledSandboxContainer("demo", "openshell-demo-sbx-abc")).toBe(
      "openshell-demo-sbx-abc",
    );
  });

  it("returns null when no containers are labelled", () => {
    expect(selectLabelledSandboxContainer("demo", "")).toBeNull();
  });
});

describe("resolveDockerDriverSandboxContainer", () => {
  beforeEach(() => {
    getSandbox.mockReset();
    dockerCapture.mockReset();
  });

  it("queries by label first and returns the labelled match", () => {
    getSandbox.mockReturnValue({ openshellDriver: "docker" });
    dockerCapture.mockImplementation((args: readonly string[]) => {
      if (args.includes("--filter")) return "openshell-demo-sbx-abc\n";
      return "";
    });
    expect(resolveDockerDriverSandboxContainer("demo")).toBe("openshell-demo-sbx-abc");
    const labelCall = dockerCapture.mock.calls.find((args) =>
      (args[0] as readonly string[]).includes("--filter"),
    );
    expect(labelCall?.[0]).toContain(`label=${OPENSHELL_SANDBOX_NAME_LABEL}=demo`);
  });

  it("falls back to an exact name match for pre-label sandboxes", () => {
    getSandbox.mockReturnValue({ openshellDriver: "docker" });
    dockerCapture.mockImplementation((args: readonly string[]) => {
      if (args.includes("--filter")) return "";
      return "openshell-other\nopenshell-demo\n";
    });
    expect(resolveDockerDriverSandboxContainer("demo")).toBe("openshell-demo");
  });

  it("does NOT misroute sandbox `demo` to sandbox `demo-prod`'s suffixed container", () => {
    getSandbox.mockReturnValue({ openshellDriver: "docker" });
    dockerCapture.mockImplementation((args: readonly string[]) => {
      if (args.includes("--filter")) return "";
      return "openshell-demo-prod-sbx-abc\n";
    });
    expect(resolveDockerDriverSandboxContainer("demo")).toBeNull();
  });

  it("returns null for non-docker drivers without calling docker ps", () => {
    getSandbox.mockReturnValue({ openshellDriver: "kubernetes" });
    expect(resolveDockerDriverSandboxContainer("demo")).toBeNull();
    expect(dockerCapture).not.toHaveBeenCalled();
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

  it("runs as the container's USER (root) when the driver is docker", () => {
    getSandbox.mockReturnValue({ openshellDriver: "docker" });
    dockerCapture.mockReturnValue("openshell-alpha\n");
    expect(privilegedSandboxExecArgv("alpha", ["whoami"])).toEqual([
      "exec",
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

  it("wraps non-root users with runuser so HOME is set to the target user's home", () => {
    getSandbox.mockReturnValue({ openshellDriver: "docker" });
    dockerCapture.mockReturnValue("openshell-alpha\n");
    expect(
      privilegedSandboxExecArgv("alpha", ["brew", "install", "hello"], { user: "linuxbrew" }),
    ).toEqual([
      "exec",
      "openshell-alpha",
      "runuser",
      "-u",
      "linuxbrew",
      "--",
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
