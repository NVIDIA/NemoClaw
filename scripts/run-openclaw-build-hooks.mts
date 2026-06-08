#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;

type MessagingPlan = {
  readonly schemaVersion: 1;
  readonly agent: string;
  readonly channels: readonly MessagingPlanChannel[];
  readonly credentialBindings: readonly MessagingCredentialBinding[];
  readonly buildSteps: readonly MessagingBuildStep[];
};

type MessagingPlanChannel = {
  readonly channelId: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
};

type MessagingCredentialBinding = {
  readonly channelId: string;
  readonly providerEnvKey?: unknown;
  readonly placeholder?: unknown;
};

type MessagingBuildStep = {
  readonly channelId: string;
  readonly kind: string;
  readonly outputId?: string;
  readonly required?: boolean;
  readonly value?: unknown;
};

type OpenClawPackageInstall = {
  readonly manager: "openclaw-plugin";
  readonly spec: string;
  readonly pin?: boolean;
};

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const DIAGNOSTICS_OTEL_PACKAGE = "@openclaw/diagnostics-otel";

class OpenClawBuildHookError extends Error {}

function readMessagingPlanFromEnv(env: Env): MessagingPlan | null {
  const raw = env.NEMOCLAW_MESSAGING_PLAN_B64;
  if (!raw || raw.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  } catch (error) {
    throw new OpenClawBuildHookError(
      `NEMOCLAW_MESSAGING_PLAN_B64 must be base64-encoded JSON: ${formatError(error)}`,
    );
  }

  if (
    !isObject(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.agent !== "openclaw" ||
    !Array.isArray(parsed.channels) ||
    !Array.isArray(parsed.credentialBindings) ||
    !Array.isArray(parsed.buildSteps)
  ) {
    throw new OpenClawBuildHookError(
      "NEMOCLAW_MESSAGING_PLAN_B64 must contain an openclaw messaging plan",
    );
  }
  return parsed as MessagingPlan;
}

function activeChannels(plan: MessagingPlan | null): string[] {
  if (!plan) return [];
  const seen = new Set<string>();
  const channels: string[] = [];
  for (const item of plan.channels) {
    if (!isObject(item)) continue;
    const channel = String(item.channelId || "").trim().toLowerCase();
    if (!channel || seen.has(channel)) continue;
    if (item.active === true && item.disabled !== true) {
      seen.add(channel);
      channels.push(channel);
    }
  }
  return channels;
}

function collectOpenClawInstallSpecs(plan: MessagingPlan | null, env: Env): string[] {
  if (!plan) return [];
  const active = new Set(activeChannels(plan));
  const specs: string[] = [];
  for (const step of plan.buildSteps) {
    if (step.kind !== "package-install" || !active.has(step.channelId)) continue;
    if (step.value === undefined) {
      if (step.required) {
        throw new OpenClawBuildHookError(
          `Messaging package-install output ${step.outputId || "<unknown>"} is missing`,
        );
      }
      continue;
    }
    const install = readOpenClawPackageInstall(step.value, step.outputId || "<unknown>");
    specs.push(resolveOpenClawPackageSpec(install.spec, env));
  }
  return unique(specs);
}

function readOpenClawPackageInstall(value: unknown, outputId: string): OpenClawPackageInstall {
  if (!isObject(value)) {
    throw new OpenClawBuildHookError(
      `Messaging package-install output ${outputId} must be an object`,
    );
  }
  if (value.manager !== "openclaw-plugin") {
    throw new OpenClawBuildHookError(
      `Messaging package-install output ${outputId} must use manager 'openclaw-plugin'`,
    );
  }
  if (typeof value.spec !== "string" || value.spec.trim().length === 0) {
    throw new OpenClawBuildHookError(
      `Messaging package-install output ${outputId} must include a package spec`,
    );
  }
  if (value.pin !== undefined && typeof value.pin !== "boolean") {
    throw new OpenClawBuildHookError(
      `Messaging package-install output ${outputId} pin must be boolean`,
    );
  }
  return value as OpenClawPackageInstall;
}

function resolveOpenClawPackageSpec(spec: string, env: Env): string {
  const version = (env.OPENCLAW_VERSION || "").trim();
  const resolved = spec.replaceAll("{{openclaw.version}}", () => {
    if (!version) {
      throw new OpenClawBuildHookError(
        "OPENCLAW_VERSION is required when OpenClaw package install hooks are active",
      );
    }
    return version;
  });
  if (/\{\{\s*[^}]+\s*\}\}/.test(resolved)) {
    throw new OpenClawBuildHookError(`Unresolved package-install template in ${spec}`);
  }
  return resolved;
}

function diagnosticsOtelSpec(env: Env): string | null {
  if (!isTruthyEnv(env.NEMOCLAW_OPENCLAW_OTEL)) return null;
  const version = (env.OPENCLAW_VERSION || "").trim();
  if (!version) {
    throw new OpenClawBuildHookError(
      "OPENCLAW_VERSION is required when OpenClaw OTEL is enabled",
    );
  }
  return `npm:${DIAGNOSTICS_OTEL_PACKAGE}@${version}`;
}

function doctorEnvOverrides(plan: MessagingPlan | null): Record<string, string> {
  if (!plan) return {};
  const active = new Set(activeChannels(plan));
  const overrides: Record<string, string> = {};
  for (const binding of plan.credentialBindings) {
    if (!active.has(binding.channelId)) continue;
    if (typeof binding.providerEnvKey === "string" && typeof binding.placeholder === "string") {
      overrides[binding.providerEnvKey] = binding.placeholder;
    }
  }
  return overrides;
}

function runCommand(args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`+ ${args.join(" ")}`);
  const result = spawnSync(args[0] as string, args.slice(1), {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new OpenClawBuildHookError(
      `${args[0]} exited with status ${String(result.status ?? "unknown")}`,
    );
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  return !FALSE_VALUES.has(value.trim().toLowerCase());
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(argv: readonly string[]): void {
  const dryRun = argv.includes("--dry-run");
  const plan = readMessagingPlanFromEnv(process.env);
  const channels = activeChannels(plan);
  const installSpecs = collectOpenClawInstallSpecs(plan, process.env);
  const otelSpec = diagnosticsOtelSpec(process.env);
  if (otelSpec) installSpecs.push(otelSpec);
  const doctorEnv = doctorEnvOverrides(plan);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          channels,
          diagnosticsOtelEnabled: isTruthyEnv(process.env.NEMOCLAW_OPENCLAW_OTEL),
          doctorEnv,
          installSpecs: unique(installSpecs),
          openclawVersion: process.env.OPENCLAW_VERSION || "",
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const spec of unique(installSpecs)) {
    runCommand(["openclaw", "plugins", "install", spec, "--pin"]);
  }

  runCommand(["openclaw", "doctor", "--fix", "--non-interactive"], {
    ...process.env,
    ...doctorEnv,
  });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`ERROR: ${formatError(error)}`);
  process.exit(2);
}
