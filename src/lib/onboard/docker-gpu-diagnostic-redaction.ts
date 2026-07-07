// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactFull } from "../security/redact";
import type { DockerContainerInspect } from "./docker-gpu-patch";

const SENSITIVE_ENV_KEY =
  /(?:api_?key|private_?key|(?:^|_)key$|token|secret|password|credential|authorization|cookie|proxy)/i;
const EXTRA_PLACEHOLDER_KEYS_ENV = "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS";

function inspectEnv(inspect: DockerContainerInspect): Map<string, string> {
  const env = new Map<string, string>();
  for (const assignment of inspect.Config?.Env ?? []) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    env.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  }
  return env;
}

function startupCommandEnv(inspect: DockerContainerInspect): Map<string, string> {
  const assignments = new Map<string, string>();
  const command = inspectEnv(inspect).get("OPENSHELL_SANDBOX_COMMAND") ?? "";
  const tokens = command.trim().split(/\s+/u);
  if (tokens.shift() !== "env") return assignments;
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator <= 0) break;
    assignments.set(token.slice(0, separator), token.slice(separator + 1));
  }
  return assignments;
}

function summarizeArgv(
  value: string[] | string | null | undefined,
  redactText: (text: string) => string,
): string[] | string | null | undefined {
  if (!Array.isArray(value)) {
    return typeof value === "string" ? redactText(value) : value;
  }
  if (value.length <= 1) return value.map(redactText);
  return [redactText(value[0] ?? ""), `<${String(value.length - 1)} additional arguments omitted>`];
}

export type DockerGpuDiagnosticRedactor = {
  rememberInspect(inspect: DockerContainerInspect): void;
  redactText(text: string): string;
  redactValue(value: unknown): unknown;
  sanitizeInspect(inspect: DockerContainerInspect): DockerContainerInspect;
};

export function discoverDockerGpuDiagnosticSensitiveValues(
  inspect: DockerContainerInspect,
): string[] {
  const env = inspectEnv(inspect);
  const startupEnv = startupCommandEnv(inspect);
  const extraPlaceholderKeys = new Set(
    (startupEnv.get(EXTRA_PLACEHOLDER_KEYS_ENV) ?? env.get(EXTRA_PLACEHOLDER_KEYS_ENV) ?? "")
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return [...env, ...startupEnv]
    .filter(
      ([key, value]) =>
        (SENSITIVE_ENV_KEY.test(key) || extraPlaceholderKeys.has(key)) && value.length > 0,
    )
    .map(([, value]) => value);
}

/**
 * Owns the redaction state for one diagnostic bundle. Full Docker inspect
 * records are observed before any artifact is written so conventionally
 * sensitive and custom-placeholder values are removed from every sink.
 */
export function createDockerGpuDiagnosticRedactor(
  initialSensitiveValues: Iterable<string> = [],
): DockerGpuDiagnosticRedactor {
  const sensitiveValues = new Set([...initialSensitiveValues].filter((value) => value.length > 0));
  const redactText = (text: string): string => {
    let redacted = redactFull(text);
    for (const value of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
      redacted = redacted.split(value).join("<REDACTED>");
    }
    return redacted;
  };
  const rememberInspect = (inspect: DockerContainerInspect): void => {
    for (const value of discoverDockerGpuDiagnosticSensitiveValues(inspect)) {
      sensitiveValues.add(value);
    }
  };
  const redactValue = (value: unknown, seen: WeakSet<object> = new WeakSet()): unknown => {
    if (typeof value === "string") return redactText(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redactText(key), redactValue(entry, seen)]),
    );
  };
  const sanitizeInspect = (inspect: DockerContainerInspect): DockerContainerInspect => {
    const envKeys = [...inspectEnv(inspect).keys()].sort();
    const labels = Object.fromEntries(
      Object.entries(inspect.Config?.Labels ?? {})
        .filter(([key]) => key.startsWith("openshell.ai/"))
        .map(([key, value]) => [redactText(key), redactText(value)]),
    );
    const networks = Object.fromEntries(
      Object.entries(inspect.NetworkSettings?.Networks ?? {}).map(([name, network]) => [
        redactText(name),
        {
          IPAddress: network.IPAddress ? redactText(network.IPAddress) : network.IPAddress,
          Gateway: network.Gateway ? redactText(network.Gateway) : network.Gateway,
          Aliases: network.Aliases?.map(redactText),
        },
      ]),
    );
    return {
      Id: inspect.Id ? redactText(inspect.Id) : inspect.Id,
      Name: inspect.Name ? redactText(inspect.Name) : inspect.Name,
      Config: {
        Image: inspect.Config?.Image ? redactText(inspect.Config.Image) : inspect.Config?.Image,
        User: inspect.Config?.User ? redactText(inspect.Config.User) : inspect.Config?.User,
        Entrypoint: summarizeArgv(inspect.Config?.Entrypoint, redactText),
        Cmd: summarizeArgv(inspect.Config?.Cmd, redactText),
        Env: envKeys.map((key) => `${redactText(key)}=<REDACTED>`),
        Labels: labels,
      },
      HostConfig: {
        NetworkMode: inspect.HostConfig?.NetworkMode
          ? redactText(inspect.HostConfig.NetworkMode)
          : inspect.HostConfig?.NetworkMode,
        RestartPolicy: inspect.HostConfig?.RestartPolicy
          ? {
              ...inspect.HostConfig.RestartPolicy,
              Name: inspect.HostConfig.RestartPolicy.Name
                ? redactText(inspect.HostConfig.RestartPolicy.Name)
                : inspect.HostConfig.RestartPolicy.Name,
            }
          : inspect.HostConfig?.RestartPolicy,
        GroupAdd: inspect.HostConfig?.GroupAdd?.map(redactText),
      },
      NetworkSettings: { Networks: networks },
    };
  };
  return { rememberInspect, redactText, redactValue, sanitizeInspect };
}
