// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HostCliClient } from "./clients/host.ts";
import { resultText } from "./clients/index.ts";

export const COMPATIBLE_ANTHROPIC_PROVIDER = "compatible-anthropic-endpoint";
export const COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const DEFAULT_COMPATIBLE_ANTHROPIC_CREDENTIAL = "test-compatible-anthropic-key";
const OPENSHELL_HOST_ALIAS = "host.openshell.internal";

export interface CompatibleAnthropicSwitchBinding {
  endpointUrl: string;
  credentialValue: string;
}

export function compatibleAnthropicSwitchBinding(
  endpointUrl: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): CompatibleAnthropicSwitchBinding {
  const normalizedEndpointUrl = endpointUrl.trim();
  if (!normalizedEndpointUrl) {
    throw new Error(
      "NEMOCLAW_SWITCH_ENDPOINT_URL is required for compatible Anthropic inference switches",
    );
  }
  const credentialValue =
    runtimeEnv[COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV] ?? DEFAULT_COMPATIBLE_ANTHROPIC_CREDENTIAL;
  if (!credentialValue.trim()) {
    throw new Error(
      "COMPATIBLE_ANTHROPIC_API_KEY is required for compatible Anthropic inference switches",
    );
  }
  return { endpointUrl: normalizedEndpointUrl, credentialValue };
}

export function compatibleAnthropicSwitchEnv(
  binding: CompatibleAnthropicSwitchBinding | null,
): NodeJS.ProcessEnv {
  return binding ? { [COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV]: binding.credentialValue } : {};
}

export function hostVerificationHostsFile(source: string): string {
  const existing = source.endsWith("\n") ? source : `${source}\n`;
  return `127.0.0.1 ${OPENSHELL_HOST_ALIAS}\n${existing}`;
}

export async function withHostVerificationLoopbackAlias<T>(
  host: HostCliClient,
  cleanup: { trackDisposable(name: string, run: () => Promise<void> | void): void },
  run: () => Promise<T>,
): Promise<T> {
  const fixtureDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-compatible-endpoint-hosts-"),
  );
  const originalHosts = fs.readFileSync("/etc/hosts", "utf8");
  const originalPath = path.join(fixtureDirectory, "hosts.original");
  const mappedPath = path.join(fixtureDirectory, "hosts.mapped");
  fs.writeFileSync(originalPath, originalHosts, { mode: 0o600 });
  fs.writeFileSync(mappedPath, hostVerificationHostsFile(originalHosts), { mode: 0o600 });

  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    const result = await host.command("sudo", ["cp", "--", originalPath, "/etc/hosts"], {
      artifactName: "restore-host-verifier-alias",
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`could not restore /etc/hosts: ${resultText(result)}`);
    }
    if (fs.readFileSync("/etc/hosts", "utf8") !== originalHosts) {
      throw new Error("/etc/hosts differs after host verifier alias restoration");
    }
    restored = true;
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  };
  cleanup.trackDisposable("restore the host verifier alias mapping", restore);

  try {
    const mapped = await host.command("sudo", ["cp", "--", mappedPath, "/etc/hosts"], {
      artifactName: "map-host-verifier-alias",
      timeoutMs: 30_000,
    });
    if (mapped.exitCode !== 0) {
      throw new Error(`could not map the host verifier alias: ${resultText(mapped)}`);
    }
    return await run();
  } finally {
    await restore();
  }
}

export async function requireCompatibleAnthropicProviderAbsent(
  host: HostCliClient,
  options: {
    artifactName: string;
    env: NodeJS.ProcessEnv;
    gatewayName?: string;
  },
): Promise<void> {
  const gatewayName = options.gatewayName ?? "nemoclaw";
  const result = await host.command(
    "openshell",
    ["provider", "get", "-g", gatewayName, COMPATIBLE_ANTHROPIC_PROVIDER],
    {
      artifactName: options.artifactName,
      env: options.env,
      timeoutMs: 30_000,
    },
  );
  const output = resultText(result);
  if (result.exitCode === 0) {
    throw new Error(
      `Provider '${COMPATIBLE_ANTHROPIC_PROVIDER}' must be absent before this inference switch so NemoClaw can create and verify its rollback-safe binding.`,
    );
  }
  if (!/provider not found|requested entity was not found/iu.test(output)) {
    throw new Error(
      `Could not prove provider '${COMPATIBLE_ANTHROPIC_PROVIDER}' is absent: ${output}`,
    );
  }
}
