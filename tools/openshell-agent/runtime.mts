// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";

const HOST_CREDENTIALS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "POST_MERGE_DOCS_API_KEY",
  "PR_REVIEW_ADVISOR_API_KEY",
] as const;

export interface OpenShellCommandOptions {
  capture?: boolean;
  env: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface OpenShellStartOptions {
  env: NodeJS.ProcessEnv;
  logPath: string;
}

export interface OpenShellTools {
  run: (command: string, args: readonly string[], options: OpenShellCommandOptions) => string;
  start: (command: string, args: readonly string[], options: OpenShellStartOptions) => void;
  wait: (milliseconds: number) => Promise<void>;
}

export type OpenShellInferenceOptions = {
  enableBindMounts?: boolean;
  gatewayId: string;
  modelId: string;
  providerName: string;
};

export type OpenShellUpload = {
  source: string;
  destination: string;
};

const INFERENCE_CONFIGURATION_ATTEMPTS = 6;

function inferenceConfigurationRetryDelay(
  env: NodeJS.ProcessEnv,
  input: OpenShellInferenceOptions,
  attempt: number,
): number {
  const identity = [
    input.modelId,
    env.PR_REVIEW_ADVISOR_INTEREST ?? "primary",
    env.SANDBOX_NAME ?? input.gatewayId,
  ].join(":");
  let hash = 0;
  for (const character of identity) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return 2000 * 2 ** attempt + (hash % 8000);
}

export type CreateOpenShellSandboxOptions = {
  command: readonly string[];
  driverConfig?: Readonly<Record<string, unknown>>;
  image: string;
  name: string;
  policyPath: string;
  uploads: readonly OpenShellUpload[];
};

export type ExecOpenShellSandboxOptions = {
  command: readonly string[];
  environment?: Readonly<Record<string, string>>;
  name: string;
  timeoutSeconds?: number;
  workdir?: string;
};

export class OpenShellAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenShellAgentError";
  }
}

export function required(value: string | undefined, name: string): string {
  if (!value) throw new OpenShellAgentError(`${name} is required`);
  return value;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function gatewayConfiguration(input: {
  bindAddress: string;
  directory: string;
  enableBindMounts: boolean;
  gatewayId: string;
  supervisor: string;
}): string {
  const bindMountConfiguration = input.enableBindMounts ? "\nenable_bind_mounts = true" : "";
  return `[openshell]
version = 1

[openshell.gateway]
bind_address = ${tomlString(input.bindAddress)}
compute_drivers = ["docker"]
disable_tls = true

[openshell.gateway.auth]
allow_unauthenticated_users = true

[openshell.gateway.gateway_jwt]
signing_key_path = ${tomlString(path.join(input.directory, "jwt", "signing.pem"))}
public_key_path = ${tomlString(path.join(input.directory, "jwt", "public.pem"))}
kid_path = ${tomlString(path.join(input.directory, "jwt", "kid"))}
gateway_id = ${tomlString(input.gatewayId)}
ttl_secs = 3600

[openshell.drivers.docker]
grpc_endpoint = "http://host.openshell.internal:8080"
supervisor_bin = ${tomlString(input.supervisor)}${bindMountConfiguration}
`;
}

function loopbackBindAddress(endpoint: URL): string {
  if (!["127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    throw new OpenShellAgentError("OPENSHELL_GATEWAY_ENDPOINT must use a loopback address");
  }
  return endpoint.host;
}

function validateIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)) {
    throw new OpenShellAgentError(`${name} contains unsupported characters`);
  }
}

export function openshellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = required(env.HOME, "HOME");
  const binaryDirectory = env.XDG_BIN_HOME ?? path.join(home, ".local", "bin");
  return {
    ...env,
    PATH: [binaryDirectory, env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  };
}

export function credentialFreeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = openshellEnvironment(env);
  for (const name of HOST_CREDENTIALS) delete result[name];
  return result;
}

export const defaultOpenShellTools: OpenShellTools = {
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
  input: OpenShellInferenceOptions,
  tools: OpenShellTools = defaultOpenShellTools,
): Promise<void> {
  validateIdentifier(input.gatewayId, "gatewayId");
  validateIdentifier(input.modelId, "modelId");
  validateIdentifier(input.providerName, "providerName");

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
      enableBindMounts: input.enableBindMounts === true,
      gatewayId: input.gatewayId,
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
      input.providerName,
      "--type",
      "openai",
      "--credential",
      "OPENAI_API_KEY",
      "--config",
      "OPENAI_BASE_URL=https://inference-api.nvidia.com/v1",
    ],
    { env: providerEnv },
  );
  const inferenceArgs = [
    "inference",
    "set",
    "--provider",
    input.providerName,
    "--model",
    input.modelId,
    "--timeout",
    "900",
  ] as const;
  for (let attempt = 0; attempt < INFERENCE_CONFIGURATION_ATTEMPTS; attempt += 1) {
    try {
      tools.run("openshell", inferenceArgs, { env: commandEnv });
      return;
    } catch (error) {
      if (attempt === INFERENCE_CONFIGURATION_ATTEMPTS - 1) throw error;
      await tools.wait(inferenceConfigurationRetryDelay(env, input, attempt));
    }
  }
}

export function createOpenShellSandbox(
  env: NodeJS.ProcessEnv,
  input: CreateOpenShellSandboxOptions,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  const uploadArgs = input.uploads.flatMap(({ source, destination }) => [
    "--upload",
    `${source}:${destination}`,
  ]);
  const uploadOptions = input.uploads.length > 0 ? [...uploadArgs, "--no-git-ignore"] : [];
  const driverConfigArgs = input.driverConfig
    ? ["--driver-config-json", JSON.stringify(input.driverConfig)]
    : [];
  tools.run(
    "openshell",
    [
      "sandbox",
      "create",
      "--name",
      input.name,
      "--from",
      input.image,
      ...driverConfigArgs,
      "--policy",
      input.policyPath,
      ...uploadOptions,
      "--no-tty",
      "--",
      ...input.command,
    ],
    { env: credentialFreeEnvironment(env) },
  );
}

export function execOpenShellSandbox(
  env: NodeJS.ProcessEnv,
  input: ExecOpenShellSandboxOptions,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  const workdirArgs = input.workdir ? ["--workdir", input.workdir] : [];
  const timeoutArgs = input.timeoutSeconds ? ["--timeout", String(input.timeoutSeconds)] : [];
  const environmentArgs = Object.entries(input.environment ?? {}).flatMap(([name, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || /[\0\r\n]/u.test(value)) {
      throw new OpenShellAgentError(`Unsafe sandbox environment entry: ${name}`);
    }
    return ["--env", `${name}=${value}`];
  });
  tools.run(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      input.name,
      ...timeoutArgs,
      ...workdirArgs,
      ...environmentArgs,
      "--",
      ...input.command,
    ],
    { env: credentialFreeEnvironment(env) },
  );
}

export function downloadOpenShellPath(
  env: NodeJS.ProcessEnv,
  input: { destination: string; name: string; source: string },
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  tools.run("openshell", ["sandbox", "download", input.name, input.source, input.destination], {
    env: credentialFreeEnvironment(env),
  });
}

export function setOpenShellSandboxPolicy(
  env: NodeJS.ProcessEnv,
  input: { name: string; policyPath: string },
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  tools.run("openshell", ["policy", "set", "--policy", input.policyPath, "--wait", input.name], {
    env: credentialFreeEnvironment(env),
  });
}

export function deleteOpenShellSandbox(
  env: NodeJS.ProcessEnv,
  name: string,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  const commandEnv = credentialFreeEnvironment(env);
  let names: string | undefined;
  let listFailure: unknown;
  try {
    names = tools.run("openshell", ["sandbox", "list", "--names"], {
      capture: true,
      env: commandEnv,
    });
  } catch (error) {
    listFailure = error;
  }
  if (listFailure !== undefined || names?.split(/\r?\n/u).includes(name)) {
    try {
      tools.run("openshell", ["sandbox", "delete", name], { env: commandEnv });
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      const listDiagnostic =
        listFailure === undefined
          ? ""
          : `; sandbox listing also failed: ${listFailure instanceof Error ? listFailure.message : String(listFailure)}`;
      throw new OpenShellAgentError(
        `Failed to delete OpenShell sandbox ${name}: ${diagnostic}${listDiagnostic}`,
      );
    }
  }
}
