// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";

const onboardProviderHelpers = require("../../src/lib/onboard/providers") as {
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: Record<string, string | undefined>,
    runOpenshell: DirectRunOpenshell,
  ) => { ok: boolean; status?: number; message?: string };
};
const localInferenceModule =
  require("../../src/lib/inference/local") as typeof import("../../src/lib/inference/local.js");

export type DirectCommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
};

type CreateSetupInference = (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
type DirectRunOpenshell = SetupInferenceDeps["runOpenshell"];
type DirectRunOptions = NonNullable<Parameters<DirectRunOpenshell>[1]>;
type DirectRunResult = ReturnType<DirectRunOpenshell>;

export type DirectRunStubResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

export type DirectSetupHarnessOptions = {
  runOpenshell?: (
    args: string[],
    options: DirectRunOptions,
    calls: DirectCommandEntry[],
  ) => DirectRunStubResult | undefined;
  overrides?: Partial<SetupInferenceDeps>;
};

type DirectCommandRoute = {
  name: string;
  matches(command: string): boolean;
  results: readonly [DirectRunStubResult | undefined, ...(DirectRunStubResult | undefined)[]];
};

export type ProductionOpenshellCommandRecord = {
  argv: string[];
  env: Record<string, string>;
};

export type ProductionSetupInferenceBoundaryResult = {
  commands: ProductionOpenshellCommandRecord[];
  credentialEvidence: {
    argvContainingSecret: string[];
    parentCredentialUnchanged: boolean;
    providerCommand: ProductionOpenshellCommandRecord;
    secretBearingCommands: string[];
    setupCredentialValues: Array<string | null>;
    unscopedCommandKinds: string[];
    unscopedCommandsContainingSecret: string[];
    unscopedCredentialValues: Array<string | null>;
  };
  setupCredentialAfter: string | null;
  setupCredentialBefore: string | null;
};

export function runProductionSetupInferenceCredentialBoundary(options: {
  credentialEnv: string;
  credentialValue: string;
  endpointUrl?: string | null;
  model: string;
  provider: string;
  timeoutMs?: number;
}): ProductionSetupInferenceBoundaryResult {
  const parentCredentialBefore = process.env[options.credentialEnv];
  const repoRoot = path.join(import.meta.dirname, "..", "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-setup-inference-boundary-"));
  const fakeBin = path.join(tmpDir, "bin");
  const openshellPath = path.join(fakeBin, "openshell");
  const commandLogPath = path.join(tmpDir, "openshell-commands.jsonl");
  const setupResultPath = path.join(tmpDir, "setup-result.json");
  const childScriptPath = path.join(tmpDir, "setup-inference-boundary.js");
  const onboardPath = path.join(repoRoot, "src", "lib", "onboard.ts");
  const sourceHookPath = path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs");

  try {
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      openshellPath,
      `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify({ argv, env: process.env }) + "\\n");
if (argv[0] === "inference" && argv[1] === "get") {
  process.stdout.write(${JSON.stringify(
    `Gateway inference:\n  Provider: ${options.provider}\n  Model: ${options.model}\n`,
  )});
}
process.exit(0);
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      childScriptPath,
      `const fs = require("node:fs");
const { setupInference } = require(${JSON.stringify(onboardPath)});
const credentialEnv = ${JSON.stringify(options.credentialEnv)};
const setupCredentialBefore = process.env[credentialEnv] || null;
(async () => {
  await setupInference(
    null,
    ${JSON.stringify(options.model)},
    ${JSON.stringify(options.provider)},
    ${JSON.stringify(options.endpointUrl ?? null)},
    credentialEnv,
  );
  fs.writeFileSync(
    ${JSON.stringify(setupResultPath)},
    JSON.stringify({
      setupCredentialBefore,
      setupCredentialAfter: process.env[credentialEnv] || null,
    }),
  );
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`,
    );

    const result = spawnSync(process.execPath, [childScriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15_000,
      env: {
        HOME: tmpDir,
        NODE_ENV: "test",
        NODE_OPTIONS: `--require=${sourceHookPath}`,
        NEMOCLAW_OPENSHELL_BIN: openshellPath,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TMPDIR: tmpDir,
        VITEST: "true",
        [options.credentialEnv]: options.credentialValue,
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Production setupInference boundary exited ${result.status}: ${result.stderr || result.stdout}`,
      );
    }

    const commands = fs
      .readFileSync(commandLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProductionOpenshellCommandRecord);
    const setupResult = JSON.parse(fs.readFileSync(setupResultPath, "utf8")) as Omit<
      ProductionSetupInferenceBoundaryResult,
      "commands" | "credentialEvidence"
    >;
    const commandKind = ({ argv }: ProductionOpenshellCommandRecord) => argv.slice(0, 2).join(" ");
    const providerCommand = commands.find(({ argv }) =>
      /^provider (create|update) /.test(argv.join(" ")),
    );
    if (!providerCommand) throw new Error("Production setupInference did not mutate a provider");
    const unscopedPatterns = [/^gateway select /, /^provider get /, /^inference set /];
    const unscopedCommands = unscopedPatterns
      .map((pattern) => commands.find(({ argv }) => pattern.test(argv.join(" "))))
      .filter((command): command is ProductionOpenshellCommandRecord => command !== undefined);
    const containsSecret = ({ env }: ProductionOpenshellCommandRecord) =>
      Object.values(env).some((value) => value.includes(options.credentialValue));
    const credentialEvidence = {
      argvContainingSecret: commands
        .filter(({ argv }) => argv.some((arg) => arg.includes(options.credentialValue)))
        .map(commandKind),
      parentCredentialUnchanged: process.env[options.credentialEnv] === parentCredentialBefore,
      providerCommand,
      secretBearingCommands: commands.filter(containsSecret).map(commandKind),
      setupCredentialValues: [setupResult.setupCredentialBefore, setupResult.setupCredentialAfter],
      unscopedCommandKinds: unscopedCommands.map(commandKind),
      unscopedCommandsContainingSecret: unscopedCommands.filter(containsSecret).map(commandKind),
      unscopedCredentialValues: unscopedCommands.map(
        ({ env }) => env[options.credentialEnv] ?? null,
      ),
    };
    return { commands, credentialEvidence, ...setupResult };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function withProcessEnv<T>(
  values: Record<string, string | undefined>,
  runTest: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await runTest();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function createDirectCommandRouter(routes: readonly DirectCommandRoute[]) {
  const callCounts = new Map<string, number>();
  const runOpenshell: NonNullable<DirectSetupHarnessOptions["runOpenshell"]> = (args) => {
    const command = args.join(" ");
    const route = routes.find((candidate) => candidate.matches(command));
    if (!route) return undefined;
    const callIndex = callCounts.get(route.name) ?? 0;
    callCounts.set(route.name, callIndex + 1);
    return route.results[Math.min(callIndex, route.results.length - 1)];
  };
  return {
    callCount: (name: string) => callCounts.get(name) ?? 0,
    runOpenshell,
  };
}

export function directRunResult({
  status = 0,
  stdout = "",
  stderr = "",
}: Partial<DirectRunStubResult> = {}): DirectRunResult {
  return {
    pid: 0,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

export function createDirectSetupInferenceHarnessFactory(
  createSetupInference: CreateSetupInference,
) {
  return function createDirectSetupInferenceHarness(options: DirectSetupHarnessOptions = {}) {
    const commands: DirectCommandEntry[] = [];
    const errors: string[] = [];
    const logs: string[] = [];
    const updateSandbox = vi.fn(() => true);
    const verifyInferenceRoute = vi.fn();
    const verifyOnboardInferenceSmoke = vi.fn();
    const runOpenshell: DirectRunOpenshell = (args, runOptions = {}) => {
      commands.push({
        command: args.join(" "),
        env: runOptions.env,
        ignoreError: runOptions.ignoreError,
      });
      return directRunResult(options.runOpenshell?.(args, runOptions, commands));
    };
    const setupInference = createSetupInference({
      step: () => {},
      getGatewayName: () => "nemoclaw",
      runOpenshell,
      upsertProvider: (
        name: string,
        type: string,
        credentialEnv: string,
        baseUrl: string | null,
        env: Record<string, string | undefined> = {},
      ) =>
        onboardProviderHelpers.upsertProvider(
          name,
          type,
          credentialEnv,
          baseUrl,
          env,
          runOpenshell,
        ),
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
      isNonInteractive: () => false,
      updateSandbox,
      resolveHermesNousApiKey: () => process.env.NOUS_API_KEY || null,
      checkHermesProviderStoreReachable: (run: DirectRunOpenshell) => {
        run(["provider", "list"], { ignoreError: true });
        return { ok: true };
      },
      hydrateCredentialEnv: (envName: string | null | undefined) =>
        envName ? process.env[envName] || null : null,
      promptValidationRecovery: async () => "selection",
      validateLocalProvider: () => ({ ok: true }),
      getLocalProviderHealthCheck: () => null,
      getLocalProviderBaseUrl: (provider: string) =>
        provider === "ollama-local"
          ? "http://host.openshell.internal:11435/v1"
          : "http://host.openshell.internal:8000/v1",
      applyLocalInferenceRoute: async () => false,
      run: () => directRunResult(),
      shouldFrontOllamaWithProxy: () => false,
      ensureOllamaAuthProxy: () => {},
      isProxyHealthy: () => true,
      getOllamaProxyToken: () => null,
      persistAndProbeOllamaProxy: async () => {},
      localInference: {
        ...localInferenceModule,
        validateOllamaModelWithToolsOverride: () => ({ ok: true }),
      },
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
      exitProcess: (code: number): never => {
        throw Object.assign(new Error(`EXIT_CALLED:${code}`), { code });
      },
      ...options.overrides,
    });
    return {
      commands,
      errors,
      logs,
      runOpenshell,
      setupInference,
      updateSandbox,
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
    };
  };
}
