// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArtifactSink } from "../artifacts.ts";
import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { artifactLabel, assertExitZero, resultText } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import { validateSandboxName } from "../clients/sandbox.ts";
import {
  DEFAULT_HOSTED_INFERENCE_BASE_URL,
  DEFAULT_HOSTED_INFERENCE_MODEL,
  HOSTED_INFERENCE_CREDENTIAL_ENV,
  HOSTED_INFERENCE_PROVIDER,
} from "../hosted-inference.ts";
import { redactString } from "../redaction.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { EnvironmentReady } from "./environment.ts";

const ONBOARD_ARGS = [
  "onboard",
  "--non-interactive",
  "--yes",
  "--yes-i-accept-third-party-software",
];
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
const HERMES_GATEWAY_URL = "http://127.0.0.1:8642";
const NEGATIVE_PREFLIGHT_LOG = "negative-preflight.log";
const DOCKER_ENV_KEYS = [
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
] as const;
const DOCKER_MISSING_PATTERNS = [
  /Cannot connect to the Docker daemon/i,
  /Is the docker daemon running\??/i,
  /docker daemon is not running/i,
  /docker[- ]missing/i,
  /Docker is required before onboarding/i,
  /Docker is not reachable/i,
  /could not talk to the Docker daemon/i,
];
const MISSING_SANDBOX_DELETE_PATTERNS = [
  /\bNotFound\b/i,
  /\bNot Found\b/i,
  /sandbox not found/i,
  /sandbox .* not found/i,
  /sandbox .* not present/i,
  /sandbox .* does not exist/i,
  /sandbox does not exist/i,
  /no such sandbox/i,
];
const POLICY_PRESETS_REQUIRED_PATTERN =
  /NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom/i;
const JAVASCRIPT_STACK_TRACE_PATTERNS = [
  /(^|\s)(TypeError|ReferenceError|SyntaxError):/m,
  /^\s+at /m,
];

function hasJavaScriptStackTrace(text: string): boolean {
  return JAVASCRIPT_STACK_TRACE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface OnboardingSecrets {
  required(name: string): string;
  redact?(text: string, extraValues?: string[]): string;
}

export interface OnboardingCleanup {
  add(name: string, run: () => Promise<void> | void): void;
}

export interface OnboardingOptions {
  sandboxName?: string;
  timeoutMs?: number;
}

export type OnboardingExpectedFailure =
  | { phase: "onboarding"; errorClass: "policy-presets-required" }
  | { phase: "preflight"; errorClass: "docker-missing" };

export interface NemoClawInstance {
  onboarding: string;
  sandboxName: string;
  agent: "openclaw" | "hermes" | "langchain-deepagents-code";
  provider: "nvidia" | "ollama";
  providerEnv: "cloud" | "local";
  platformOs?: "ubuntu" | "macos" | "windows";
  gatewayUrl: string;
  result: ShellProbeResult;
  expectedFailure?: OnboardingExpectedFailure;
}

function defaultSandboxName(onboarding: string): string {
  return `e2e-${artifactLabel(onboarding)}`;
}

function sandboxNameFromOptions(onboarding: string, options: OnboardingOptions): string {
  const sandboxName = options.sandboxName ?? defaultSandboxName(onboarding);
  validateSandboxName(sandboxName);
  return sandboxName;
}

function commandEnv(sandboxName: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const useHostedCompatible = process.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE === "1";
  const model =
    process.env.NEMOCLAW_MODEL ||
    process.env.NEMOCLAW_COMPAT_MODEL ||
    DEFAULT_HOSTED_INFERENCE_MODEL;
  const compatibleEnv: NodeJS.ProcessEnv = useHostedCompatible
    ? {
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_PROVIDER: HOSTED_INFERENCE_PROVIDER,
        NEMOCLAW_ENDPOINT_URL:
          process.env.NEMOCLAW_ENDPOINT_URL || DEFAULT_HOSTED_INFERENCE_BASE_URL,
        NEMOCLAW_MODEL: model,
        NEMOCLAW_COMPAT_MODEL: model,
        NEMOCLAW_PREFERRED_API: process.env.NEMOCLAW_PREFERRED_API || "openai-completions",
        [HOSTED_INFERENCE_CREDENTIAL_ENV]: extra.NVIDIA_INFERENCE_API_KEY,
      }
    : {};
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    ...compatibleEnv,
    ...extra,
  };
}

function runtimeCommandEnv(
  environment: EnvironmentReady,
  sandboxName: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = commandEnv(sandboxName, extra);
  if (environment.containerRuntime.driverName !== "podman") {
    return env;
  }
  for (const key of DOCKER_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function runtimeOnlyEnv(driverName: string): NodeJS.ProcessEnv {
  const env = buildAvailabilityProbeEnv();
  if (driverName === "podman") {
    for (const key of DOCKER_ENV_KEYS) {
      delete env[key];
    }
  }
  return env;
}

function onboardingArgs(
  environment: EnvironmentReady,
  trailingArgs: readonly string[] = [],
): string[] {
  const driverArgs =
    environment.containerRuntime.driverName === "podman" ? ["--compute-driver", "podman"] : [];
  return [...ONBOARD_ARGS, ...driverArgs, ...trailingArgs];
}

function requireAvailableRuntime(environment: EnvironmentReady, onboarding: string): void {
  if (!environment.containerRuntime.available) {
    throw new Error(
      `${onboarding} onboarding requires an available ${environment.containerRuntime.driverName} runtime.`,
    );
  }
}

function noDockerShim(): string {
  // Source of truth for the Vitest fixture path: simulate the invalid state
  // where the Docker client exists but the daemon is unreachable. Keep the
  // PATH-shadowed Docker command until the onboarding fixture can inject a
  // Docker client boundary directly instead of shadowing command lookup.
  return `#!/usr/bin/env bash
printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n' >&2
exit 1
`;
}

function prependPath(pathEntry: string, currentPath?: string): string {
  return currentPath ? `${pathEntry}:${currentPath}` : pathEntry;
}

function redactExplicitValues(text: string, values: string[]): string {
  return values.reduce(
    (redacted, value) => (value ? redacted.split(value).join("[REDACTED]") : redacted),
    text,
  );
}

function legacyNegativePreflightLogPath(): string | undefined {
  const contextDir = process.env.E2E_CONTEXT_DIR;
  return contextDir ? join(contextDir, NEGATIVE_PREFLIGHT_LOG) : undefined;
}

function hasDockerMissingSignature(result: ShellProbeResult): boolean {
  const text = resultText(result);
  return DOCKER_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

function hasMissingSandboxDeleteSignature(result: ShellProbeResult): boolean {
  const text = resultText(result);
  return MISSING_SANDBOX_DELETE_PATTERNS.some((pattern) => pattern.test(text));
}

export class OnboardingPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly secrets: OnboardingSecrets,
    private readonly cleanup?: OnboardingCleanup,
    private readonly artifacts?: ArtifactSink,
  ) {}

  async from(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    try {
      let result: NemoClawInstance;
      switch (environment.onboarding) {
        case "cloud-openclaw":
          result = await this.cloudOpenClaw(environment, options);
          break;
        case "cloud-hermes":
          result = await this.cloudHermes(environment, options);
          break;
        case "cloud-openclaw-policy-custom-missing-presets":
          result = await this.cloudOpenClawPolicyCustomMissingPresets(environment, options);
          break;
        case "cloud-openclaw-no-docker":
          result = await this.cloudOpenClawNoDocker(environment, options);
          break;
        case "cloud-langchain-deepagents-code":
          result = await this.cloudLangchainDeepAgentsCode(environment, options);
          break;
        default:
          throw new Error(`Unsupported onboarding profile '${environment.onboarding}'.`);
      }
      await this.writeResult("passed", environment, result);
      return result;
    } catch (error) {
      await this.writeResult("failed", environment, undefined, error);
      throw error;
    }
  }

  async cloudOpenClaw(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    requireAvailableRuntime(environment, "cloud-openclaw");
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_INFERENCE_API_KEY");
    this.registerSandboxCleanup(sandboxName, environment.containerRuntime.driverName);
    const result = await this.host.nemoclaw(onboardingArgs(environment), {
      artifactName: "onboard-cloud-openclaw",
      env: runtimeCommandEnv(environment, sandboxName, { NVIDIA_INFERENCE_API_KEY: apiKey }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, "cloud-openclaw onboarding");
    return {
      onboarding: environment.onboarding,
      sandboxName,
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      gatewayUrl: OPENCLAW_GATEWAY_URL,
      result,
    };
  }

  async cloudHermes(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    requireAvailableRuntime(environment, "cloud-hermes");
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_INFERENCE_API_KEY");
    this.registerSandboxCleanup(sandboxName, environment.containerRuntime.driverName);
    const result = await this.host.nemoclaw(onboardingArgs(environment), {
      artifactName: "onboard-cloud-hermes",
      env: runtimeCommandEnv(environment, sandboxName, {
        NEMOCLAW_AGENT: "hermes",
        NVIDIA_INFERENCE_API_KEY: apiKey,
      }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, "cloud-hermes onboarding");
    return {
      onboarding: environment.onboarding,
      sandboxName,
      agent: "hermes",
      provider: "nvidia",
      providerEnv: "cloud",
      gatewayUrl: HERMES_GATEWAY_URL,
      result,
    };
  }

  async cloudLangchainDeepAgentsCode(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    requireAvailableRuntime(environment, "cloud-langchain-deepagents-code");
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_INFERENCE_API_KEY");
    this.registerSandboxCleanup(sandboxName, environment.containerRuntime.driverName);
    const result = await this.host.nemoclaw(onboardingArgs(environment, ["--observability"]), {
      artifactName: "onboard-cloud-langchain-deepagents-code",
      env: runtimeCommandEnv(environment, sandboxName, {
        NEMOCLAW_AGENT: "langchain-deepagents-code",
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_PROVIDER: HOSTED_INFERENCE_PROVIDER,
        NEMOCLAW_ENDPOINT_URL:
          process.env.NEMOCLAW_ENDPOINT_URL || DEFAULT_HOSTED_INFERENCE_BASE_URL,
        NEMOCLAW_MODEL:
          process.env.NEMOCLAW_MODEL ||
          process.env.NEMOCLAW_COMPAT_MODEL ||
          DEFAULT_HOSTED_INFERENCE_MODEL,
        NEMOCLAW_COMPAT_MODEL:
          process.env.NEMOCLAW_MODEL ||
          process.env.NEMOCLAW_COMPAT_MODEL ||
          DEFAULT_HOSTED_INFERENCE_MODEL,
        NEMOCLAW_PREFERRED_API: process.env.NEMOCLAW_PREFERRED_API || "openai-completions",
        NVIDIA_INFERENCE_API_KEY: apiKey,
        [HOSTED_INFERENCE_CREDENTIAL_ENV]: apiKey,
      }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, "cloud-langchain-deepagents-code onboarding");
    return {
      onboarding: environment.onboarding,
      sandboxName,
      agent: "langchain-deepagents-code",
      provider: "nvidia",
      providerEnv: "cloud",
      gatewayUrl: OPENCLAW_GATEWAY_URL,
      result,
    };
  }

  async cloudOpenClawNoDocker(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    if (
      environment.containerRuntime.driverName !== "docker" ||
      environment.containerRuntime.expectation !== "missing"
    ) {
      throw new Error(
        "cloud-openclaw-no-docker onboarding requires the docker-missing runtime expectation.",
      );
    }
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_INFERENCE_API_KEY");
    this.registerSandboxCleanup(sandboxName, environment.containerRuntime.driverName);
    const shimDir = await mkdtemp(join(tmpdir(), "e2e-no-docker-"));
    const shimPath = join(shimDir, "docker");
    try {
      await writeFile(shimPath, noDockerShim(), "utf8");
      await chmod(shimPath, 0o700);
      const env = commandEnv(sandboxName, { NVIDIA_INFERENCE_API_KEY: apiKey });
      env.PATH = prependPath(shimDir, env.PATH);
      const result = await this.host.nemoclaw(ONBOARD_ARGS, {
        artifactName: "onboard-cloud-openclaw-no-docker",
        env,
        redactionValues: [apiKey],
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      await this.writeNegativePreflightEvidence(result, [apiKey]);
      if (result.exitCode === 0) {
        throw new Error("cloud-openclaw-no-docker onboarding unexpectedly succeeded.");
      }
      if (!hasDockerMissingSignature(result)) {
        throw new Error(
          `cloud-openclaw-no-docker onboarding failed without Docker-missing preflight signature: ${resultText(result)}`,
        );
      }
      return {
        onboarding: environment.onboarding,
        sandboxName,
        agent: "openclaw",
        provider: "nvidia",
        providerEnv: "cloud",
        gatewayUrl: OPENCLAW_GATEWAY_URL,
        result,
        expectedFailure: {
          phase: "preflight",
          errorClass: "docker-missing",
        },
      };
    } finally {
      await rm(shimDir, { force: true, recursive: true });
    }
  }

  async cloudOpenClawPolicyCustomMissingPresets(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    requireAvailableRuntime(environment, "cloud-openclaw-policy-custom-missing-presets");
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_INFERENCE_API_KEY");
    this.registerSandboxCleanup(sandboxName, environment.containerRuntime.driverName);
    const result = await this.host.nemoclaw(onboardingArgs(environment), {
      artifactName: "onboard-cloud-openclaw-policy-custom-missing-presets",
      env: runtimeCommandEnv(environment, sandboxName, {
        NVIDIA_INFERENCE_API_KEY: apiKey,
        NEMOCLAW_POLICY_MODE: "custom",
        NEMOCLAW_POLICY_PRESETS: "",
      }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      throw new Error("cloud-openclaw-policy-custom-missing-presets unexpectedly succeeded.");
    }
    const output = resultText(result);
    if (!POLICY_PRESETS_REQUIRED_PATTERN.test(output)) {
      throw new Error(
        `cloud-openclaw-policy-custom-missing-presets failed without the policy preset signature: ${output}`,
      );
    }
    if (hasJavaScriptStackTrace(output)) {
      throw new Error(
        `cloud-openclaw-policy-custom-missing-presets failed with a JavaScript stack trace: ${output}`,
      );
    }
    return {
      onboarding: environment.onboarding,
      sandboxName,
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      gatewayUrl: OPENCLAW_GATEWAY_URL,
      result,
      expectedFailure: {
        phase: "onboarding",
        errorClass: "policy-presets-required",
      },
    };
  }

  async destroySandbox(
    sandboxName: string,
    artifactName?: string,
    driverName = "docker",
  ): Promise<ShellProbeResult> {
    validateSandboxName(sandboxName);
    const result = await this.host.nemoclaw([sandboxName, "destroy", "--yes"], {
      artifactName: artifactName ?? `cleanup-destroy-${artifactLabel(sandboxName)}`,
      env: runtimeOnlyEnv(driverName),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 && !hasMissingSandboxDeleteSignature(result)) {
      assertExitZero(result, `cleanup destroy sandbox ${sandboxName}`);
    }
    return result;
  }

  private registerSandboxCleanup(sandboxName: string, driverName = "docker"): void {
    if (!this.cleanup) return;
    this.cleanup.add(`destroy NemoClaw sandbox ${sandboxName}`, async () => {
      await this.destroySandbox(sandboxName, undefined, driverName);
    });
  }

  private redact(text: string, extraValues: string[] = []): string {
    return (
      this.secrets.redact?.(text, extraValues) ??
      redactString(redactExplicitValues(text, extraValues))
    );
  }

  private async writeNegativePreflightEvidence(
    result: ShellProbeResult,
    redactionValues: string[],
  ): Promise<void> {
    const logPath = legacyNegativePreflightLogPath();
    if (!logPath) return;
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, this.redact(resultText(result), redactionValues), "utf8");
  }

  private async writeResult(
    status: "passed" | "failed",
    environment: EnvironmentReady,
    instance?: NemoClawInstance,
    error?: unknown,
  ): Promise<void> {
    await this.artifacts?.writeJson("onboarding.result.json", {
      phase: "onboarding",
      status,
      onboarding: environment.onboarding,
      sandboxName: instance?.sandboxName,
      agent: instance?.agent,
      provider: instance?.provider,
      providerEnv: instance?.providerEnv,
      expectedFailure: instance?.expectedFailure,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
  }
}
