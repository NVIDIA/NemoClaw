// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OnboardCommandOptions {
  nonInteractive: boolean;
  resume: boolean;
  fresh: boolean;
  recreateSandbox: boolean;
  fromDockerfile: string | null;
  acceptThirdPartySoftware: boolean;
  agent: string | null;
  dangerouslySkipPermissions: boolean;
  controlUiPort: number | null;
  sandboxName: string | null;
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

const ONBOARD_BASE_ARGS = [
  "--non-interactive",
  "--resume",
  "--fresh",
  "--recreate-sandbox",
  "--dangerously-skip-permissions",
];

function onboardUsageLines(noticeAcceptFlag: string): string[] {
  return [
    `  Usage: nemoclaw onboard [--non-interactive] [--resume | --fresh] [--recreate-sandbox] [--from <Dockerfile>] [--name <sandbox-name>] [--agent <name>] [--control-ui-port <N>] [--dangerously-skip-permissions] [${noticeAcceptFlag}]`,
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
    fromDockerfile = parsedArgs[fromIdx + 1] || null;
    if (!fromDockerfile || fromDockerfile.startsWith("--")) {
      error("  --from requires a path to a Dockerfile");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    parsedArgs.splice(fromIdx, 2);
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

  // --name <sandbox-name> — surface NEMOCLAW_SANDBOX_NAME via a discoverable
  // CLI flag. Detailed validation (lowercase, leading-letter, hyphen rules,
  // reserved-name list) still happens later in promptValidatedSandboxName;
  // here we only reject the obviously-broken cases so the flag fails fast.
  // See #2543.
  let sandboxName: string | null = null;
  const nameIdx = parsedArgs.indexOf("--name");
  if (nameIdx !== -1) {
    const nameValue = parsedArgs[nameIdx + 1];
    if (typeof nameValue !== "string" || nameValue.startsWith("--") || nameValue.length === 0) {
      error("  --name requires a sandbox name");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    sandboxName = nameValue;
    parsedArgs.splice(nameIdx, 2);
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
    acceptThirdPartySoftware:
      parsedArgs.includes(noticeAcceptFlag) || String(deps.env[noticeAcceptEnv] || "") === "1",
    agent,
    dangerouslySkipPermissions: parsedArgs.includes("--dangerously-skip-permissions"),
    controlUiPort,
    sandboxName,
  };
}

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const log = deps.log ?? console.log;
  if (deps.args.includes("--help") || deps.args.includes("-h")) {
    printOnboardUsage(log, deps.noticeAcceptFlag);
    return;
  }

  const options = parseOnboardArgs(deps.args, deps.noticeAcceptFlag, deps.noticeAcceptEnv, deps);
  // --name <foo> piggybacks on the existing NEMOCLAW_SANDBOX_NAME env-var
  // path that promptValidatedSandboxName already honors in non-interactive
  // mode and uses as the prompt default in interactive mode. Setting the
  // env var here keeps the wizard's validation/reserved-name checks intact
  // while making the name discoverable from `nemoclaw onboard --help`.
  // See #2543.
  if (options.sandboxName) {
    deps.env.NEMOCLAW_SANDBOX_NAME = options.sandboxName;
  }
  await deps.runOnboard(options);
}

export async function runDeprecatedOnboardAliasCommand(
  deps: RunDeprecatedOnboardAliasCommandDeps,
): Promise<void> {
  const log = deps.log ?? console.log;
  log("");
  if (deps.kind === "setup") {
    log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  } else {
    log("  ⚠  `nemoclaw setup-spark` is deprecated.");
    log("  Current OpenShell releases handle the old DGX Spark cgroup issue themselves.");
    log("  Use `nemoclaw onboard` instead.");
  }
  log("");
  await runOnboardCommand(deps);
}
