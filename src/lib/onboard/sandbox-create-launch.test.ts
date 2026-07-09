// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../sandbox/build-context";
import { createOpenshellCliHelpers } from "./openshell-cli";
import {
  prepareSandboxCreateLaunch,
  prepareSandboxCreateLaunchWithPrebuild,
} from "./sandbox-create-launch";

const disabledHermesDashboardState = { config: null, enabled: false };
const temporaryBuildContexts: string[] = [];

function createTrustedBuildContext(): string {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  temporaryBuildContexts.push(buildCtx);
  fs.writeFileSync(path.join(buildCtx, "Dockerfile"), "FROM scratch\n");
  return buildCtx;
}

afterEach(() => {
  for (const buildCtx of temporaryBuildContexts.splice(0)) {
    fs.rmSync(buildCtx, { recursive: true, force: true });
  }
});

describe("prepareSandboxCreateLaunch", () => {
  it("builds the sandbox create command and runtime env envelope", () => {
    const openshellShellCommand = vi.fn((args: string[]) => `openshell ${args.join(" ")}`);
    const result = prepareSandboxCreateLaunch({
      agent: { name: "openclaw", configPaths: { dir: "/sandbox/.custom-openclaw" } } as any,
      chatUiUrl: "http://127.0.0.1:19000/",
      createArgs: ["--from", "/tmp/build/Dockerfile", "--name", "demo"],
      env: {
        HTTP_PROXY: " http://proxy.example:8080 ",
        NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
        NEMOCLAW_PROXY_HOST: "host.docker.internal",
        NEMOCLAW_PROXY_PORT: "3129",
      },
      extraPlaceholderKeys: ["TELEGRAM_BOT_TOKEN_AGENT_A"],
      getDashboardForwardPort: () => "19000",
      hermesDashboardState: disabledHermesDashboardState,
      openshellShellCommand,
      buildEnv: () =>
        ({
          HOME: "/home/user",
          KUBECONFIG: "/home/user/.kube/config",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
        }) as Record<string, string>,
    });

    expect(result.effectiveDashboardPort).toBe("19000");
    expect(result.envArgs).toEqual([
      "CHAT_UI_URL=http://127.0.0.1:19000/",
      "NEMOCLAW_DASHBOARD_PORT=19000",
      "OPENCLAW_HOME=/sandbox",
      "OPENCLAW_STATE_DIR=/sandbox/.custom-openclaw",
      "OPENCLAW_WORKSPACE_DIR=/sandbox/.custom-openclaw/workspace",
      "NEMOCLAW_MINIMAL_BOOTSTRAP=1",
      "HTTP_PROXY=http://proxy.example:8080",
      "NO_PROXY=localhost,127.0.0.1,host.docker.internal,host.containers.internal,::1,0.0.0.0,inference.local",
      "no_proxy=localhost,127.0.0.1,host.docker.internal,host.containers.internal,::1,0.0.0.0,inference.local",
      "NEMOCLAW_PROXY_HOST=host.docker.internal",
      "NEMOCLAW_PROXY_PORT=3129",
      "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=TELEGRAM_BOT_TOKEN_AGENT_A",
    ]);
    expect(result.sandboxEnv).toEqual({ HOME: "/home/user" });
    expect(result.sandboxStartupCommand).toEqual(["env", ...result.envArgs, "nemoclaw-start"]);
    expect(openshellShellCommand).toHaveBeenCalledWith([
      "sandbox",
      "create",
      "--from",
      "/tmp/build/Dockerfile",
      "--name",
      "demo",
      "--",
      ...result.sandboxStartupCommand,
    ]);
    expect(result.createCommand).toBe(
      `openshell sandbox create --from /tmp/build/Dockerfile --name demo -- ${result.sandboxStartupCommand.join(" ")} 2>&1`,
    );
    expect(result.createArgv).toEqual(["bash", "-lc", result.createCommand]);
  });

  it("forwards only the allowlisted OpenClaw auto-pair runtime controls", () => {
    const result = prepareSandboxCreateLaunch({
      agent: { name: "openclaw" } as any,
      chatUiUrl: "",
      createArgs: [],
      env: {
        NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: " 30 ",
        NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "3",
        NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "10",
        NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "600",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "99",
        NEMOCLAW_PROVIDER_KEY: "must-not-enter-the-sandbox",
      },
      extraPlaceholderKeys: [],
      getDashboardForwardPort: vi.fn(() => {
        throw new Error("dashboard port should not be resolved");
      }),
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    expect(result.envArgs).toEqual([
      "OPENCLAW_HOME=/sandbox",
      "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
      "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
      "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS=30",
      "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS=3",
      "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS=10",
      "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS=600",
    ]);
    expect(result.sandboxStartupCommand.join(" ")).not.toContain(
      "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
    );
    expect(result.sandboxStartupCommand.join(" ")).not.toContain("NEMOCLAW_PROVIDER_KEY");
  });

  it("adds Hermes dashboard env and skips OpenClaw env for non-OpenClaw agents", () => {
    const result = prepareSandboxCreateLaunch({
      agent: { name: "hermes" } as any,
      chatUiUrl: "http://127.0.0.1:18789/",
      createArgs: [],
      env: { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "30" },
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "18789",
      hermesDashboardState: {
        config: { enabled: true, internalPort: 8643, port: 18790, tuiEnabled: true },
        enabled: true,
      },
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    expect(result.envArgs).toEqual([
      "CHAT_UI_URL=http://127.0.0.1:18789/",
      "NEMOCLAW_DASHBOARD_PORT=18789",
      "NEMOCLAW_HERMES_DASHBOARD=1",
      "NEMOCLAW_HERMES_DASHBOARD_PORT=18790",
      "NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT=8643",
      "NEMOCLAW_HERMES_DASHBOARD_TUI=1",
    ]);
  });

  it("omits dashboard env when dashboard management is disabled", () => {
    const result = prepareSandboxCreateLaunch({
      agent: { name: "langchain-deepagents-code" } as any,
      chatUiUrl: "",
      createArgs: [],
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: vi.fn(() => {
        throw new Error("dashboard port should not be resolved");
      }),
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    expect(result.effectiveDashboardPort).toBe("0");
    expect(result.envArgs).toEqual(["NEMOCLAW_OBSERVABILITY=0"]);
    expect(result.sandboxStartupCommand).toEqual([
      "env",
      "NEMOCLAW_OBSERVABILITY=0",
      "nemoclaw-start",
    ]);
  });

  it("drops credential-bearing proxy URLs from Deep Agents Code sandbox create env", () => {
    const result = prepareSandboxCreateLaunch({
      agent: { name: "langchain-deepagents-code" } as any,
      chatUiUrl: "",
      createArgs: ["--name", "deepagents"],
      env: {
        HTTP_PROXY: "http://safe-proxy.example:8080",
        HTTPS_PROXY: "https://user:pass@proxy.example:8443",
        http_proxy: "user:pass@proxy.example:8080",
        https_proxy: "https://safe-lower.example:8443",
      },
      extraPlaceholderKeys: [],
      getDashboardForwardPort: vi.fn(() => "0"),
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    const serialized = `${result.envArgs.join("\n")}\n${result.sandboxStartupCommand.join(" ")}\n${result.createCommand}`;
    expect(serialized).toContain("HTTP_PROXY=http://safe-proxy.example:8080");
    expect(serialized).toContain("https_proxy=https://safe-lower.example:8443");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("HTTPS_PROXY=");
    expect(serialized).not.toContain("http_proxy=");
  });

  it("ignores invalid runtime proxy overrides", () => {
    const result = prepareSandboxCreateLaunch({
      agent: null,
      chatUiUrl: "http://127.0.0.1:18789/",
      createArgs: [],
      env: {
        NEMOCLAW_PROXY_HOST: "bad:ipv6::host",
        NEMOCLAW_PROXY_PORT: "70000",
      },
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "18789",
      hermesDashboardState: disabledHermesDashboardState,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    expect(result.envArgs).not.toContain("NEMOCLAW_PROXY_HOST=bad:ipv6::host");
    expect(result.envArgs).not.toContain("NEMOCLAW_PROXY_PORT=70000");
  });

  it("preserves argv boundaries when the production renderer shells out", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launch-shell-"));
    try {
      const fakeOpenshell = path.join(tmpDir, "fake openshell");
      const capturedArgsPath = path.join(tmpDir, "argv.bin");
      const injectedFromPath = path.join(tmpDir, "from-injected");
      const injectedUrlPath = path.join(tmpDir, "url-injected");
      const injectedProxyPath = path.join(tmpDir, "proxy-injected");
      fs.writeFileSync(
        fakeOpenshell,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" > "$CAPTURE_ARGS"\n',
      );
      fs.chmodSync(fakeOpenshell, 0o755);

      const helpers = createOpenshellCliHelpers({
        getCachedBinary: () => fakeOpenshell,
        setCachedBinary: vi.fn(),
        getGatewayPort: () => 31818,
        getDockerDriverGatewayEndpoint: () => "http://127.0.0.1:31818",
      });
      const dangerousDockerfile = `${tmpDir}/Dockerfile; touch ${injectedFromPath}`;
      const dangerousChatUiUrl = `http://127.0.0.1:19000/?q='; touch ${injectedUrlPath} #`;
      const dangerousProxy = `http://proxy.example:8080/'; touch ${injectedProxyPath} #`;
      const result = prepareSandboxCreateLaunch({
        agent: null,
        chatUiUrl: dangerousChatUiUrl,
        createArgs: ["--from", dangerousDockerfile, "--name", "demo; echo pwned"],
        env: { HTTP_PROXY: dangerousProxy },
        extraPlaceholderKeys: ["TELEGRAM_BOT_TOKEN_AGENT_A"],
        getDashboardForwardPort: () => "19000",
        hermesDashboardState: disabledHermesDashboardState,
        openshellShellCommand: helpers.openshellShellCommand,
        openshellArgv: helpers.openshellArgv,
        buildEnv: () => ({}),
      });

      execFileSync("bash", ["-lc", result.createCommand], {
        env: { ...process.env, CAPTURE_ARGS: capturedArgsPath },
      });

      const capturedArgs = fs.readFileSync(capturedArgsPath, "utf-8").split("\0").filter(Boolean);
      expect(capturedArgs).toEqual([
        "sandbox",
        "create",
        "--from",
        dangerousDockerfile,
        "--name",
        "demo; echo pwned",
        "--",
        "env",
        ...result.envArgs,
        "nemoclaw-start",
      ]);
      expect(fs.existsSync(injectedFromPath)).toBe(false);
      expect(fs.existsSync(injectedUrlPath)).toBe(false);
      expect(fs.existsSync(injectedProxyPath)).toBe(false);
      expect(result.createArgv).toEqual([fakeOpenshell, ...capturedArgs]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("forwards the validated sandbox name into the Deep Agents Code sandbox create env", () => {
    const result = prepareSandboxCreateLaunch({
      agent: { name: "langchain-deepagents-code" } as any,
      chatUiUrl: "",
      createArgs: ["--name", "rendered-name"],
      sandboxName: "dcode-demo",
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: vi.fn(() => "0"),
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    expect(result.envArgs).toContain("NEMOCLAW_SANDBOX_NAME=dcode-demo");
    expect(result.envArgs).not.toContain("NEMOCLAW_SANDBOX_NAME=rendered-name");
  });

  it("does not forward the sandbox name for non-Deep-Agents-Code agents", () => {
    const result = prepareSandboxCreateLaunch({
      agent: { name: "openclaw", configPaths: { dir: "/sandbox/.custom-openclaw" } } as any,
      chatUiUrl: "http://127.0.0.1:19000/",
      createArgs: ["--name", "demo"],
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "19000",
      hermesDashboardState: disabledHermesDashboardState,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    expect(result.envArgs.some((arg) => arg.startsWith("NEMOCLAW_SANDBOX_NAME="))).toBe(false);
  });
});

describe("prepareSandboxCreateLaunchWithPrebuild", () => {
  it("hands the build-qualified image to the canonical launch renderer", async () => {
    const buildCtx = createTrustedBuildContext();
    const dockerfile = path.join(buildCtx, "Dockerfile");
    const buildImage = vi.fn(async () => 0);
    const result = await prepareSandboxCreateLaunchWithPrebuild({
      agent: null,
      chatUiUrl: "",
      createArgs: ["--from", dockerfile, "--name", "demo"],
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "0",
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      sandboxName: "demo",
      buildEnv: () => ({}),
      prebuild: {
        buildCtx,
        buildId: "build-123",
        dockerDriverGateway: true,
        env: { NEMOCLAW_SANDBOX_PREBUILD: "1" },
        buildImage,
        log: vi.fn(),
        origin: "generated",
      },
    });

    expect(result.prebuild).toEqual({
      createArgs: ["--from", "nemoclaw-sandbox-local:demo-build-123", "--name", "demo"],
      imageRef: "nemoclaw-sandbox-local:demo-build-123",
    });
    expect(result.createCommand).toContain(
      "sandbox create --from nemoclaw-sandbox-local:demo-build-123 --name demo",
    );
    expect(buildImage).toHaveBeenCalledOnce();
  });

  it("renders the original Dockerfile after a local build failure", async () => {
    const buildCtx = createTrustedBuildContext();
    const dockerfile = path.join(buildCtx, "Dockerfile");
    const result = await prepareSandboxCreateLaunchWithPrebuild({
      agent: null,
      chatUiUrl: "",
      createArgs: ["--from", dockerfile, "--name", "demo"],
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "0",
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      sandboxName: "demo",
      buildEnv: () => ({}),
      prebuild: {
        buildCtx,
        buildId: "build-123",
        dockerDriverGateway: true,
        env: { NEMOCLAW_SANDBOX_PREBUILD: "1" },
        buildImage: async () => 1,
        log: vi.fn(),
        origin: "generated",
      },
    });

    expect(result.prebuild).toEqual({
      createArgs: ["--from", dockerfile, "--name", "demo"],
      imageRef: null,
    });
    expect(result.createCommand).toContain(`sandbox create --from ${dockerfile} --name demo`);
    expect(result.createCommand).not.toContain("nemoclaw-sandbox-local");
  });
});
