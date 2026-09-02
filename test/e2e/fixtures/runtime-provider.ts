// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "./shell-probe.ts";

export type RuntimeProviderSkip = (reason: string) => never;

export type E2eRuntimeProviderId = "docker" | "podman";

const SANITIZED_PRIVILEGED_ENVIRONMENT = [
  "BASH_ENV=",
  "ENV=",
  "GCONV_PATH=",
  "GLIBC_TUNABLES=",
  "LD_AUDIT=",
  "LD_LIBRARY_PATH=",
  "LD_PRELOAD=",
  "LOCPATH=",
  "NODE_OPTIONS=",
  "PERL5OPT=",
  "PYTHONHOME=",
  "PYTHONINSPECT=",
  "PYTHONNOUSERSITE=1",
  "PYTHONPATH=",
  "PYTHONSTARTUP=",
  "PYTHONUSERBASE=",
  "RUBYOPT=",
] as const;

const SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;

interface RuntimeProviderInvocation {
  readonly argsPrefix: readonly string[];
  readonly command: E2eRuntimeProviderId;
  readonly displayName: "Docker" | "Podman";
  readonly id: E2eRuntimeProviderId;
}

export interface E2eRuntimeProviderCommand {
  readonly args: readonly string[];
  readonly command: E2eRuntimeProviderId;
}

function configuredRuntimeProviderInvocation(
  environment: NodeJS.ProcessEnv,
): RuntimeProviderInvocation {
  const portable = environment.NEMOCLAW_EXPERIMENTAL_PROFILE === "portable";
  const configured = environment.NEMOCLAW_GATEWAY_RUNTIME?.trim() || "docker";
  if (configured !== "docker" && configured !== "podman") {
    throw new Error(`unsupported E2E gateway runtime: ${configured}`);
  }

  const providerId = portable ? "docker" : configured;
  if (providerId === "docker") {
    return {
      argsPrefix: [],
      command: "docker",
      displayName: "Docker",
      id: providerId,
    };
  }

  const socketPath = environment.OPENSHELL_PODMAN_SOCKET?.trim();
  if (
    !socketPath ||
    !path.isAbsolute(socketPath) ||
    path.normalize(socketPath) !== socketPath ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(socketPath)
  ) {
    throw new Error("native Podman E2E requires one absolute provider-owned socket path");
  }
  return {
    argsPrefix: ["--url", `unix://${socketPath}`],
    command: "podman",
    displayName: "Podman",
    id: providerId,
  };
}

export class RuntimeProviderPrerequisite {
  readonly displayName: "Docker" | "Podman";
  readonly id: E2eRuntimeProviderId;
  private readonly invocation: RuntimeProviderInvocation;

  constructor(
    private readonly host: HostCliClient,
    private readonly skip: RuntimeProviderSkip,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.invocation = configuredRuntimeProviderInvocation(environment);
    this.displayName = this.invocation.displayName;
    this.id = this.invocation.id;
  }

  command(args: readonly string[], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    const invocation = this.hostInvocation(args);
    return this.host.command(invocation.command, [...invocation.args], {
      env: buildAvailabilityProbeEnv(this.environment),
      ...options,
    });
  }

  hostInvocation(args: readonly string[]): E2eRuntimeProviderCommand {
    return Object.freeze({
      command: this.invocation.command,
      args: Object.freeze([...this.invocation.argsPrefix, ...args]),
    });
  }

  async requireAvailable(options: { artifactName: string; scenarioLabel: string }): Promise<void> {
    const result = await this.command(["info"], {
      artifactName: options.artifactName,
      timeoutMs: 30_000,
    });
    if (result.exitCode === 0) return;

    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const reason = `${this.displayName} is required for ${options.scenarioLabel} live E2E: ${detail}`;
    if (process.env.GITHUB_ACTIONS === "true") throw new Error(reason);
    this.skip(reason);
  }

  async resolveSandboxResourceHandle(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<string> {
    const result = await this.command(
      [
        "container",
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${SANDBOX_NAME_LABEL}=${sandboxName}`,
        "--format",
        "{{.ID}}",
      ],
      options,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `${this.displayName} sandbox resource discovery failed for '${sandboxName}': ${[
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n")}`,
      );
    }
    const handles = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);
    if (handles.length !== 1 || !CONTAINER_ID.test(handles[0] ?? "")) {
      throw new Error(
        `${this.displayName} sandbox '${sandboxName}' resolved ${String(handles.length)} runtime resources; expected exactly one.`,
      );
    }
    return handles[0] as string;
  }

  async execSandboxAsRoot(
    sandboxName: string,
    args: readonly string[],
    options: ShellProbeRunOptions & { sanitizeEnvironment?: boolean } = {},
  ): Promise<ShellProbeResult> {
    const { sanitizeEnvironment = false, ...runOptions } = options;
    const resourceHandle = await this.resolveSandboxResourceHandle(sandboxName, {
      ...runOptions,
      artifactName: runOptions.artifactName ? `${runOptions.artifactName}-resource` : undefined,
    });
    const environment = sanitizeEnvironment
      ? SANITIZED_PRIVILEGED_ENVIRONMENT.flatMap((value) => ["--env", value])
      : [];
    return this.command(
      ["container", "exec", ...environment, "--user", "root", resourceHandle, ...args],
      runOptions,
    );
  }
}

export async function ensureConfiguredRuntimeProviderAvailable(options: {
  artifactName: string;
  environment?: NodeJS.ProcessEnv;
  host: HostCliClient;
  scenarioLabel: string;
  skip: RuntimeProviderSkip;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  await new RuntimeProviderPrerequisite(options.host, options.skip, environment).requireAvailable({
    artifactName: options.artifactName,
    scenarioLabel: options.scenarioLabel,
  });
}
