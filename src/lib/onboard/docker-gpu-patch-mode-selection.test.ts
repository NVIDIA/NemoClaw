// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerGpuMode,
  buildDockerGpuModeCandidates,
  type DockerContainerInspect,
  type DockerGpuPatchDeps,
  dockerReportsNvidiaCdiDevices,
  recreateOpenShellDockerSandboxWithGpu,
  selectDockerGpuPatchMode,
} from "./docker-gpu-patch";

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
  it("maps default and explicit GPU devices to Docker --gpus values", () => {
    expect(buildDockerGpuMode("gpus").args).toEqual(["--gpus", "all"]);
    expect(buildDockerGpuMode("gpus", "nvidia.com/gpu=0").args).toEqual(["--gpus", "device=0"]);
    expect(buildDockerGpuMode("gpus", "1,2").args).toEqual(["--gpus", "device=1,2"]);
  });

  it("uses Jetson NVIDIA runtime args without selecting generic --gpus or CDI candidates", () => {
    expect(buildDockerGpuMode("nvidia-runtime", null, { backend: "jetson" }).args).toEqual([
      "--runtime",
      "nvidia",
      "--env",
      "NVIDIA_VISIBLE_DEVICES=all",
      "--env",
      "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
    ]);
    expect(
      buildDockerGpuModeCandidates("all", { backend: "jetson", cdiAvailable: true }).map(
        (mode) => mode.kind,
      ),
    ).toEqual(["nvidia-runtime"]);
  });

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

  it("does not accept a GPU mode probe with no exit status", () => {
    const selected = selectDockerGpuPatchMode(
      { image: "openshell/sandbox:abc" },
      {
        dockerCapture: vi.fn(() => ""),
        dockerRun: vi.fn(() => ({ status: null, error: new Error("spawn timed out") })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        readDir: vi.fn(() => null),
        readFile: vi.fn(() => null),
      },
    );

    expect(selected.mode).toBeNull();
    expect(selected.attempts).toHaveLength(2);
    expect(selected.attempts.map((attempt) => attempt.error)).toEqual([
      "spawn timed out",
      "spawn timed out",
    ]);
  });

  it("falls back to NVIDIA runtime when Docker rejects --gpus", () => {
    const dockerRun = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "could not select device driver" })
      .mockReturnValueOnce({ status: 0, stdout: "probe-id" });
    const selected = selectDockerGpuPatchMode(
      { image: "openshell/sandbox:abc" },
      {
        dockerCapture: vi.fn(() => ""),
        dockerRun,
        dockerRm: vi.fn(() => ({ status: 0 })),
        readDir: vi.fn(() => null),
        readFile: vi.fn(() => null),
      },
    );

    expect(selected.mode?.kind).toBe("nvidia-runtime");
    expect(selected.attempts.map((attempt) => attempt.mode.kind)).toEqual([
      "gpus",
      "nvidia-runtime",
    ]);
  });

  it("probes only NVIDIA runtime for Jetson Docker GPU mode", () => {
    const dockerCapture = vi.fn(() => "");
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id" }));
    const selected = selectDockerGpuPatchMode(
      { image: "openshell/sandbox:abc", backend: "jetson" },
      { dockerCapture, dockerRun, dockerRm: vi.fn(() => ({ status: 0 })) },
    );

    expect(selected.mode?.kind).toBe("nvidia-runtime");
    expect(selected.attempts.map((attempt) => attempt.mode.kind)).toEqual(["nvidia-runtime"]);
    expect(dockerRun).toHaveBeenCalledWith(
      expect.arrayContaining([
        "create",
        "--runtime",
        "nvidia",
        "--env",
        "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
      ]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerCapture).not.toHaveBeenCalled();
  });

  it("prefers CDI only when Docker reports readable NVIDIA CDI specs", () => {
    expect(buildDockerGpuModeCandidates("all", { cdiAvailable: false }).map((m) => m.kind)).toEqual(
      ["gpus", "nvidia-runtime"],
    );
    expect(buildDockerGpuModeCandidates("all", { cdiAvailable: true }).map((m) => m.kind)).toEqual([
      "cdi",
      "gpus",
      "nvidia-runtime",
    ]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-cdi-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "nvidia.yaml"),
        "cdiVersion: 0.6.0\nkind: nvidia.com/gpu\ndevices:\n  - name: all\n",
      );
      expect(
        dockerReportsNvidiaCdiDevices({
          dockerCapture: vi.fn(() => JSON.stringify([tmpDir])),
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects NVIDIA CDI specs in /etc/cdi when docker info reports no dirs (#3575)", () => {
    const readDir = vi.fn((dirPath: string) => (dirPath === "/etc/cdi" ? ["nvidia.yaml"] : null));
    const readFile = vi.fn((filePath: string) =>
      filePath === "/etc/cdi/nvidia.yaml"
        ? "cdiVersion: 0.6.0\nkind: nvidia.com/gpu\ndevices:\n  - name: all\n"
        : null,
    );
    expect(
      dockerReportsNvidiaCdiDevices({
        dockerCapture: vi.fn(() => ""),
        readDir,
        readFile,
      }),
    ).toBe(true);
    expect(readDir).toHaveBeenCalledWith("/etc/cdi");
  });

  it("returns false when default CDI dirs hold no NVIDIA specs", () => {
    expect(
      dockerReportsNvidiaCdiDevices({
        dockerCapture: vi.fn(() => ""),
        readDir: vi.fn(() => null),
        readFile: vi.fn(() => null),
      }),
    ).toBe(false);
  });

  it("falls back to default CDI dirs even when docker info errors", () => {
    const dockerCapture = vi.fn(() => {
      throw new Error("docker daemon unreachable");
    });
    const readDir = vi.fn((dirPath: string) =>
      dirPath === "/var/run/cdi" ? ["nvidia.json"] : null,
    );
    const readFile = vi.fn((filePath: string) =>
      filePath === "/var/run/cdi/nvidia.json"
        ? JSON.stringify({ cdiVersion: "0.6.0", kind: "nvidia.com/gpu" })
        : null,
    );
    expect(dockerReportsNvidiaCdiDevices({ dockerCapture, readDir, readFile })).toBe(true);
  });

  it("does not re-scan a directory that docker info already reported", () => {
    const readDir = vi.fn((dirPath: string) => (dirPath === "/etc/cdi" ? ["nvidia.yaml"] : null));
    const readFile = vi.fn(() => "cdiVersion: 0.6.0\nkind: nvidia.com/gpu\n");
    dockerReportsNvidiaCdiDevices({
      dockerCapture: vi.fn(() => JSON.stringify(["/etc/cdi"])),
      readDir,
      readFile,
    });
    expect(readDir.mock.calls.filter(([dir]) => dir === "/etc/cdi").length).toBe(1);
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
