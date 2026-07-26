#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type ConflictMatrixEntry, parseConflictMatrixEntry } from "./discover.mts";
import { ConflictFixerError, prepareMerge, samePaths } from "./merge.mts";

export const RESOLVER_MODEL_ID = "azure/openai/gpt-5.6-terra";

const HOST_CREDENTIALS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "PR_REVIEW_ADVISOR_API_KEY",
] as const;
const PI_COMMAND = [
  "/usr/bin/node",
  "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  "--provider",
  "openshell",
  "--model",
  RESOLVER_MODEL_ID,
  "--thinking",
  "medium",
  "--tools",
  "read,bash,edit,write,grep,find,ls",
  "--no-context-files",
  "--no-extensions",
  "--no-prompt-templates",
  "--no-session",
  "--no-skills",
  "--no-themes",
  "--offline",
  "--print",
  "@/sandbox/pi-config/task.txt",
] as const;
const EXPORT_PATCH_COMMAND = `
set -euo pipefail
if test -n "$(git ls-files -u)"; then
  echo "Pi did not stage every resolved conflict." >&2
  exit 1
fi
final_tree="$(git write-tree)"
git diff --binary "$CONFLICT_TREE" "$final_tree" > /sandbox/resolution.patch
`.trim();

export interface ResolverCommandOptions {
  capture?: boolean;
  env: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface ResolverStartOptions {
  env: NodeJS.ProcessEnv;
  logPath: string;
}

export interface ResolverTools {
  run: (command: string, args: readonly string[], options: ResolverCommandOptions) => string;
  start: (command: string, args: readonly string[], options: ResolverStartOptions) => void;
  wait: (milliseconds: number) => Promise<void>;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConflictFixerError(`${name} is required`);
  return value;
}

export function resolverModelConfiguration(): string {
  return `${JSON.stringify(
    {
      providers: {
        openshell: {
          api: "openai-completions",
          apiKey: "unused",
          baseUrl: "https://inference.local/v1",
          compat: {
            maxTokensField: "max_tokens",
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsStore: false,
            supportsStrictMode: false,
            supportsUsageInStreaming: false,
          },
          models: [
            {
              contextWindow: 256000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: RESOLVER_MODEL_ID,
              input: ["text"],
              maxTokens: 32768,
              name: "GPT-5.6 Terra",
              reasoning: false,
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

function gatewayConfiguration(input: {
  bindAddress: string;
  directory: string;
  supervisor: string;
}): string {
  return `[openshell]
version = 1

[openshell.gateway]
bind_address = "${input.bindAddress}"
compute_drivers = ["docker"]
disable_tls = true

[openshell.gateway.auth]
allow_unauthenticated_users = true

[openshell.gateway.gateway_jwt]
signing_key_path = "${path.join(input.directory, "jwt", "signing.pem")}"
public_key_path = "${path.join(input.directory, "jwt", "public.pem")}"
kid_path = "${path.join(input.directory, "jwt", "kid")}"
gateway_id = "pr-conflict-fixer"
ttl_secs = 3600

[openshell.drivers.docker]
grpc_endpoint = "http://host.openshell.internal:8080"
supervisor_bin = "${input.supervisor}"
`;
}

export function resolverPrompt(): string {
  return [
    "Resolve the Git merge conflicts in this repository.",
    "The repository is merging main into a pull request head.",
    "Preserve the intended behavior from both parents.",
    "Do not make unrelated changes.",
    "Use Git to inspect the merge state.",
    "Stage every resolved conflict with Git.",
    "Do not create a commit.",
  ].join("\n");
}

export function prepareResolutionWorkspace(input: {
  configDirectory: string;
  entry: ConflictMatrixEntry;
  sourceRepository: string;
  workDirectory: string;
}): string {
  const merge = prepareMerge(
    input.sourceRepository,
    input.workDirectory,
    input.entry.head_sha,
    input.entry.base_sha,
  );
  if (!merge) throw new ConflictFixerError("The recorded PR no longer conflicts with the base SHA");
  if (!samePaths(merge.conflictPaths, input.entry.conflict_paths)) {
    throw new ConflictFixerError("The conflict paths do not match the scan result");
  }

  mkdirSync(input.configDirectory, { recursive: true });
  writeFileSync(path.join(input.configDirectory, "models.json"), resolverModelConfiguration(), {
    mode: 0o600,
  });
  writeFileSync(path.join(input.configDirectory, "task.txt"), `${resolverPrompt()}\n`, {
    mode: 0o600,
  });
  return merge.conflictTree;
}

function openshellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = required(env.HOME, "HOME");
  const binaryDirectory = env.XDG_BIN_HOME ?? path.join(home, ".local", "bin");
  return {
    ...env,
    PATH: [binaryDirectory, env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  };
}

function credentialFreeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = openshellEnvironment(env);
  for (const name of HOST_CREDENTIALS) delete result[name];
  return result;
}

function loopbackBindAddress(endpoint: URL): string {
  if (!["127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    throw new ConflictFixerError("OPENSHELL_GATEWAY_ENDPOINT must use a loopback address");
  }
  return endpoint.host;
}

const defaultTools: ResolverTools = {
  run(command, args, options): string {
    const output = execFileSync(command, [...args], {
      encoding: "utf8",
      env: options.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      timeout: options.timeout,
    });
    return String(output ?? "").trim();
  },
  start(command, args, options): void {
    const log = openSync(options.logPath, "w", 0o600);
    try {
      const child = spawn(command, [...args], {
        detached: true,
        env: options.env,
        stdio: ["ignore", log, log],
      });
      child.on("error", () => undefined);
      child.unref();
    } finally {
      closeSync(log);
    }
  },
  wait(milliseconds): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
};

export async function configureOpenShellInference(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultTools,
): Promise<void> {
  const providerApiKey = required(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  const commandEnv = credentialFreeEnvironment(env);
  const providerEnv = { ...commandEnv, OPENAI_API_KEY: providerApiKey };
  const gatewayDirectory = path.join(required(env.RUNNER_TEMP, "RUNNER_TEMP"), "openshell-gateway");
  const gatewayEndpoint = new URL(
    required(env.OPENSHELL_GATEWAY_ENDPOINT, "OPENSHELL_GATEWAY_ENDPOINT"),
  );
  const bindAddress = loopbackBindAddress(gatewayEndpoint);
  const supervisor = required(
    tools.run("which", ["openshell-sandbox"], { capture: true, env: commandEnv }),
    "openshell-sandbox",
  );
  mkdirSync(gatewayDirectory, { recursive: true });
  tools.run("openshell-gateway", ["generate-certs", "--output-dir", gatewayDirectory], {
    env: commandEnv,
  });
  const configurationPath = path.join(gatewayDirectory, "gateway.toml");
  writeFileSync(
    configurationPath,
    gatewayConfiguration({
      bindAddress,
      directory: gatewayDirectory,
      supervisor,
    }),
    { mode: 0o600 },
  );
  tools.start("openshell-gateway", ["--config", configurationPath], {
    env: commandEnv,
    logPath: path.join(gatewayDirectory, "gateway.log"),
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      tools.run("openshell", ["gateway", "info"], { env: commandEnv, timeout: 10_000 });
      break;
    } catch {
      await tools.wait(1000);
    }
  }
  tools.run("openshell", ["gateway", "info"], { env: commandEnv, timeout: 10_000 });
  tools.run(
    "openshell",
    [
      "provider",
      "create",
      "--name",
      "terra",
      "--type",
      "openai",
      "--credential",
      "OPENAI_API_KEY",
      "--config",
      "OPENAI_BASE_URL=https://inference-api.nvidia.com/v1",
    ],
    { env: providerEnv },
  );
  tools.run(
    "openshell",
    ["inference", "set", "--provider", "terra", "--model", RESOLVER_MODEL_ID, "--timeout", "900"],
    { env: commandEnv },
  );
}

export function createResolutionSandbox(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultTools,
): void {
  tools.run(
    "openshell",
    [
      "sandbox",
      "create",
      "--name",
      required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      "--from",
      required(env.PI_IMAGE, "PI_IMAGE"),
      "--policy",
      path.join(
        required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
        "tools",
        "pr-merge-conflict-fixer",
        "policy.yaml",
      ),
      "--upload",
      `${required(env.RESOLUTION_WORKDIR, "RESOLUTION_WORKDIR")}:/sandbox`,
      "--upload",
      `${required(env.RESOLVER_CONFIG_DIR, "RESOLVER_CONFIG_DIR")}:/sandbox`,
      "--no-git-ignore",
      "--no-tty",
      "--",
      "/usr/bin/git",
      "-C",
      "/sandbox/repo",
      "status",
      "--short",
    ],
    { env: credentialFreeEnvironment(env) },
  );
}

export function runResolutionTask(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultTools,
): void {
  tools.run(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      "--timeout",
      "1200",
      "--workdir",
      "/sandbox/repo",
      "--env",
      "HOME=/sandbox",
      "--env",
      "PI_CODING_AGENT_DIR=/sandbox/pi-config",
      "--env",
      "PI_OFFLINE=1",
      "--env",
      "TMPDIR=/sandbox",
      "--",
      ...PI_COMMAND,
    ],
    { env: credentialFreeEnvironment(env) },
  );
}

export function exportResolutionPatch(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultTools,
): void {
  const commandEnv = credentialFreeEnvironment(env);
  const sandboxName = required(env.SANDBOX_NAME, "SANDBOX_NAME");
  tools.run(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--workdir",
      "/sandbox/repo",
      "--env",
      `CONFLICT_TREE=${required(env.CONFLICT_TREE, "CONFLICT_TREE")}`,
      "--",
      "/usr/bin/bash",
      "-c",
      EXPORT_PATCH_COMMAND,
    ],
    { env: commandEnv },
  );
  const artifactDirectory = required(env.ARTIFACT_DIR, "ARTIFACT_DIR");
  mkdirSync(artifactDirectory, { recursive: true });
  tools.run(
    "openshell",
    ["sandbox", "download", sandboxName, "/sandbox/resolution.patch", `${artifactDirectory}/`],
    { env: commandEnv },
  );
}

export function deleteResolutionSandbox(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultTools,
): void {
  const commandEnv = credentialFreeEnvironment(env);
  const sandboxName = required(env.SANDBOX_NAME, "SANDBOX_NAME");
  let names: string;
  try {
    names = tools.run("openshell", ["sandbox", "list", "--names"], {
      capture: true,
      env: commandEnv,
    });
  } catch {
    return;
  }
  if (names.split(/\r?\n/u).includes(sandboxName)) {
    tools.run("openshell", ["sandbox", "delete", sandboxName], { env: commandEnv });
  }
}

function prepare(env: NodeJS.ProcessEnv): void {
  const entry = parseConflictMatrixEntry(required(env.MATRIX_ENTRY, "MATRIX_ENTRY"));
  const conflictTree = prepareResolutionWorkspace({
    configDirectory: required(env.RESOLVER_CONFIG_DIR, "RESOLVER_CONFIG_DIR"),
    entry,
    sourceRepository: required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
    workDirectory: required(env.RESOLUTION_WORKDIR, "RESOLUTION_WORKDIR"),
  });
  appendFileSync(required(env.GITHUB_OUTPUT, "GITHUB_OUTPUT"), `conflict_tree=${conflictTree}\n`);
}

async function main(): Promise<void> {
  const command = required(process.argv[2], "resolve command");
  switch (command) {
    case "prepare":
      prepare(process.env);
      return;
    case "configure":
      await configureOpenShellInference(process.env);
      return;
    case "create":
      createResolutionSandbox(process.env);
      return;
    case "run":
      runResolutionTask(process.env);
      return;
    case "export":
      exportResolutionPatch(process.env);
      return;
    case "delete":
      deleteResolutionSandbox(process.env);
      return;
    default:
      throw new ConflictFixerError(`Unsupported resolve command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
