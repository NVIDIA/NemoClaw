// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import { translatePodmanLocalInferenceArgs } from "./podman-inference-args";
import { qualifyPodmanInferenceAuthority } from "./podman-preflight";

const IMAGE = `nvcr.io/nvidia/inference@sha256:${"a".repeat(64)}`;
const PROBE_IMAGE = `registry.example/probe@sha256:${"b".repeat(64)}`;
const CDI_DEVICES = [
  "nvidia.com/gpu=all",
  "nvidia.com/gpu=0",
  "nvidia.com/gpu=1",
  "nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
] as const;

function authority(devices: readonly string[] = CDI_DEVICES) {
  const info = JSON.stringify({
    host: {
      arch: "amd64",
      os: "linux",
      cgroupVersion: "v2",
      security: { rootless: true },
      discoveredDevices: devices.map((id) => ({ source: "cdi", id })),
    },
  });
  const engine: ContainerEngine = {
    operation: "host-local-inference",
    engineId: "podman",
    displayName: "Podman",
    authorityId: "test:podman-socket",
    capture: vi.fn((args: readonly string[]) =>
      args[0] === "version"
        ? {
            status: 0,
            stdout: JSON.stringify({ Server: { Version: "6.0.0" } }),
            stderr: "",
          }
        : { status: 0, stdout: info, stderr: "" },
    ),
    captureHost: vi.fn(),
  };
  return qualifyPodmanInferenceAuthority(engine);
}

describe("Podman local inference command translation", () => {
  it.each([
    ["Docker GPU selector", ["--gpus", "all"]],
    ["NVIDIA CDI device", ["--device", "nvidia.com/gpu=all"]],
  ] as const)(
    "rejects %s under CPU operation authority even when NVIDIA CDI exists",
    (_label, gpuArgs) => {
      expect(() =>
        translatePodmanLocalInferenceArgs(["run", ...gpuArgs, IMAGE], authority(), {
          acceleration: "cpu",
        }),
      ).toThrow("CPU authority forbids GPU attachment");
    },
  );

  it("translates the current NIM run shape to exact CDI", () => {
    expect(
      translatePodmanLocalInferenceArgs(
        [
          "run",
          "--detach",
          "--pull=never",
          "--gpus",
          "all",
          "-p",
          "127.0.0.1:8000:8000",
          "--name",
          "nemoclaw-nim",
          "--shm-size",
          "16g",
          "-e",
          "NGC_API_KEY",
          "-e",
          "NIM_NGC_API_KEY",
          IMAGE,
        ],
        authority(),
      ),
    ).toEqual([
      "run",
      "--http-proxy=false",
      "--detach",
      "--pull",
      "never",
      "--device",
      "nvidia.com/gpu=all",
      "--publish",
      "127.0.0.1:8000:8000",
      "--name",
      "nemoclaw-nim",
      "--shm-size",
      "16g",
      "--env",
      "NGC_API_KEY",
      "--env",
      "NIM_NGC_API_KEY",
      IMAGE,
    ]);
  });

  it("translates the current vLLM run shape without changing its command", () => {
    const command = [
      "-lc",
      "python -m vllm.entrypoints.openai.api_server --model nvidia/NVIDIA-Nemotron-3.5 --tokenizer-mode auto --max-num-batched-tokens 2048",
    ];
    expect(
      translatePodmanLocalInferenceArgs(
        [
          "run",
          "--detach",
          "--pull=never",
          "--init",
          "--restart",
          "unless-stopped",
          "--gpus",
          '"device=0,1"',
          "--ipc=private",
          "--label",
          "ai.nvidia.nemoclaw.inference.managed=true",
          "--env",
          "VLLM_API_KEY",
          "--publish",
          "127.0.0.1:8000:8000",
          "--name",
          "nemoclaw-vllm",
          "--entrypoint",
          "/bin/bash",
          IMAGE,
          ...command,
        ],
        authority(),
      ),
    ).toEqual([
      "run",
      "--http-proxy=false",
      "--detach",
      "--pull",
      "never",
      "--init",
      "--restart",
      "unless-stopped",
      "--device",
      "nvidia.com/gpu=0",
      "--device",
      "nvidia.com/gpu=1",
      "--ipc",
      "private",
      "--label",
      "ai.nvidia.nemoclaw.inference.managed=true",
      "--env",
      "VLLM_API_KEY",
      "--publish",
      "127.0.0.1:8000:8000",
      "--name",
      "nemoclaw-vllm",
      "--entrypoint",
      "/bin/bash",
      IMAGE,
      ...command,
    ]);
  });

  it("permits only the exact provider-owned inference label schema", () => {
    const hash = "c".repeat(64);
    const labels = [
      "ai.nvidia.nemoclaw.inference.managed=true",
      "ai.nvidia.nemoclaw.inference.provider=podman",
      "ai.nvidia.nemoclaw.inference.service=nim",
      `ai.nvidia.nemoclaw.inference.spec-sha256=${hash}`,
      `ai.nvidia.nemoclaw.inference.authority-sha256=${hash}`,
      `ai.nvidia.nemoclaw.inference.transaction-sha256=${hash}`,
      `ai.nvidia.nemoclaw.inference.receipt-target-sha256=${hash}`,
      "ai.nvidia.nemoclaw.inference.prior-state=stopped",
    ];
    const args = ["run"];
    labels.forEach((label) => {
      args.push("--label", label);
    });
    args.push(IMAGE);

    expect(translatePodmanLocalInferenceArgs(args, authority())).toEqual([
      "run",
      "--http-proxy=false",
      ...args.slice(1),
    ]);
  });

  it("keeps the Podman proxy boolean attached so false cannot become the image", () => {
    const translated = translatePodmanLocalInferenceArgs(["run", IMAGE], authority());

    expect(translated).toEqual(["run", "--http-proxy=false", IMAGE]);
    expect(translated.slice(1, translated.indexOf(IMAGE))).not.toContain("false");
  });

  it("rejects auto-removal that would erase exact cleanup evidence", () => {
    expect(() =>
      translatePodmanLocalInferenceArgs(["run", "--rm", PROBE_IMAGE], authority()),
    ).toThrow("does not support Docker argument '--rm'");
  });

  it.each([
    {
      label: "unknown Docker option",
      args: ["run", "--privileged", IMAGE],
      message: "does not support Docker argument '--privileged'",
    },
    {
      label: "Docker runtime selection",
      args: ["run", "--runtime", "nvidia", IMAGE],
      message: "refuses Docker runtime selection",
    },
    {
      label: "raw device",
      args: ["run", "--device", "/dev/nvidia0", IMAGE],
      message: "refuses raw or unsupported device",
    },
    {
      label: "inline secret",
      args: ["run", "--env", "NGC_API_KEY=secret", IMAGE],
      message: "must name a variable without its value",
    },
    {
      label: "mutable image",
      args: ["run", "--gpus", "all", "nvcr.io/nvidia/inference:latest"],
      message: "does not support Docker argument",
    },
    {
      label: "host bind volume",
      args: ["run", "--volume", "/run/docker.sock:/run/docker.sock:rw", IMAGE],
      message: "does not support Docker argument '--volume'",
    },
    {
      label: "rootless Podman socket mount",
      args: ["run", "--volume", "/run/user/1000/podman/podman.sock:/runtime/engine.sock:rw", IMAGE],
      message: "does not support Docker argument '--volume'",
    },
    {
      label: "engine socket mount target",
      args: [
        "run",
        "--mount",
        "target=/run/podman/podman.sock,type=bind,source=/safe/source,readonly",
        IMAGE,
      ],
      message: "does not support Docker argument '--mount'",
    },
    {
      label: "mount traversal alias",
      args: ["run", "--volume", "/safe/../run/docker.sock:/models:ro", IMAGE],
      message: "does not support Docker argument '--volume'",
    },
    {
      label: "all-interface two-field publishing",
      args: ["run", "--publish", "8000:8000", IMAGE],
      message: "publish mapping is invalid",
    },
    {
      label: "explicit IPv4 wildcard publishing",
      args: ["run", "--publish", "0.0.0.0:8000:8000", IMAGE],
      message: "lacks exact listener authority",
    },
    {
      label: "IPv6 wildcard publishing",
      args: ["run", "--publish", "[::]:8000:8000", IMAGE],
      message: "publish mapping is invalid",
    },
    {
      label: "non-loopback publishing",
      args: ["run", "--publish", "192.0.2.2:8000:8000", IMAGE],
      message: "lacks exact listener authority",
    },
    {
      label: "non-owned label",
      args: ["run", "--label", "com.example.owner=true", IMAGE],
      message: "permits only exact NemoClaw inference labels",
    },
    {
      label: "invalid owned label value",
      args: ["run", "--label", "ai.nvidia.nemoclaw.inference.provider=docker", IMAGE],
      message: "permits only exact NemoClaw inference labels",
    },
    {
      label: "unsupported network mode",
      args: ["run", "--network", "host", IMAGE],
      message: "network mode is unsupported",
    },
    {
      label: "host IPC namespace",
      args: ["run", "--ipc=host", IMAGE],
      message: "requires a private IPC namespace",
    },
    {
      label: "container proxy inheritance",
      args: ["run", "--http-proxy=true", IMAGE],
      message: "option --http-proxy is duplicated",
    },
    {
      label: "ambiguous positional argument",
      args: ["run", "unexpected", IMAGE],
      message: "does not support Docker argument 'unexpected'",
    },
  ])("rejects $label instead of passing it to Podman", ({ args, message }) => {
    expect(() => translatePodmanLocalInferenceArgs(args, authority())).toThrow(message);
  });

  it("rejects duplicate provider-owned label keys", () => {
    expect(() =>
      translatePodmanLocalInferenceArgs(
        [
          "run",
          "--label",
          "ai.nvidia.nemoclaw.inference.service=nim",
          "--label",
          "ai.nvidia.nemoclaw.inference.service=vllm",
          IMAGE,
        ],
        authority(),
      ),
    ).toThrow("label ai.nvidia.nemoclaw.inference.service is duplicated");
  });

  it.each([
    ["secret environment name", ["sh", "-c", "echo $VLLM_API_KEY"]],
    ["secret assignment", ["sh", "-c", "NGC_API_KEY=not-a-real-key exec server"]],
    ["credential flag", ["server", "--api-key=not-a-real-key"]],
    ["bearer authorization", ["curl", "-H", "Authorization: Bearer not-a-real-key"]],
    ["credential-shaped token", ["client", "hf_0123456789abcdef"]],
    ["JSON credential", ["client", '{"api_key":"not-a-real-key"}']],
  ])("rejects post-image %s", (_label, command) => {
    expect(() =>
      translatePodmanLocalInferenceArgs(["run", IMAGE, ...command], authority()),
    ).toThrow("command arguments must not carry credential material");
  });

  it("rejects duplicate and mixed GPU authority", () => {
    expect(() =>
      translatePodmanLocalInferenceArgs(
        ["run", "--gpus", "device=0", "--device", "nvidia.com/gpu=0", IMAGE],
        authority(),
      ),
    ).toThrow("duplicate NVIDIA CDI device");
    expect(() =>
      translatePodmanLocalInferenceArgs(
        ["run", "--gpus", "all", "--device", "nvidia.com/gpu=0", IMAGE],
        authority(),
      ),
    ).toThrow("cannot mix 'all' with exact devices");
  });

  it("rejects a CDI device that the exact endpoint did not advertise", () => {
    expect(() =>
      translatePodmanLocalInferenceArgs(
        ["run", "--device", "nvidia.com/gpu=9", IMAGE],
        authority(),
      ),
    ).toThrow("does not advertise");
  });

  it("rejects a mutated authority receipt before translating arguments", () => {
    const receipt = authority();
    expect(() =>
      translatePodmanLocalInferenceArgs(["run", IMAGE], {
        ...receipt,
        cdiDevices: ["nvidia.com/gpu=9"],
      }),
    ).toThrow("receipt digest does not match");
  });
});
