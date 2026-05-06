// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const COMMAND_PATHS = {
  common: path.join(REPO_ROOT, "dist", "lib", "commands", "credentials", "common.js"),
  credentials: path.join(REPO_ROOT, "dist", "lib", "commands", "credentials.js"),
  list: path.join(REPO_ROOT, "dist", "lib", "commands", "credentials", "list.js"),
  reset: path.join(REPO_ROOT, "dist", "lib", "commands", "credentials", "reset.js"),
};
const GLOBAL_ACTIONS_PATH = path.join(REPO_ROOT, "dist", "lib", "global-cli-actions.js");
type CredentialsCommandClasses = {
  CredentialsCommand: typeof import("../dist/lib/commands/credentials.js").default;
  CredentialsListCommand: typeof import("../dist/lib/commands/credentials/list.js").default;
  CredentialsResetCommand: typeof import("../dist/lib/commands/credentials/reset.js").default;
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
  stdio?: unknown;
  ignoreError?: boolean;
  timeout?: number;
};
type RuntimeBridge = {
  recoverNamedGatewayRuntime: () => Promise<RuntimeRecovery>;
  runOpenshell: (args: string[], opts?: RuntimeBridgeRunOptions) => SpawnLikeResult;
};
type OpenshellCall = { args: string[]; opts?: RuntimeBridgeRunOptions };

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function loadCommands(): CredentialsCommandClasses {
  for (const modulePath of Object.values(COMMAND_PATHS)) {
    delete require.cache[modulePath];
  }
  return {
    CredentialsCommand: require(COMMAND_PATHS.credentials).default,
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

async function expectProcessExit(
  action: () => Promise<unknown>,
  expectedCode: number,
): Promise<void> {
  const originalExit = process.exit;
  process.exit = ((code?: string | number | null | undefined) => {
    throw new ProcessExitError(typeof code === "number" ? code : 1);
  }) as typeof process.exit;

  try {
    await action();
    throw new Error("Expected process.exit to be called");
  } catch (error) {
    if (!(error instanceof ProcessExitError)) throw error;
    expect(error.code).toBe(expectedCode);
  } finally {
    process.exit = originalExit;
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
    expect(output.stdout).toContain("list                  List provider credentials");
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
        opts: { ignoreError: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
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
      expectProcessExit(() => CredentialsListCommand.run([]), 1),
    );

    expect(output.stderr).toContain("Could not query OpenShell gateway");
    expect(output.stderr).toContain("openshell gateway start --name nemoclaw");
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
        opts: { ignoreError: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
      },
    ]);
    expect(output.stdout).toContain("Removed provider 'nvidia-prod'");
    expect(output.stdout).toContain("Re-run 'nemoclaw onboard'");
  });

  it("rejects per-sandbox messaging bridge names for credential reset", async () => {
    installRuntimeBridge();
    const { CredentialsResetCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectProcessExit(() => CredentialsResetCommand.run(["alpha-telegram-bridge", "--yes"]), 1),
    );

    expect(output.stderr).toContain("per-sandbox messaging bridge");
    expect(output.stderr).toContain("channels remove");
  });

  it("explains provider-name usage when reset receives an env var name", async () => {
    installRuntimeBridge({
      runOpenshell: () => ({ status: 1, stderr: "provider not found" }),
    });
    const { CredentialsResetCommand } = loadCommands();

    const output = await captureOutput(() =>
      expectProcessExit(() => CredentialsResetCommand.run(["NVIDIA_API_KEY", "--yes"]), 1),
    );

    expect(output.stderr).toContain("Could not remove provider 'NVIDIA_API_KEY'.");
    expect(output.stderr).toContain("looks like a credential env variable name");
    expect(output.stderr).toContain("provider not found");
  });
});
