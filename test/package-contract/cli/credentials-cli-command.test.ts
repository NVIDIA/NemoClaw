// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const TAVILY_PROFILE_PATH = path.join(
  REPO_ROOT,
  "nemoclaw-blueprint",
  "provider-profiles",
  "tavily.yaml",
);
const COMMAND_PATHS = {
  common: path.join(REPO_ROOT, "dist", "lib", "credentials", "command-support.js"),
  credentials: path.join(REPO_ROOT, "dist", "commands", "credentials.js"),
  add: path.join(REPO_ROOT, "dist", "commands", "credentials", "add.js"),
  list: path.join(REPO_ROOT, "dist", "commands", "credentials", "list.js"),
  reset: path.join(REPO_ROOT, "dist", "commands", "credentials", "reset.js"),
  action: path.join(REPO_ROOT, "dist", "lib", "actions", "credentials-add.js"),
};
const GLOBAL_ACTIONS_PATH = path.join(REPO_ROOT, "dist", "lib", "actions", "global.js");
type CredentialsCommandClasses = {
  CredentialsCommand: typeof import("../../../src/commands/credentials.js").default;
  CredentialsAddCommand: typeof import("../../../src/commands/credentials/add.js").default;
  CredentialsListCommand: typeof import("../../../src/commands/credentials/list.js").default;
  CredentialsResetCommand: typeof import("../../../src/commands/credentials/reset.js").default;
};
type SpawnLikeResult = { status: number | null; stdout?: string; stderr?: string };
type RuntimeRecovery = {
  recovered: boolean;
  before?: unknown;
  after?: unknown;
  attempted?: boolean;
  via?: string;
};
type RuntimeBridgeRunOptions = {
  env?: Record<string, string | undefined>;
  replaceEnv?: boolean;
  stdio?: unknown;
  ignoreError?: boolean;
  timeout?: number;
};
type RuntimeBridge = {
  recoverNamedGatewayRuntime: () => Promise<RuntimeRecovery>;
  runOpenshell: (args: string[], opts?: RuntimeBridgeRunOptions) => SpawnLikeResult;
  recordExtraProvider: (name: string) => boolean;
  forgetExtraProvider: (name: string) => boolean;
};
type OpenshellCall = { args: string[]; opts?: RuntimeBridgeRunOptions };

function loadCommands(): CredentialsCommandClasses {
  for (const modulePath of Object.values(COMMAND_PATHS)) {
    delete require.cache[modulePath];
  }
  return {
    CredentialsCommand: require(COMMAND_PATHS.credentials).default,
    CredentialsAddCommand: require(COMMAND_PATHS.add).default,
    CredentialsListCommand: require(COMMAND_PATHS.list).default,
    CredentialsResetCommand: require(COMMAND_PATHS.reset).default,
  } as CredentialsCommandClasses;
}

function installRuntimeBridge(bridge: Partial<RuntimeBridge> = {}): OpenshellCall[] {
  const calls: OpenshellCall[] = [];
  const runtime: RuntimeBridge = {
    recoverNamedGatewayRuntime: async () => ({ recovered: true }),
    runOpenshell: (args: string[], opts?: RuntimeBridgeRunOptions) => {
      calls.push({ args, opts });
      return { status: 0, stdout: "", stderr: "" };
    },
    recordExtraProvider: () => true,
    forgetExtraProvider: () => true,
    ...bridge,
  };
  const globalActions = require(GLOBAL_ACTIONS_PATH) as {
    setGlobalCliActionRuntimeHooksForTest: (hooks: RuntimeBridge) => void;
  };
  globalActions.setGlobalCliActionRuntimeHooksForTest(runtime);
  return calls;
}

async function captureOutput(
  action: () => Promise<unknown>,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const callback = args.find(
      (arg): arg is (error?: Error | null) => void => typeof arg === "function",
    );
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const callback = args.find(
      (arg): arg is (error?: Error | null) => void => typeof arg === "function",
    );
    callback?.();
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };

  try {
    await action();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  return { stdout, stderr };
}

async function expectExitCode(action: () => Promise<unknown>, expectedCode: number): Promise<void> {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await action();
    expect(process.exitCode).toBe(expectedCode);
  } finally {
    process.exitCode = originalExitCode;
  }
}

afterEach(() => {
  for (const modulePath of Object.values(COMMAND_PATHS)) {
    delete require.cache[modulePath];
  }
  delete require.cache[GLOBAL_ACTIONS_PATH];
});

describe("credentials oclif commands", () => {
  it("prints top-level credentials usage", async () => {
    const { CredentialsCommand } = loadCommands();
    const output = await captureOutput(() => CredentialsCommand.run([]));

    expect(output.stdout).toContain("Usage: nemoclaw credentials <subcommand>");
    expect(output.stdout).toMatch(/list\s+List provider credentials/);
    expect(output.stdout).toMatch(/add <PROVIDER> --type <TYPE>\s+Register a provider credential/);
    expect(output.stdout).toContain("reset <PROVIDER> [--yes]");
  });

  it("lists provider credentials and separates messaging bridges", async () => {
    const calls = installRuntimeBridge({
      runOpenshell: (args, opts) => {
        calls.push({ args, opts });
        return {
          status: 0,
          stdout: [
            "alpha-telegram-bridge",
            "nvidia-prod",
            "alpha-slack-app",
            "openai-prod",
            "",
          ].join("\n"),
        };
      },
    });
    const { CredentialsListCommand } = loadCommands();

    const output = await captureOutput(() => CredentialsListCommand.run([]));

    expect(calls).toEqual([
      {
        args: ["provider", "list", "--names"],
        opts: {
          env: expect.any(Object),
          ignoreError: true,
          replaceEnv: true,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      },
    ]);
    expect(output.stdout).toContain("openai-prod");
    expect(output.stdout).toContain("nvidia-prod");
    expect(output.stdout).toContain("2 per-sandbox messaging bridge(s)");
    expect(output.stdout).toContain("channels list/remove/stop");
    expect(output.stdout).not.toContain("alpha-telegram-bridge");
  });

  it("reports an empty credential list while hiding messaging bridges", async () => {
    installRuntimeBridge({
      runOpenshell: () => ({ status: 0, stdout: "alpha-discord-bridge\nalpha-slack-bridge\n" }),
    });
    const { CredentialsListCommand } = loadCommands();

    const output = await captureOutput(() => CredentialsListCommand.run([]));

    expect(output.stdout).toContain("No provider credentials registered.");
    expect(output.stdout).toContain("2 per-sandbox messaging bridge(s)");
  });

  it("exits when provider list cannot query the gateway", async () => {
    installRuntimeBridge({
      runOpenshell: () => ({ status: 1, stderr: "gateway unavailable" }),
    });
    const { CredentialsListCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(() => CredentialsListCommand.run([]), 1),
    );

    expect(output.stderr).toContain("Could not query OpenShell gateway");
    expect(output.stderr).toContain("openshell gateway start --name nemoclaw");
  });

  it("records gateway recovery failures without calling provider list", async () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "nvidia-prod" }));
    installRuntimeBridge({
      recoverNamedGatewayRuntime: async () => ({ recovered: false }),
      runOpenshell,
    });
    const { CredentialsListCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(() => CredentialsListCommand.run([]), 1),
    );

    expect(output.stderr).toContain("Could not query the NemoClaw OpenShell gateway");
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("deletes a provider credential with --yes", async () => {
    const calls = installRuntimeBridge({
      runOpenshell: (args, opts) => {
        calls.push({ args, opts });
        return { status: 0 };
      },
    });
    const { CredentialsResetCommand } = loadCommands();

    const output = await captureOutput(() => CredentialsResetCommand.run(["nvidia-prod", "--yes"]));

    expect(calls).toEqual([
      {
        args: ["provider", "delete", "nvidia-prod"],
        opts: {
          env: expect.any(Object),
          ignoreError: true,
          replaceEnv: true,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      },
    ]);
    expect(output.stdout).toContain("Removed provider 'nvidia-prod'");
    expect(output.stdout).toContain("Re-run 'nemoclaw onboard'");
  });

  it("rejects per-sandbox messaging bridge names for credential reset", async () => {
    installRuntimeBridge();
    const { CredentialsResetCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(() => CredentialsResetCommand.run(["alpha-telegram-bridge", "--yes"]), 1),
    );

    expect(output.stderr).toContain("per-sandbox messaging bridge");
    expect(output.stderr).toContain("channels remove");
    expect(output.stderr).toContain("channels remove <channel>");
    expect(output.stderr).not.toContain("channels remove <discord");
  });

  it("explains provider-name usage when reset receives an env var name", async () => {
    installRuntimeBridge({
      runOpenshell: () => ({ status: 1, stderr: "provider not found" }),
    });
    const { CredentialsResetCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(() => CredentialsResetCommand.run(["NVIDIA_INFERENCE_API_KEY", "--yes"]), 1),
    );

    expect(output.stderr).toContain("Could not remove provider 'NVIDIA_INFERENCE_API_KEY'.");
    expect(output.stderr).toContain("looks like a credential env variable name");
    expect(output.stderr).toContain("provider not found");
  });

  it("credentials add rejects inline KEY=VALUE credentials and never echoes the value", async () => {
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(
        () =>
          CredentialsAddCommand.run([
            "tavily-search",
            "--type",
            "tavily",
            "--credential",
            "TAVILY_API_KEY=tvly-secret-12345",
          ]),
        1,
      ),
    );

    expect(output.stderr).toContain("--credential expects an env variable name, not 'KEY=VALUE'");
    expect(output.stderr).not.toContain("tvly-secret-12345");
    expect(output.stdout).not.toContain("tvly-secret-12345");
  });

  it("credentials add forwards env-key-only --credential to OpenShell provider create", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    process.env.UNRELATED_API_KEY = "unrelated-secret-67890";
    const extraProviderCalls: string[] = [];
    const calls = installRuntimeBridge({
      runOpenshell: (args, opts) => {
        calls.push({ args, opts });
        return { status: 0, stdout: "" };
      },
      recordExtraProvider: (name) => {
        extraProviderCalls.push(name);
        return true;
      },
    });
    const { CredentialsAddCommand } = loadCommands();

    try {
      const output = await captureOutput(() =>
        CredentialsAddCommand.run([
          "tavily-search",
          "--type",
          "tavily",
          "--credential",
          "TAVILY_API_KEY",
        ]),
      );

      expect(calls).toEqual([
        {
          args: ["provider", "profile", "import", "--file", TAVILY_PROFILE_PATH],
          opts: {
            env: expect.any(Object),
            ignoreError: true,
            replaceEnv: true,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          },
        },
        {
          args: [
            "provider",
            "create",
            "--name",
            "tavily-search",
            "--type",
            "tavily",
            "--credential",
            "TAVILY_API_KEY",
          ],
          opts: {
            env: expect.any(Object),
            ignoreError: true,
            replaceEnv: true,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          },
        },
      ]);
      expect(calls[0]?.opts?.env?.TAVILY_API_KEY).toBeUndefined();
      expect(calls[1]?.opts?.env?.UNRELATED_API_KEY).toBeUndefined();
      expect(calls[1]?.opts?.env?.TAVILY_API_KEY).toBe("tvly-test-12345");
      expect(calls[1]?.args).not.toContain("tvly-test-12345");
      expect(extraProviderCalls).toEqual(["tavily-search"]);
      expect(output.stdout).toContain("Registered provider 'tavily-search'");
      expect(output.stdout).toContain("rebuild");
    } finally {
      delete process.env.TAVILY_API_KEY;
      delete process.env.UNRELATED_API_KEY;
    }
  });

  it("credentials add does not record an extra provider when the gateway rejects the call", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    const extraProviderCalls: string[] = [];
    installRuntimeBridge({
      runOpenshell: (args) =>
        args.includes("profile")
          ? { status: 0, stdout: "" }
          : { status: 1, stderr: "gateway unavailable" },
      recordExtraProvider: (name) => {
        extraProviderCalls.push(name);
        return true;
      },
    });
    const { CredentialsAddCommand } = loadCommands();

    try {
      await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "tavily-search",
              "--type",
              "tavily",
              "--credential",
              "TAVILY_API_KEY",
            ]),
          1,
        ),
      );

      expect(extraProviderCalls).toEqual([]);
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("credentials add redacts credential-shaped stderr on failure", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    const leakedTavilyValue = `tvly-${"leaked-secret"}-9999`;
    installRuntimeBridge({
      runOpenshell: (args) =>
        args.includes("profile")
          ? { status: 0, stdout: "" }
          : {
              status: 1,
              stderr: `auth failed: TAVILY_API_KEY=${leakedTavilyValue} rejected`,
            },
    });
    const { CredentialsAddCommand } = loadCommands();

    try {
      const output = await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "tavily-search",
              "--type",
              "tavily",
              "--credential",
              "TAVILY_API_KEY",
            ]),
          1,
        ),
      );

      expect(output.stderr).toContain("Could not register provider 'tavily-search'");
      expect(output.stderr).not.toContain(leakedTavilyValue);
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("credentials add reports an already-exists hint pointing at credentials reset", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    installRuntimeBridge({
      runOpenshell: (args) =>
        args.includes("profile")
          ? { status: 0, stdout: "" }
          : { status: 1, stderr: "provider 'tavily-search' already exists" },
    });
    const { CredentialsAddCommand } = loadCommands();

    try {
      const output = await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "tavily-search",
              "--type",
              "tavily",
              "--credential",
              "TAVILY_API_KEY",
            ]),
          1,
        ),
      );

      expect(output.stderr).toContain("is already registered");
      expect(output.stderr).toContain("credentials reset tavily-search --yes");
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("credentials add stops before provider create when bundled profile import fails", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    const leakedTavilyValue = `tvly-${"leaked"}-9999`;
    const calls: OpenshellCall[] = [];
    installRuntimeBridge({
      runOpenshell: (args, opts) => {
        calls.push({ args, opts });
        return { status: 2, stderr: `schema rejected TAVILY_API_KEY=${leakedTavilyValue}` };
      },
    });
    const { CredentialsAddCommand } = loadCommands();

    try {
      const output = await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "tavily-search",
              "--type",
              "tavily",
              "--credential",
              "TAVILY_API_KEY",
            ]),
          1,
        ),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual([
        "provider",
        "profile",
        "import",
        "--file",
        TAVILY_PROFILE_PATH,
      ]);
      expect(output.stderr).toContain("Could not import bundled provider profile 'tavily'");
      expect(output.stderr).not.toContain(leakedTavilyValue);
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("credentials add rejects per-sandbox messaging bridge provider names", async () => {
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(
        () =>
          CredentialsAddCommand.run([
            "alpha-telegram-bridge",
            "--type",
            "telegram",
            "--credential",
            "TELEGRAM_BOT_TOKEN",
          ]),
        1,
      ),
    );

    expect(output.stderr).toContain("per-sandbox messaging bridge");
    expect(output.stderr).toContain("channels add");
  });

  it("credentials add fails when the requested env variable is not exported", async () => {
    delete process.env.UNSET_PROVIDER_KEY;
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(
        () =>
          CredentialsAddCommand.run([
            "demo-provider",
            "--type",
            "generic",
            "--credential",
            "UNSET_PROVIDER_KEY",
          ]),
        1,
      ),
    );

    expect(output.stderr).toContain("UNSET_PROVIDER_KEY");
    expect(output.stderr).toContain("is not set in the current shell");
  });

  it("credentials add rejects --config keys that look credential-shaped", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    try {
      const output = await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "demo-provider",
              "--type",
              "generic",
              "--credential",
              "TAVILY_API_KEY",
              "--config",
              "api_key=tvly-leaked-12345",
            ]),
          1,
        ),
      );

      expect(output.stderr).toContain("looks credential-shaped");
      expect(output.stderr).not.toContain("tvly-leaked-12345");
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("credentials add rejects --config entries missing the KEY=VALUE form", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    try {
      const output = await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "demo-provider",
              "--type",
              "generic",
              "--credential",
              "TAVILY_API_KEY",
              "--config",
              "region-without-equals",
            ]),
          1,
        ),
      );

      expect(output.stderr).toContain("--config must be in KEY=VALUE form");
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("credentials add rejects provider names outside the OpenShell grammar", async () => {
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(
        () =>
          CredentialsAddCommand.run([
            "bad name/with*chars",
            "--type",
            "tavily",
            "--credential",
            "TAVILY_API_KEY",
          ]),
        1,
      ),
    );

    expect(output.stderr).toContain("Provider name must be");
  });

  it("credentials add rejects --credential env names longer than 256 chars", async () => {
    const longName = `A${"X".repeat(260)}`;
    process.env[longName] = "v";
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    try {
      const output = await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "demo-provider",
              "--type",
              "generic",
              "--credential",
              longName,
            ]),
          1,
        ),
      );

      expect(output.stderr).toContain("--credential must be a valid env variable name");
    } finally {
      delete process.env[longName];
    }
  });

  it("credentials add rejects --config entries longer than the per-entry limit", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    try {
      const longEntry = `region=${"x".repeat(5000)}`;
      const output = await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "demo-provider",
              "--type",
              "generic",
              "--credential",
              "TAVILY_API_KEY",
              "--config",
              longEntry,
            ]),
          1,
        ),
      );

      expect(output.stderr).toContain("--config entry exceeds");
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("credentials reset redacts credential-shaped stderr from OpenShell failures", async () => {
    installRuntimeBridge({
      runOpenshell: () => ({
        status: 1,
        stderr: "delete failed: leaked nvapi-abcdefghijklmnopqrstuv from gateway",
      }),
    });
    const { CredentialsResetCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectExitCode(() => CredentialsResetCommand.run(["tavily-search", "--yes"]), 1),
    );

    expect(output.stderr).not.toContain("nvapi-abcdefghijklmnopqrstuv");
    expect(output.stderr).toContain("delete failed");
  });

  it("credentials add rejects --config values that look secret-shaped", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-12345";
    installRuntimeBridge();
    const { CredentialsAddCommand } = loadCommands();

    try {
      const output = await captureOutput(() =>
        expectExitCode(
          () =>
            CredentialsAddCommand.run([
              "demo-provider",
              "--type",
              "generic",
              "--credential",
              "TAVILY_API_KEY",
              "--config",
              "region=tvly-secret-shaped-12345",
            ]),
          1,
        ),
      );

      expect(output.stderr).toContain("looks secret-shaped");
      expect(output.stderr).not.toContain("tvly-secret-shaped-12345");
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("credentials reset cleans local state when the gateway provider is already absent", async () => {
    const forgetCalls: string[] = [];
    installRuntimeBridge({
      runOpenshell: () => ({ status: 1, stderr: "provider not found" }),
      forgetExtraProvider: (name) => {
        forgetCalls.push(name);
        return true;
      },
    });
    const { CredentialsResetCommand } = loadCommands();

    const output = await captureOutput(() =>
      CredentialsResetCommand.run(["tavily-search", "--yes"]),
    );

    expect(forgetCalls).toEqual(["tavily-search"]);
    expect(output.stdout).toContain("already absent");
    expect(output.stdout).toContain("Local state was cleaned up");
  });

  it("credentials reset cleans uppercase provider names when the gateway provider is already absent", async () => {
    const forgetCalls: string[] = [];
    installRuntimeBridge({
      runOpenshell: () => ({ status: 1, stderr: "provider not found" }),
      forgetExtraProvider: (name) => {
        forgetCalls.push(name);
        return true;
      },
    });
    const { CredentialsResetCommand } = loadCommands();

    const output = await captureOutput(() =>
      CredentialsResetCommand.run(["TAVILY_SEARCH", "--yes"]),
    );

    expect(forgetCalls).toEqual(["TAVILY_SEARCH"]);
    expect(output.stdout).toContain("already absent");
    expect(output.stdout).toContain("Local state was cleaned up");
  });
});
