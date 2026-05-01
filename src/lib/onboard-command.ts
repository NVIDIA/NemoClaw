// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { CLI_NAME } from "./branding";

export interface OnboardCommandOptions {
  nonInteractive: boolean;
  resume: boolean;
  fresh: boolean;
  recreateSandbox: boolean;
  fromDockerfile: string | null;
  sandboxName: string | null;
  acceptThirdPartySoftware: boolean;
  agent: string | null;
  controlUiPort: number | null;
}

export interface RunOnboardCommandDeps {
  args: string[];
  noticeAcceptFlag: string;
  noticeAcceptEnv: string;
  env: NodeJS.ProcessEnv;
  runOnboard: (options: OnboardCommandOptions) => Promise<void>;
  listAgents?: () => string[];
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export interface RunDeprecatedOnboardAliasCommandDeps extends RunOnboardCommandDeps {
  kind: "setup" | "setup-spark";
}

const ONBOARD_BASE_ARGS = ["--non-interactive", "--resume", "--fresh", "--recreate-sandbox"];

function onboardUsageLines(noticeAcceptFlag: string): string[] {
  const name = CLI_NAME;
  return [
    `  Usage: ${name} onboard [--non-interactive] [--resume | --fresh] [--recreate-sandbox] [--from <Dockerfile>] [--name <sandbox>] [--agent <name>] [--control-ui-port <N>] [${noticeAcceptFlag}]`,
    "",
    "  --from <Dockerfile> uses the Dockerfile's parent directory as the Docker build context.",
    "  Put files referenced by COPY/ADD next to that Dockerfile, or move the Dockerfile into",
    "  a dedicated build directory to avoid sending unrelated files to Docker.",
    "  Common large directories are skipped: node_modules, .git, .venv, __pycache__.",
    "  Credential-style files and directories such as .env*, .ssh, .aws, .netrc, .npmrc, secrets/, *.pem, and *.key are also skipped.",
    "  Generated output directories such as dist/, build/, and target/ are still included.",
    "",
  ];
}

function printOnboardUsage(writer: (message?: string) => void, noticeAcceptFlag: string): void {
  for (const line of onboardUsageLines(noticeAcceptFlag)) {
    writer(line);
  }
}

export function parseOnboardArgs(
  args: string[],
  noticeAcceptFlag: string,
  noticeAcceptEnv: string,
  deps: Pick<RunOnboardCommandDeps, "env" | "error" | "exit" | "listAgents">,
): OnboardCommandOptions {
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const parsedArgs = [...args];

  let fromDockerfile: string | null = null;
  const fromIdx = parsedArgs.indexOf("--from");
  if (fromIdx !== -1) {
    const requestedFromDockerfile = parsedArgs[fromIdx + 1];
    if (!requestedFromDockerfile || requestedFromDockerfile.startsWith("--")) {
      error("  --from requires a path to a Dockerfile");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    const resolvedFromDockerfile = path.resolve(requestedFromDockerfile);
    if (!fs.existsSync(resolvedFromDockerfile)) {
      error(`  --from path not found: ${resolvedFromDockerfile}`);
      exit(1);
    }
    if (!fs.statSync(resolvedFromDockerfile).isFile()) {
      error(`  --from must point to a Dockerfile: ${resolvedFromDockerfile}`);
      exit(1);
    }
    fromDockerfile = requestedFromDockerfile;
    parsedArgs.splice(fromIdx, 2);
  }

  let sandboxName: string | null = null;
  const nameIdx = parsedArgs.indexOf("--name");
  if (nameIdx !== -1) {
    const nameValue = parsedArgs[nameIdx + 1];
    if (typeof nameValue !== "string" || nameValue.length === 0 || nameValue.startsWith("--")) {
      error("  --name requires a sandbox name");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    sandboxName = nameValue;
    parsedArgs.splice(nameIdx, 2);
  }

  let agent: string | null = null;
  const agentIdx = parsedArgs.indexOf("--agent");
  if (agentIdx !== -1) {
    const agentValue = parsedArgs[agentIdx + 1];
    if (typeof agentValue !== "string" || agentValue.startsWith("--")) {
      error("  --agent requires a name");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    const knownAgents = deps.listAgents?.() ?? [];
    if (knownAgents.length > 0 && !knownAgents.includes(agentValue)) {
      error(`  Unknown agent '${agentValue}'. Available: ${knownAgents.join(", ")}`);
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    agent = agentValue;
    parsedArgs.splice(agentIdx, 2);
  }

  let controlUiPort: number | null = null;
  const portIdx = parsedArgs.indexOf("--control-ui-port");
  if (portIdx !== -1) {
    const portValue = parsedArgs[portIdx + 1];
    if (typeof portValue !== "string" || portValue.startsWith("--")) {
      error("  --control-ui-port requires a port number");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    const parsed = Number(portValue);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      error(`  --control-ui-port: ${portValue} is not a valid port (1024-65535)`);
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    controlUiPort = parsed;
    parsedArgs.splice(portIdx, 2);
  }

  const allowedArgs = new Set([...ONBOARD_BASE_ARGS, noticeAcceptFlag]);
  const unknownArgs = parsedArgs.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    printOnboardUsage(error, noticeAcceptFlag);
    exit(1);
  }

  const resume = parsedArgs.includes("--resume");
  const fresh = parsedArgs.includes("--fresh");
  if (resume && fresh) {
    error("  --resume and --fresh are mutually exclusive.");
    printOnboardUsage(error, noticeAcceptFlag);
    exit(1);
  }

  return {
    nonInteractive: parsedArgs.includes("--non-interactive"),
    resume,
    fresh,
    recreateSandbox: parsedArgs.includes("--recreate-sandbox"),
    fromDockerfile,
    sandboxName,
    acceptThirdPartySoftware:
      parsedArgs.includes(noticeAcceptFlag) || String(deps.env[noticeAcceptEnv] || "") === "1",
    agent,
    controlUiPort,
  };
}

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const log = deps.log ?? console.log;
  if (deps.args.includes("--help") || deps.args.includes("-h")) {
    printOnboardUsage(log, deps.noticeAcceptFlag);
    return;
  }

  const options = parseOnboardArgs(deps.args, deps.noticeAcceptFlag, deps.noticeAcceptEnv, deps);
  await deps.runOnboard(options);
}

export async function runDeprecatedOnboardAliasCommand(
  deps: RunDeprecatedOnboardAliasCommandDeps,
): Promise<void> {
  const cliName = CLI_NAME;
  const log = deps.log ?? console.log;
  log("");
  if (deps.kind === "setup") {
    log(`  ⚠  \`${cliName} setup\` is deprecated. Use \`${cliName} onboard\` instead.`);
  } else {
    log(`  ⚠  \`${cliName} setup-spark\` is deprecated.`);
    log("  Current OpenShell releases handle the old DGX Spark cgroup issue themselves.");
    log(`  Use \`${cliName} onboard\` instead.`);
  }
  log("");
  await runOnboardCommand(deps);
}
