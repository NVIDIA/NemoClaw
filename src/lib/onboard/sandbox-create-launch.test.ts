// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { loadAgent } from "../agent/defs";
import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../sandbox/build-context";
import { MANAGED_BOOTSTRAP_IDENTITY_ENV } from "./managed-bootstrap/adapter";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import { createOpenshellCliHelpers } from "./openshell-cli";
import {
  buildSandboxRuntimeEnvArgs,
  prepareSandboxCreateLaunch,
  prepareSandboxCreateLaunchWithPrebuild,
} from "./sandbox-create-launch";

const disabledHermesDashboardState = { config: null, enabled: false };
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
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

describe("buildSandboxRuntimeEnvArgs", () => {
  it("omits credential-bearing env when omitCredentialEnv is set", () => {
    const base = {
      agent: { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } } as any,
      chatUiUrl: "http://127.0.0.1:19000/",
      manageDashboard: true,
      getDashboardForwardPort: () => "19000",
      hermesDashboardState: disabledHermesDashboardState,
      extraPlaceholderKeys: ["TELEGRAM_BOT_TOKEN_AGENT_A"],
      env: {
        HTTPS_PROXY: "http://proxyuser:proxypass@proxy.example:8080",
        NEMOCLAW_PROXY_HOST: "host.docker.internal",
        NEMOCLAW_PROXY_PORT: "3129",
      } as NodeJS.ProcessEnv,
    };

    const included = buildSandboxRuntimeEnvArgs(base).envArgs;
    expect(included).toContain("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=TELEGRAM_BOT_TOKEN_AGENT_A");
    expect(included.some((arg) => arg.startsWith("HTTPS_PROXY="))).toBe(true);

    const omitted = buildSandboxRuntimeEnvArgs({ ...base, omitCredentialEnv: true }).envArgs;
    expect(omitted.some((arg) => arg.startsWith("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS"))).toBe(false);
    expect(omitted.some((arg) => arg.includes("proxypass"))).toBe(false);
    expect(omitted.some((arg) => arg.startsWith("HTTPS_PROXY="))).toBe(false);
    expect(omitted).toContain("NEMOCLAW_DASHBOARD_PORT=19000");
    expect(omitted).toContain("NEMOCLAW_PROXY_HOST=host.docker.internal");
  });

  // OpenShell exports OPENSHELL_SANDBOX as the boolean "1" to sandbox processes,
  // so this injection is the sandbox's only source for its own name. Without it
  // the in-sandbox hints print a `<name>` placeholder instead of a copyable
  // host-side command. It used to be injected only for LangChain Deep Agents
  // Code.
  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "injects NEMOCLAW_SANDBOX_NAME for every agent [%s] (#7795)",
    (agentName) => {
      const base = {
        chatUiUrl: "http://127.0.0.1:19000/",
        manageDashboard: true,
        getDashboardForwardPort: () => "19000",
        hermesDashboardState: disabledHermesDashboardState,
        extraPlaceholderKeys: [],
        env: {} as NodeJS.ProcessEnv,
        sandboxName: "my-assistant",
      };

      const envArgs = buildSandboxRuntimeEnvArgs({
        ...base,
        agent: { name: agentName, configPaths: { dir: "/sandbox/.openclaw" } } as any,
        hermesApiPort: agentName === "hermes" ? 8642 : null,
      }).envArgs;
      expect(envArgs, `${agentName} should receive the sandbox name`).toContain(
        "NEMOCLAW_SANDBOX_NAME=my-assistant",
      );
    },
  );

  it("injects the sandbox-owned Hermes API port", () => {
    const envArgs = buildSandboxRuntimeEnvArgs({
      agent: { name: "hermes", configPaths: { dir: "/sandbox/.hermes" } } as any,
      chatUiUrl: "",
      manageDashboard: false,
      getDashboardForwardPort: () => "0",
      hermesDashboardState: disabledHermesDashboardState,
      hermesApiPort: 8647,
      extraPlaceholderKeys: [],
      env: {} as NodeJS.ProcessEnv,
      sandboxName: "my-assistant",
    }).envArgs;

    expect(envArgs).toContain("NEMOCLAW_HERMES_API_PORT=8647");
  });

  it("omits NEMOCLAW_SANDBOX_NAME when no sandbox name is known", () => {
    const envArgs = buildSandboxRuntimeEnvArgs({
      agent: { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } } as any,
      chatUiUrl: "http://127.0.0.1:19000/",
      manageDashboard: true,
      getDashboardForwardPort: () => "19000",
      hermesDashboardState: disabledHermesDashboardState,
      hermesApiPort: 8642,
      extraPlaceholderKeys: [],
      env: {} as NodeJS.ProcessEnv,
    }).envArgs;
    expect(envArgs.some((arg) => arg.startsWith("NEMOCLAW_SANDBOX_NAME="))).toBe(false);
  });

  it("forwards only the literal OpenClaw MCP shadow diagnostic opt-in", () => {
    const base = {
      chatUiUrl: "",
      manageDashboard: false,
      getDashboardForwardPort: () => "0",
      hermesDashboardState: disabledHermesDashboardState,
      extraPlaceholderKeys: [],
    };
    const openclaw = { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } } as any;

    expect(
      buildSandboxRuntimeEnvArgs({
        ...base,
        agent: openclaw,
        env: { NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: " 1 " },
      }).envArgs,
    ).toContain("NEMOCLAW_MCP_SHADOW_DIAGNOSTICS=1");
    expect(
      buildSandboxRuntimeEnvArgs({
        ...base,
        agent: openclaw,
        env: { NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "true" },
      }).envArgs.some((entry) => entry.startsWith("NEMOCLAW_MCP_SHADOW_DIAGNOSTICS=")),
    ).toBe(false);
    expect(
      buildSandboxRuntimeEnvArgs({
        ...base,
        agent: loadAgent("hermes"),
        env: { NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1" },
      }).envArgs,
    ).not.toContain("NEMOCLAW_MCP_SHADOW_DIAGNOSTICS=1");
  });

  it.each([
    ["1500", "1500"],
    [" 3000 ", "3000"],
    ["10000", "10000"],
  ])("forwards the bounded OpenClaw tools/list timeout %s as %s", (input, expected) => {
    const envArgs = buildSandboxRuntimeEnvArgs({
      agent: { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } } as any,
      chatUiUrl: "",
      manageDashboard: false,
      getDashboardForwardPort: () => "0",
      hermesDashboardState: disabledHermesDashboardState,
      extraPlaceholderKeys: [],
      env: { NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS: input },
    }).envArgs;

    expect(envArgs).toContain(`NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS=${expected}`);
  });

  it("forwards the tools/list timeout to the legacy null-agent OpenClaw path", () => {
    const envArgs = buildSandboxRuntimeEnvArgs({
      agent: null,
      chatUiUrl: "",
      manageDashboard: false,
      getDashboardForwardPort: () => "0",
      hermesDashboardState: disabledHermesDashboardState,
      extraPlaceholderKeys: [],
      env: { NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS: "3000" },
    }).envArgs;

    expect(envArgs).toContain("NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS=3000");
  });

  it.each(["1499", "10001", "3000.5", "3s", "+3000", "03000", "1e4"])(
    "rejects the invalid OpenClaw tools/list timeout %s before sandbox creation",
    (value) => {
      expect(() =>
        buildSandboxRuntimeEnvArgs({
          agent: { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } } as any,
          chatUiUrl: "",
          manageDashboard: false,
          getDashboardForwardPort: () => "0",
          hermesDashboardState: disabledHermesDashboardState,
          extraPlaceholderKeys: [],
          env: { NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS: value },
        }),
      ).toThrow(
        "NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS must be an integer from 1500 to 10000 milliseconds.",
      );
    },
  );

  it.each(["hermes", "langchain-deepagents-code"])(
    "does not forward the OpenClaw tools/list timeout to %s",
    (agentName) => {
      const envArgs = buildSandboxRuntimeEnvArgs({
        agent: { name: agentName, configPaths: { dir: "/sandbox/.openclaw" } } as any,
        chatUiUrl: "",
        manageDashboard: false,
        getDashboardForwardPort: () => "0",
        hermesDashboardState: disabledHermesDashboardState,
        extraPlaceholderKeys: [],
        env: { NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS: "3000" },
      }).envArgs;

      expect(envArgs.some((arg) => arg.startsWith("NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS="))).toBe(
        false,
      );
    },
  );
});

describe("prepareSandboxCreateLaunch", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "renders one identity-bound held launch for %s without exposing the startup profile",
    (agentName) => {
      const request = createManagedStartupRootApplyRequest({
        agent: agentName,
        encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agentName)),
      });
      const result = prepareSandboxCreateLaunch({
        agent: loadAgent(agentName),
        chatUiUrl: "",
        createArgs: ["--name", `${agentName}-sandbox`],
        env: {},
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => "0",
        hermesApiPort: 8642,
        hermesDashboardState: disabledHermesDashboardState,
        manageDashboard: false,
        openshellShellCommand: (args) => args.join(" "),
        openshellArgv: (args) => ["openshell", ...args],
        buildEnv: () => ({}),
        managedStartupRootApplyRequest: request,
      });

      expect(result.intendedSandboxStartupCommand).toEqual([
        "env",
        ...result.envArgs,
        "/usr/local/bin/nemoclaw-start",
      ]);
      expect(result.managedBootstrapIdentity).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.sandboxStartupCommand).toEqual([
        ...result.intendedSandboxStartupCommand.slice(0, -1),
        "/usr/local/bin/nemoclaw-managed-startup-hold",
        "--agent",
        agentName,
        "--profile-fingerprint",
        request.profileFingerprint,
        "--bootstrap-identity",
        result.managedBootstrapIdentity,
        "--",
      ]);
      expect(result.createArgv).toEqual(
        expect.arrayContaining([
          "--env",
          `${MANAGED_BOOTSTRAP_IDENTITY_ENV}=${result.managedBootstrapIdentity}`,
        ]),
      );
      expect(result.createArgv.join("\n")).not.toContain(request.encodedProfile);
    },
  );

  it("rejects a caller-supplied managed bootstrap identity environment", () => {
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
    });

    expect(() =>
      prepareSandboxCreateLaunch({
        agent: loadAgent("openclaw"),
        chatUiUrl: "",
        createArgs: ["--env", `${MANAGED_BOOTSTRAP_IDENTITY_ENV}=${"a".repeat(64)}`],
        env: {},
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => "0",
        hermesDashboardState: disabledHermesDashboardState,
        manageDashboard: false,
        openshellShellCommand: (args) => args.join(" "),
        managedStartupRootApplyRequest: request,
      }),
    ).toThrow(`must not override reserved ${MANAGED_BOOTSTRAP_IDENTITY_ENV}`);
  });

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
    expect(result.sandboxStartupCommand).toEqual([
      "env",
      ...result.envArgs,
      "/usr/local/bin/nemoclaw-start",
    ]);
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
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: " 0.25 ",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: " 99 ",
        NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "10",
        NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "600",
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
      "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS=0.25",
      "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS=99",
      "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS=10",
      "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS=600",
    ]);
    expect(result.sandboxStartupCommand.join(" ")).not.toContain("NEMOCLAW_PROVIDER_KEY");
  });

  it("adds Hermes dashboard env and skips OpenClaw env for non-OpenClaw agents", () => {
    const result = prepareSandboxCreateLaunch({
      agent: loadAgent("hermes"),
      chatUiUrl: "http://127.0.0.1:18789/",
      createArgs: [],
      env: {
        NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "30",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "1",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
      },
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
      "/usr/local/bin/nemoclaw-start",
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
        "/usr/local/bin/nemoclaw-start",
      ]);
      expect(fs.existsSync(injectedFromPath)).toBe(false);
      expect(fs.existsSync(injectedUrlPath)).toBe(false);
      expect(fs.existsSync(injectedProxyPath)).toBe(false);
      expect(result.createArgv).toEqual([fakeOpenshell, ...capturedArgs]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("routes bounded OpenShell probes through the process-tree timeout adapter (#10238)", () => {
    const runCommand = vi.fn((_command: readonly string[], _options?: unknown) => {
      return { status: 0 } as never;
    });
    const helpers = createOpenshellCliHelpers({
      getCachedBinary: () => "/opt/openshell",
      setCachedBinary: vi.fn(),
      getGatewayPort: () => 31818,
      getDockerDriverGatewayEndpoint: () => "http://127.0.0.1:31818",
      runCommand,
    });

    helpers.runOpenshell(["sandbox", "list"], {
      ignoreError: true,
      killProcessTreeOnTimeout: true,
      timeout: 1000,
    });

    const expectedArgv =
      process.platform === "linux" && fs.existsSync("/usr/bin/timeout")
        ? ["/usr/bin/timeout", "--signal=KILL", "0.75s", "/opt/openshell", "sandbox", "list"]
        : ["/opt/openshell", "sandbox", "list"];
    expect(runCommand).toHaveBeenCalledWith(
      expectedArgv,
      expect.objectContaining({
        ignoreError: true,
        killSignal: "SIGKILL",
        timeout: 1000,
      }),
    );
    expect(runCommand.mock.calls[0]?.[1]).not.toHaveProperty("killProcessTreeOnTimeout");
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
      hermesApiPort: 8642,
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
        inspectImageId: () => IMAGE_ID,
        log: vi.fn(),
        origin: "generated",
      },
    });

    expect(result.prebuild).toEqual({
      createArgs: ["--from", "nemoclaw-sandbox-local:demo-build-123", "--name", "demo"],
      imageRef: "nemoclaw-sandbox-local:demo-build-123",
      imageId: IMAGE_ID,
    });
    expect(result.createCommand).toContain(
      "sandbox create --from nemoclaw-sandbox-local:demo-build-123 --name demo",
    );
    expect(buildImage).toHaveBeenCalledOnce();
  });

  it.each([
    ["OpenClaw", null],
    ["Hermes", { name: "hermes" }],
  ])(
    "fails closed for a generated %s image after a local BuildKit failure",
    async (_agentName, agent) => {
      const buildCtx = createTrustedBuildContext();
      const dockerfile = path.join(buildCtx, "Dockerfile");

      await expect(
        prepareSandboxCreateLaunchWithPrebuild({
          agent: agent as any,
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
        }),
      ).rejects.toThrow("Local BuildKit build failed (exit 1)");
    },
  );

  it("preserves the gateway builder for generated Deep Agents Code images", async () => {
    const buildCtx = createTrustedBuildContext();
    const dockerfile = path.join(buildCtx, "Dockerfile");
    const result = await prepareSandboxCreateLaunchWithPrebuild({
      agent: { name: "langchain-deepagents-code" } as any,
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
      imageId: null,
    });
    expect(result.createCommand).toContain(`sandbox create --from ${dockerfile} --name demo`);
    expect(result.createCommand).not.toContain("nemoclaw-sandbox-local");
  });

  it("preserves the rootless gateway path for a generated portable Hermes image", async () => {
    const buildCtx = createTrustedBuildContext();
    const dockerfile = path.join(buildCtx, "Dockerfile");
    const result = await prepareSandboxCreateLaunchWithPrebuild({
      agent: { name: "hermes" } as any,
      chatUiUrl: "",
      createArgs: ["--from", dockerfile, "--name", "demo"],
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "0",
      hermesApiPort: 8642,
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      sandboxName: "demo",
      buildEnv: () => ({}),
      prebuild: {
        buildCtx,
        buildId: "build-123",
        dockerDriverGateway: true,
        env: {
          NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
          NEMOCLAW_SANDBOX_PREBUILD: "1",
        },
        buildImage: async () => 1,
        log: vi.fn(),
        origin: "generated",
      },
    });

    expect(result.prebuild).toEqual({
      createArgs: ["--from", dockerfile, "--name", "demo"],
      imageRef: null,
      imageId: null,
    });
  });
});
