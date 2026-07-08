// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuMode,
  type DockerContainerInspect,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch";
import {
  appendExtraPlaceholderKeysEnvArg,
  EXTRA_PLACEHOLDER_KEYS_ENV,
  parseExtraPlaceholderKeys,
} from "./extra-placeholder-keys";

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: [
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
        "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
      ],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
      User: "0",
    },
    HostConfig: {
      NetworkMode: "openshell-docker",
      RestartPolicy: { Name: "unless-stopped" },
    },
    NetworkSettings: { Networks: { "openshell-docker": {} } },
  };
}

describe("Docker GPU startup command validation (#6110)", () => {
  it.each([
    ["Docker --gpus", buildDockerGpuMode("gpus")],
    ["native CDI", buildDockerGpuMode("cdi")],
    ["Jetson runtime", buildDockerGpuMode("nvidia-runtime", null, { backend: "jetson" })],
  ])("preserves the OpenShell supervisor boundary for %s", (_label, mode) => {
    const extraPlaceholderKeys = ["TELEGRAM_BOT_TOKEN_AGENT_A", "SLACK_BOT_TOKEN_AGENT_B"];
    const extraPlaceholderEnv: string[] = [];
    appendExtraPlaceholderKeysEnvArg(
      extraPlaceholderEnv,
      extraPlaceholderKeys,
      (key, value) => `${key}=${value}`,
    );
    const sandboxCommand = [
      "env",
      "CHAT_UI_URL=http://127.0.0.1:8642",
      "NEMOCLAW_DASHBOARD_PORT=8642",
      "HTTP_PROXY=http://proxy.example:8080",
      ...extraPlaceholderEnv,
      "nemoclaw-start",
    ];

    const args = buildDockerGpuCloneRunArgs(inspectFixture(), mode, {
      openshellSandboxCommand: sandboxCommand,
    });

    expect(args).toEqual(
      expect.arrayContaining(["--env", `OPENSHELL_SANDBOX_COMMAND=${sandboxCommand.join(" ")}`]),
    );
    expect(args).not.toEqual(
      expect.arrayContaining(["--env", "OPENSHELL_SANDBOX_COMMAND=sleep infinity"]),
    );
    expect(args).toEqual(expect.arrayContaining(mode.args));
    expect(args.slice(args.indexOf("openshell/sandbox:abc"))).toEqual(["openshell/sandbox:abc"]);

    const serializedCommand = args.find((arg) => arg.startsWith("OPENSHELL_SANDBOX_COMMAND="));
    const commandTokens = serializedCommand
      ?.slice("OPENSHELL_SANDBOX_COMMAND=".length)
      .split(/[\s\u0085]+/u);
    const assignment = commandTokens?.find((token) =>
      token.startsWith(`${EXTRA_PLACEHOLDER_KEYS_ENV}=`),
    );
    expect(assignment).toBe(extraPlaceholderEnv[0]);
    expect(
      parseExtraPlaceholderKeys(
        assignment?.slice(EXTRA_PLACEHOLDER_KEYS_ENV.length + 1),
        new Set(["TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN"]),
      ),
    ).toEqual({ keys: extraPlaceholderKeys, warnings: [] });
  });

  it.each([
    ["an empty token", ""],
    ["ASCII whitespace", "HTTP_PROXY=http://proxy.example/path with space"],
    ["U+0085 NEXT LINE", "HTTP_PROXY=http://proxy.example/path\u0085next-line"],
  ])("rejects %s before touching the original container", (_label, invalidToken) => {
    const dockerCapture = vi.fn((args: readonly string[]) =>
      args[0] === "ps"
        ? "old-container-id\n"
        : args[0] === "inspect"
          ? JSON.stringify([inspectFixture()])
          : "",
    );
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        {
          sandboxName: "alpha",
          timeoutSecs: 1,
          openshellSandboxCommand: ["env", invalidToken, "nemoclaw-start"],
        },
        {
          dockerCapture,
          detectSandboxFallbackDns: vi.fn(() => null),
          dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
          dockerRunDetached,
          dockerRename,
          dockerRm: vi.fn(() => ({ status: 0 })),
          dockerStop,
          readDir: vi.fn(() => null),
          readFile: vi.fn(() => null),
        },
      ),
    ).toThrow("OpenShell sandbox startup command tokens cannot be empty or contain whitespace");
    expect(dockerStop).not.toHaveBeenCalled();
    expect(dockerRename).not.toHaveBeenCalled();
    expect(dockerRunDetached).not.toHaveBeenCalled();
  });
});
