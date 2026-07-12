// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createDockerGpuInspectFixture as inspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuCloneRunOptions,
  buildDockerGpuMode,
  getDockerGpuPatchNetworkMode,
} from "./docker-gpu-patch";

describe("Docker GPU clone envelope", () => {
  it("builds clone args that preserve OpenShell labels and runtime settings", () => {
    const args = buildDockerGpuCloneRunArgs(inspectFixture(), buildDockerGpuMode("gpus"));

    expect(args).toEqual(
      expect.arrayContaining([
        "--name",
        "openshell-alpha",
        "--gpus",
        "all",
        "--env",
        "A=1",
        "--env",
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
        "--env",
        "OPENSHELL_TEST=1",
        "--label",
        "openshell.ai/managed-by=openshell",
        "--label",
        "openshell.ai/sandbox-name=alpha",
        "--volume",
        "/host:/container:rw",
        "--network",
        "openshell-docker",
        "--network-alias",
        "openshell-alpha",
        "--restart",
        "unless-stopped",
        "--cap-add",
        "SYS_ADMIN",
        "--security-opt",
        "apparmor=unconfined",
        "--add-host",
        "host.openshell.internal:172.17.0.1",
        "--memory",
        String(8 * 1024 * 1024 * 1024),
        "--cpus",
        "2.5",
        "--entrypoint",
        "/opt/openshell/bin/openshell-sandbox",
        "openshell/sandbox:abc",
      ]),
    );
    expect(args).not.toEqual(expect.arrayContaining(["--env", "NVIDIA_VISIBLE_DEVICES=void"]));
  });

  it("adds OpenShell's sandbox command env when the inspected container lacks one", () => {
    const inspect = inspectFixture();
    inspect.Config!.Env = inspect.Config!.Env!.filter(
      (entry) => !entry.startsWith("OPENSHELL_SANDBOX_COMMAND="),
    );
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      openshellSandboxCommand: ["env", "CHAT_UI_URL=http://127.0.0.1:8642", "nemoclaw-start"],
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=env CHAT_UI_URL=http://127.0.0.1:8642 nemoclaw-start",
      ]),
    );
  });

  it("adds SYS_PTRACE to the GPU clone when the baseline container lacks it", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.CapAdd = ["SYS_ADMIN", "NET_ADMIN"];
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args).toEqual(expect.arrayContaining(["--cap-add", "SYS_PTRACE"]));
    expect(args).toEqual(expect.arrayContaining(["--cap-add", "SYS_ADMIN"]));
    expect(args).toEqual(expect.arrayContaining(["--cap-add", "NET_ADMIN"]));
  });

  it("does not duplicate SYS_PTRACE when the baseline container already has it", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.CapAdd = ["SYS_ADMIN", "SYS_PTRACE"];
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args.filter((arg) => arg === "SYS_PTRACE").length).toBe(1);
  });

  it("injects apparmor=unconfined when the baseline container has no apparmor profile", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.SecurityOpt = [];
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args).toEqual(expect.arrayContaining(["--security-opt", "apparmor=unconfined"]));
  });

  it("respects a baseline-pinned apparmor profile instead of overriding it", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.SecurityOpt = ["apparmor=docker-default", "no-new-privileges"];
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args).toEqual(expect.arrayContaining(["--security-opt", "apparmor=docker-default"]));
    expect(args).toEqual(expect.arrayContaining(["--security-opt", "no-new-privileges"]));
    expect(args).not.toEqual(expect.arrayContaining(["--security-opt", "apparmor=unconfined"]));
  });

  it("can switch the recreated sandbox to host networking for OpenShell callbacks", () => {
    const inspect = inspectFixture();
    const options = buildDockerGpuCloneRunOptions(inspect, {
      NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
    });
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), options);

    expect(options).toEqual({
      networkMode: "host",
      openshellEndpoint: "http://127.0.0.1:8080/",
    });
    expect(args).toEqual(expect.arrayContaining(["--network", "host"]));
    expect(args).toEqual(
      expect.arrayContaining(["--env", "OPENSHELL_ENDPOINT=http://127.0.0.1:8080/"]),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--add-host", "host.openshell.internal:172.17.0.1"]),
    );
    expect(args).not.toEqual(expect.arrayContaining(["--network-alias", "openshell-alpha"]));
    expect(
      buildDockerGpuCloneRunOptions(inspect, {
        NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "preserve",
      }),
    ).toEqual({});
  });

  it.each([
    { name: "missing", endpoint: null },
    { name: "unrewritable", endpoint: "http://gateway.example.test:8080/" },
  ])("fails closed when host networking is requested with a $name OpenShell endpoint (#6110)", ({
    endpoint,
  }) => {
    const inspect = inspectFixture();
    inspect.Config!.Env = [
      ...inspect.Config!.Env!.filter((entry) => !entry.startsWith("OPENSHELL_ENDPOINT=")),
      ...(endpoint === null ? [] : [`OPENSHELL_ENDPOINT=${endpoint}`]),
    ];

    expect(() =>
      buildDockerGpuCloneRunOptions(inspect, {
        NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
      }),
    ).toThrow(/NEMOCLAW_DOCKER_GPU_PATCH_NETWORK=host requires .*OPENSHELL_ENDPOINT/i);
  });

  it("reports the Docker GPU patch network mode", () => {
    expect(getDockerGpuPatchNetworkMode({})).toBe("preserve");
    expect(getDockerGpuPatchNetworkMode({ NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host" })).toBe(
      "host",
    );
    expect(getDockerGpuPatchNetworkMode({ NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "preserve" })).toBe(
      "preserve",
    );
    expect(getDockerGpuPatchNetworkMode({ NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "bridge" })).toBe(
      "preserve",
    );
    expect(getDockerGpuPatchNetworkMode({ NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "bogus" })).toBe(
      "preserve",
    );
  });
});
