// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execa } from "execa";

import { buildSubprocessEnv } from "../lib/subprocess-env.js";

export interface BlueprintOpenShellCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BlueprintOpenShellCommandOptions {
  env?: Record<string, string>;
  gateway?: string;
  maxBuffer?: number;
  omitSandboxPolicy?: boolean;
  reject?: boolean;
  timeout?: number;
}

export type BlueprintOpenShellInspectionOptions = Readonly<{
  maxBuffer: number;
  timeout: number;
}>;

export type CaptureBlueprintOpenShellCommand = (
  args: string[],
  options?: BlueprintOpenShellCommandOptions,
) => Promise<BlueprintOpenShellCommandResult>;

export interface BlueprintSandboxCreateRequest {
  gatewayName: string;
  image: string;
  name: string;
  policyPath?: string;
  forwardPorts: readonly number[];
}

export interface BlueprintInferenceProviderCreateRequest {
  gatewayName: string;
  name: string;
  type: string;
  credential?: string;
  endpoint?: string;
}

export interface BlueprintInferenceRouteSetRequest {
  gatewayName: string;
  provider: string;
  model: string;
  timeoutSeconds?: number;
}

export interface RuntimeIdentityRefreshConfigureRequest {
  gatewayName: string;
  providerName: string;
  credentialKey: string;
  clientId: string;
  refreshTokenEnvironmentName: string;
  refreshToken: string;
  clientSecretEnvironmentName?: string;
  clientSecret?: string;
}

export interface BlueprintOpenShellCli {
  inspectActiveGateway(): Promise<BlueprintOpenShellCommandResult>;
  inspectGateway(
    gatewayName: string,
    options: BlueprintOpenShellInspectionOptions,
  ): Promise<BlueprintOpenShellCommandResult>;
  inspectGlobalPolicyHistory(
    gatewayName: string,
    options: BlueprintOpenShellInspectionOptions,
  ): Promise<BlueprintOpenShellCommandResult>;
  readActiveGlobalPolicy(
    gatewayName: string,
    options: BlueprintOpenShellInspectionOptions,
  ): Promise<BlueprintOpenShellCommandResult>;
  runPolicyCommand(
    command: string[],
    gatewayName: string,
    options?: Omit<BlueprintOpenShellCommandOptions, "gateway">,
  ): Promise<BlueprintOpenShellCommandResult>;
  inspectSandbox(
    gatewayName: string,
    sandboxName: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  createSandbox(request: BlueprintSandboxCreateRequest): Promise<BlueprintOpenShellCommandResult>;
  inspectProvider(
    gatewayName: string,
    providerName: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  createInferenceProvider(
    request: BlueprintInferenceProviderCreateRequest,
  ): Promise<BlueprintOpenShellCommandResult>;
  inspectInferenceRoute(gatewayName: string): Promise<BlueprintOpenShellCommandResult>;
  setInferenceRoute(
    request: BlueprintInferenceRouteSetRequest,
  ): Promise<BlueprintOpenShellCommandResult>;
  readGlobalSettings(gatewayName: string): Promise<BlueprintOpenShellCommandResult>;
  inspectProviderRefresh(
    gatewayName: string,
    providerName: string,
    credentialKey: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  deleteProvider(
    gatewayName: string,
    providerName: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  importProviderProfile(
    gatewayName: string,
    profilePath: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  exportProviderProfile(
    gatewayName: string,
    providerType: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  createRuntimeIdentityProvider(
    gatewayName: string,
    providerName: string,
    providerType: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  configureProviderRefresh(
    request: RuntimeIdentityRefreshConfigureRequest,
  ): Promise<BlueprintOpenShellCommandResult>;
  rotateProviderRefresh(
    gatewayName: string,
    providerName: string,
    credentialKey: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  attachProvider(
    gatewayName: string,
    sandboxName: string,
    providerName: string,
  ): Promise<BlueprintOpenShellCommandResult>;
  detachProvider(
    gatewayName: string,
    sandboxName: string,
    providerName: string,
  ): Promise<BlueprintOpenShellCommandResult>;
}

function buildBlueprintOpenShellEnv(
  gateway?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const env = buildSubprocessEnv(extra);
  if (gateway !== undefined) env.OPENSHELL_GATEWAY = gateway;
  delete env.OPENSHELL_GATEWAY_ENDPOINT;
  delete env.OPENSHELL_GATEWAY_INSECURE;
  return env;
}

async function runBlueprintOpenShellCommand(
  args: string[],
  options: BlueprintOpenShellCommandOptions = {},
): Promise<BlueprintOpenShellCommandResult> {
  const env = buildBlueprintOpenShellEnv(options.gateway, options.env);
  if (options.omitSandboxPolicy) delete env.OPENSHELL_SANDBOX_POLICY;
  const result = await execa(args[0], args.slice(1), {
    reject: options.reject ?? true,
    stdout: "pipe",
    stderr: "pipe",
    env,
    extendEnv: false,
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** OpenShell CLI implementation for the independently packaged blueprint plugin. */
export function createBlueprintOpenShellCli(deps?: {
  capture?: CaptureBlueprintOpenShellCommand;
}): BlueprintOpenShellCli {
  const capture = deps?.capture ?? runBlueprintOpenShellCommand;
  return {
    inspectActiveGateway: () => capture(["openshell", "status"], { reject: false }),
    inspectGateway: (gatewayName, options) =>
      capture(["openshell", "gateway", "info", "-g", gatewayName], {
        gateway: gatewayName,
        ...options,
        reject: false,
      }),
    inspectGlobalPolicyHistory: (gatewayName, options) =>
      capture(["openshell", "policy", "list", "-g", gatewayName, "--global", "--limit", "1"], {
        gateway: gatewayName,
        ...options,
        reject: false,
      }),
    readActiveGlobalPolicy: (gatewayName, options) =>
      capture(
        ["openshell", "policy", "get", "-g", gatewayName, "--global", "--full", "--output", "json"],
        { gateway: gatewayName, ...options, reject: false },
      ),
    runPolicyCommand: (command, gatewayName, options) =>
      capture(command, { ...options, gateway: gatewayName }),
    inspectSandbox: (gatewayName, sandboxName) =>
      capture(["openshell", "sandbox", "get", sandboxName], {
        gateway: gatewayName,
        reject: false,
      }),
    createSandbox: (request) => {
      const args = [
        "openshell",
        "sandbox",
        "create",
        "-g",
        request.gatewayName,
        "--from",
        request.image,
        "--name",
        request.name,
      ];
      if (request.policyPath) args.push("--policy", request.policyPath);
      for (const port of request.forwardPorts) args.push("--forward", String(port));
      return capture(args, {
        gateway: request.gatewayName,
        omitSandboxPolicy: true,
        reject: false,
      });
    },
    inspectProvider: (gatewayName, providerName) =>
      capture(["openshell", "provider", "get", providerName], {
        gateway: gatewayName,
        reject: false,
      }),
    createInferenceProvider: (request) => {
      const args = [
        "openshell",
        "provider",
        "create",
        "--name",
        request.name,
        "--type",
        request.type,
      ];
      const env: Record<string, string> = {};
      if (request.credential) {
        // OpenShell receives only the environment-variable name in argv. Keep
        // the credential scoped to this subprocess and out of diagnostics.
        env.OPENAI_API_KEY = request.credential;
        args.push("--credential", "OPENAI_API_KEY");
      }
      if (request.endpoint) args.push("--config", `OPENAI_BASE_URL=${request.endpoint}`);
      return capture(args, {
        gateway: request.gatewayName,
        env,
        reject: false,
      });
    },
    inspectInferenceRoute: (gatewayName) =>
      capture(["openshell", "inference", "get"], {
        gateway: gatewayName,
        reject: false,
      }),
    setInferenceRoute: (request) => {
      const args = [
        "openshell",
        "inference",
        "set",
        "--provider",
        request.provider,
        "--model",
        request.model,
      ];
      if (request.timeoutSeconds !== undefined) {
        args.push("--timeout", String(request.timeoutSeconds));
      }
      return capture(args, {
        gateway: request.gatewayName,
        reject: false,
      });
    },
    readGlobalSettings: (gatewayName) =>
      capture(["openshell", "settings", "get", "--global", "--json"], {
        gateway: gatewayName,
        reject: false,
      }),
    inspectProviderRefresh: (gatewayName, providerName, credentialKey) =>
      capture(
        [
          "openshell",
          "provider",
          "refresh",
          "status",
          providerName,
          "--credential-key",
          credentialKey,
        ],
        { gateway: gatewayName, reject: false },
      ),
    deleteProvider: (gatewayName, providerName) =>
      capture(["openshell", "provider", "delete", providerName], {
        gateway: gatewayName,
        reject: false,
      }),
    importProviderProfile: (gatewayName, profilePath) =>
      capture(["openshell", "provider", "profile", "import", "--file", profilePath], {
        gateway: gatewayName,
        reject: false,
      }),
    exportProviderProfile: (gatewayName, providerType) =>
      capture(["openshell", "provider", "profile", "export", providerType, "--output", "yaml"], {
        gateway: gatewayName,
        reject: false,
      }),
    createRuntimeIdentityProvider: (gatewayName, providerName, providerType) =>
      capture(
        [
          "openshell",
          "provider",
          "create",
          "--name",
          providerName,
          "--type",
          providerType,
          "--runtime-credentials",
        ],
        { gateway: gatewayName, reject: false },
      ),
    configureProviderRefresh: (request) => {
      const args = [
        "openshell",
        "provider",
        "refresh",
        "configure",
        request.providerName,
        "--credential-key",
        request.credentialKey,
        "--strategy",
        "oauth2-refresh-token",
        "--material",
        `client_id=${request.clientId}`,
        "--secret-material-env",
        `refresh_token=${request.refreshTokenEnvironmentName}`,
      ];
      const env: Record<string, string> = {
        [request.refreshTokenEnvironmentName]: request.refreshToken,
      };
      if (request.clientSecretEnvironmentName && request.clientSecret) {
        args.push("--secret-material-env", `client_secret=${request.clientSecretEnvironmentName}`);
        env[request.clientSecretEnvironmentName] = request.clientSecret;
      }
      return capture(args, {
        gateway: request.gatewayName,
        env,
        reject: false,
      });
    },
    rotateProviderRefresh: (gatewayName, providerName, credentialKey) =>
      capture(
        [
          "openshell",
          "provider",
          "refresh",
          "rotate",
          providerName,
          "--credential-key",
          credentialKey,
        ],
        { gateway: gatewayName, reject: false },
      ),
    attachProvider: (gatewayName, sandboxName, providerName) =>
      capture(["openshell", "sandbox", "provider", "attach", sandboxName, providerName], {
        gateway: gatewayName,
        reject: false,
      }),
    detachProvider: (gatewayName, sandboxName, providerName) =>
      capture(["openshell", "sandbox", "provider", "detach", sandboxName, providerName], {
        gateway: gatewayName,
        reject: false,
      }),
  };
}

export const blueprintOpenShellCli = createBlueprintOpenShellCli();
