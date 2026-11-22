// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { networkInterfaces } from "node:os";

import type { CommandExitResult } from "../fixtures/clients/command.ts";
import { resultText } from "../fixtures/clients/command.ts";

const DOCKER_NOT_FOUND_PATTERN = /no such (?:object|container)/iu;
const SANDBOX_NOT_FOUND_PATTERN =
  /(?:\bsandbox(?:\s+['"][^'"]+['"])?\s+(?:not found|does not exist)\b|\bno such sandbox\b)/iu;
const SANDBOX_ID_PATTERN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;

export type SandboxInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly id: string };

export async function cleanupCapturedSparkResource(
  resource: string,
  capturedId: string | null,
  inspection: SandboxInspection,
  remove: (capturedId: string, currentId: string) => Promise<void>,
): Promise<void> {
  if (inspection.kind === "absent") return;
  if (!capturedId) {
    throw new Error(
      `Cannot establish ownership of ${resource} after onboarding; leaving it for reconciliation.`,
    );
  }
  await remove(capturedId, inspection.id);
}

export function inspectDockerContainerIdentity(result: CommandExitResult): SandboxInspection {
  return classifyDockerContainerInspection(result) === "absent"
    ? { kind: "absent" }
    : { kind: "present", id: result.stdout.trim() };
}

export function assertLocalDockerEnvironment(env: NodeJS.ProcessEnv): void {
  const host = String(env.DOCKER_HOST ?? "").trim();
  const context = String(env.DOCKER_CONTEXT ?? "").trim();
  if (host && !host.startsWith("unix://")) {
    throw new Error(
      `DGX Spark qualification requires a local Docker socket; got DOCKER_HOST=${host}`,
    );
  }
  if (context && context !== "default") {
    throw new Error(
      `DGX Spark qualification requires the default local Docker context; got DOCKER_CONTEXT=${context}`,
    );
  }
}

export function vllmPublicationProbeUrls(
  bridgeHost: string,
  interfaces = networkInterfaces(),
): { allowed: string[]; denied: string[]; ipv6: "configured" | "unconfigured" } {
  const allowedHosts = new Set(["127.0.0.1", bridgeHost]);
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? []).map((entry) => ({ ...entry, name })),
  );
  const unintended = addresses.filter(({ address }) => !allowedHosts.has(address));
  if (!unintended.some(({ family, internal }) => family === "IPv4" && !internal)) {
    throw new Error("vLLM publication proof requires an unintended non-loopback IPv4 address.");
  }
  const denied = unintended.map((entry) => {
    const host =
      entry.family === "IPv6"
        ? `[${entry.address}${entry.scopeid ? `%25${encodeURIComponent(entry.name)}` : ""}]`
        : entry.address;
    return `http://${host}:8000/health`;
  });
  return {
    allowed: [...allowedHosts].map((host) => `http://${host}:8000/health`),
    denied: [...new Set(denied)],
    ipv6: addresses.some(({ family }) => family === "IPv6") ? "configured" : "unconfigured",
  };
}

export function vllmPublicationCurlArgs(urls: readonly string[]): string[] {
  return [
    "-q",
    "--noproxy",
    "*",
    "--globoff",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "3",
    "--max-time",
    "5",
    "--write-out",
    "%{exitcode} %{http_code}\n",
    ...urls.flatMap((url) => ["--output", "/dev/null", url]),
  ];
}

export const SPARK_EGRESS_PROBE =
  "status=0; code=$(curl -sS -o /dev/null -w '%{http_connect}' --max-time 20 https://example.com/) || status=$?; printf '%s %s' \"$status\" \"$code\"";

export function classifyDockerContainerInspection(result: CommandExitResult): "absent" | "present" {
  if (result.exitCode === 0) return "present";
  if (DOCKER_NOT_FOUND_PATTERN.test(`${result.stdout}\n${result.stderr}`)) return "absent";
  throw new Error(`Docker container inspection failed: ${resultText(result)}`);
}

export function listedSandboxNames(result: CommandExitResult): Set<string> {
  if (result.exitCode !== 0) {
    throw new Error(`OpenShell sandbox listing failed: ${resultText(result)}`);
  }
  return new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function inspectSandboxIdentity(
  result: CommandExitResult,
  expectedName: string,
): SandboxInspection {
  if (result.exitCode !== 0) {
    if (SANDBOX_NOT_FOUND_PATTERN.test(`${result.stdout}\n${result.stderr}`)) {
      return { kind: "absent" };
    }
    throw new Error(`OpenShell sandbox inspection failed: ${resultText(result)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("OpenShell sandbox inspection returned invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenShell sandbox inspection returned an invalid record.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.name !== expectedName ||
    typeof record.id !== "string" ||
    !SANDBOX_ID_PATTERN.test(record.id)
  ) {
    throw new Error("OpenShell sandbox inspection did not match the expected identity.");
  }
  return { kind: "present", id: record.id };
}
