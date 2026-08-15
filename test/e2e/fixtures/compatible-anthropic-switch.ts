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
const HOST_VERIFICATION_LOCK_PATH = path.join(
  os.tmpdir(),
  "nemoclaw-compatible-endpoint-hosts.lock",
);
const HOST_VERIFICATION_LOCK_TIMEOUT_MS = 5 * 60_000;
const HOST_VERIFICATION_LOCK_POLL_MS = 100;

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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function withHostVerificationHostsLock<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + HOST_VERIFICATION_LOCK_TIMEOUT_MS;
  let descriptor: number;
  while (true) {
    try {
      descriptor = fs.openSync(HOST_VERIFICATION_LOCK_PATH, "wx", 0o600);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for exclusive host resolver fixture ownership: ${HOST_VERIFICATION_LOCK_PATH}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, HOST_VERIFICATION_LOCK_POLL_MS));
    }
  }

  try {
    return await run();
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(HOST_VERIFICATION_LOCK_PATH);
  }
}

const REPLACE_HOSTS_IF_UNCHANGED = [
  "set -euo pipefail",
  'expected="$1"',
  'replacement="$2"',
  'if ! cmp -s -- "$expected" /etc/hosts; then',
  '  echo "/etc/hosts changed while the NemoClaw host verifier alias was active" >&2',
  "  exit 3",
  "fi",
  'cp -- "$replacement" /etc/hosts',
].join("\n");

export async function withHostVerificationLoopbackAlias<T>(
  host: HostCliClient,
  cleanup: { trackDisposable(name: string, run: () => Promise<void> | void): void },
  run: () => Promise<T>,
): Promise<T> {
  const fixtureDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-compatible-endpoint-hosts-"),
  );
  const originalPath = path.join(fixtureDirectory, "hosts.original");
  const mappedPath = path.join(fixtureDirectory, "hosts.mapped");

  let restored = false;
  let originalHosts: string | null = null;
  let mappedHosts: string | null = null;
  let mappingMayNeedRecovery = false;
  const restoreWhileLocked = async (): Promise<void> => {
    if (restored) return;
    if (!mappingMayNeedRecovery || originalHosts === null || mappedHosts === null) {
      restored = true;
      fs.rmSync(fixtureDirectory, { force: true, recursive: true });
      return;
    }
    const currentHosts = fs.readFileSync("/etc/hosts", "utf8");
    if (currentHosts === originalHosts) {
      restored = true;
      fs.rmSync(fixtureDirectory, { force: true, recursive: true });
      return;
    }
    if (currentHosts !== mappedHosts) {
      throw new Error(
        "/etc/hosts changed while the host verifier alias was active; refusing to overwrite concurrent resolver state",
      );
    }
    const result = await host.command(
      "sudo",
      [
        "bash",
        "-ceu",
        REPLACE_HOSTS_IF_UNCHANGED,
        "restore-host-verifier-alias",
        mappedPath,
        originalPath,
      ],
      {
        artifactName: "restore-host-verifier-alias",
        timeoutMs: 30_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`could not restore /etc/hosts: ${resultText(result)}`);
    }
    if (fs.readFileSync("/etc/hosts", "utf8") !== originalHosts) {
      throw new Error("/etc/hosts differs after host verifier alias restoration");
    }
    restored = true;
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  };
  const restore = async (): Promise<void> => {
    if (restored) return;
    await withHostVerificationHostsLock(restoreWhileLocked);
  };
  cleanup.trackDisposable("restore the host verifier alias mapping", restore);

  return await withHostVerificationHostsLock(async () => {
    originalHosts = fs.readFileSync("/etc/hosts", "utf8");
    mappedHosts = hostVerificationHostsFile(originalHosts);
    fs.writeFileSync(originalPath, originalHosts, { mode: 0o600 });
    fs.writeFileSync(mappedPath, mappedHosts, { mode: 0o600 });

    try {
      let mapped: Awaited<ReturnType<HostCliClient["command"]>>;
      try {
        mapped = await host.command(
          "sudo",
          [
            "bash",
            "-ceu",
            REPLACE_HOSTS_IF_UNCHANGED,
            "map-host-verifier-alias",
            originalPath,
            mappedPath,
          ],
          {
            artifactName: "map-host-verifier-alias",
            timeoutMs: 30_000,
          },
        );
      } finally {
        mappingMayNeedRecovery = fs.readFileSync("/etc/hosts", "utf8") !== originalHosts;
      }
      if (mapped.exitCode !== 0) {
        throw new Error(`could not map the host verifier alias: ${resultText(mapped)}`);
      }
      if (fs.readFileSync("/etc/hosts", "utf8") !== mappedHosts) {
        throw new Error("/etc/hosts differs after host verifier alias installation");
      }
      return await run();
    } finally {
      await restoreWhileLocked();
    }
  });
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
