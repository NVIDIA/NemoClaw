// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerGpuModeCandidates,
  type DockerContainerInspect,
  type DockerGpuPatchDeps,
  recreateOpenShellDockerSandboxWithGpu,
  selectDockerGpuPatchMode,
} from "../../../dist/lib/onboard/docker-gpu-patch";

// Deps that surface an NVIDIA CDI spec at /etc/cdi/nvidia.yaml so
// `dockerReportsNvidiaCdiDevices` reports CDI as available (the #4948 host
// shape). Probe behavior is supplied per-test via `dockerRun`.
function cdiHostDeps(): DockerGpuPatchDeps {
  return {
    dockerCapture: vi.fn(() => JSON.stringify(["/etc/cdi"])),
    readDir: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : null),
    readFile: (file: string) =>
      file === "/etc/cdi/nvidia.yaml"
        ? "cdiVersion: 0.6.0\nkind: nvidia.com/gpu\ndevices:\n  - name: all\n"
        : null,
    dockerRm: vi.fn(() => ({ status: 0 })),
  };
}

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
    },
    HostConfig: { NetworkMode: "openshell-docker" },
  };
}

describe("docker-gpu-patch CDI-first mode selection (#4948)", () => {
  it("prefers CDI over --gpus when the host advertises an NVIDIA CDI spec", () => {
    // Repro for #4948: on a Docker-CDI GPU host (e.g. Ubuntu 24.04 with
    // /etc/cdi/nvidia.yaml), `docker create --gpus all` is *accepted* so the
    // create-only probe passes and `--gpus all` was selected. OpenShell's
    // gateway injects GPUs via the CDI spec, so the legacy --gpus injection
    // path diverges from how the supervisor expects the container to be wired
    // and never reconnects. When a CDI spec is present we must select the CDI
    // mode (`--device nvidia.com/gpu=all`) ahead of --gpus.
    expect(buildDockerGpuModeCandidates("all", { cdiAvailable: true }).map((m) => m.kind)).toEqual([
      "cdi",
      "gpus",
      "nvidia-runtime",
    ]);

    // Every probe (including --gpus) would succeed on this host, yet CDI wins.
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id" }));
    const selected = selectDockerGpuPatchMode(
      { image: "openshell/sandbox:abc" },
      { ...cdiHostDeps(), dockerRun },
    );

    expect(selected.mode?.kind).toBe("cdi");
    expect(selected.attempts[0].mode.kind).toBe("cdi");
  });

  it("falls back to --gpus when the CDI probe fails on a CDI host", () => {
    // CDI is preferred first, but if `docker create --device nvidia.com/gpu=all`
    // is rejected the selection must continue down the fallback chain rather
    // than leaving the host with no usable GPU mode.
    const dockerRun = vi.fn((args: readonly string[]) =>
      args.includes("--device")
        ? { status: 1, stderr: "could not select device driver" }
        : { status: 0, stdout: "probe-id" },
    );
    const selected = selectDockerGpuPatchMode(
      { image: "openshell/sandbox:abc" },
      { ...cdiHostDeps(), dockerRun },
    );

    expect(selected.mode?.kind).toBe("gpus");
    expect(selected.attempts.map((attempt) => attempt.mode.kind)).toEqual(["cdi", "gpus"]);
    expect(selected.attempts[0].ok).toBe(false);
  });

  it("falls back to the NVIDIA runtime when both CDI and --gpus probes fail", () => {
    const dockerRun = vi.fn((args: readonly string[]) =>
      args.includes("--device") || args.includes("--gpus")
        ? { status: 1, stderr: "probe rejected" }
        : { status: 0, stdout: "probe-id" },
    );
    const selected = selectDockerGpuPatchMode(
      { image: "openshell/sandbox:abc" },
      { ...cdiHostDeps(), dockerRun },
    );

    expect(selected.mode?.kind).toBe("nvidia-runtime");
    expect(selected.attempts.map((attempt) => attempt.mode.kind)).toEqual([
      "cdi",
      "gpus",
      "nvidia-runtime",
    ]);
  });

  it("passes the CDI --device flag to docker run when recreating on a CDI host", () => {
    // Proves the selected CDI mode propagates into the actual recreate command
    // (`dockerRunDetached`), not just the selection result. This is the create
    // option that the issue's product log surfaces as `patched_create_option`.
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return JSON.stringify(["/etc/cdi"]);
      return "";
    });
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const host = cdiHostDeps();

    const result = recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1 },
      {
        dockerCapture,
        readDir: host.readDir,
        readFile: host.readFile,
        dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-05-12T00:00:00Z"),
      },
    );

    expect(result.mode.kind).toBe("cdi");
    expect(dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining(["--name", "openshell-alpha", "--device", "nvidia.com/gpu=all"]),
      expect.objectContaining({ ignoreError: true }),
    );
    // The legacy --gpus flag must NOT appear on a CDI host recreate.
    const detachedArgs = (dockerRunDetached.mock.calls[0] as unknown[])[0] as string[];
    expect(detachedArgs).not.toContain("--gpus");
  });
});
