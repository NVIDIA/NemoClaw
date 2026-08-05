#!/usr/bin/env -S node --experimental-strip-types

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const RESULT_PREFIX = "NEMOCLAW_HERMES_SWITCHYARD_INFERENCE_LOCAL=";
const MAX_PROVIDER_LOG_BYTES = 128 * 1024;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../bin/nemohermes.js", import.meta.url));

type Options = {
  providerLog?: ProviderLogIdentity;
  restart: boolean;
  sandboxName: string;
};

type ProviderLogIdentity = {
  device: number;
  inode: number;
  path: string;
};

type Turn = { answer?: unknown; classifier?: unknown; route?: unknown; target?: unknown };
type Evidence = {
  architecture?: unknown;
  caller_authorization_probe_succeeded?: unknown;
  classifier_provider_authorization_absent?: unknown;
  gateway_pid_after?: unknown;
  gateway_pid_before?: unknown;
  gateway_pid_stable?: unknown;
  provider_boundary?: unknown;
  provider_placeholder_present?: unknown;
  raw_provider_credentials_absent?: unknown;
  relay_sidecar_processes?: unknown;
  route_model_contract?: unknown;
  status?: unknown;
  turns?: Turn[];
};

function usage(): never {
  console.error(
    "Usage: npm run prototype:hermes-switchyard:inference-local -- <sandbox-name> [--restart] [--provider-log <absolute-path>]",
  );
  process.exit(2);
}

function parseOptions(arguments_: string[]): Options {
  const sandboxName = arguments_[0]?.trim();
  if (!sandboxName || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(sandboxName)) usage();

  let providerLog: ProviderLogIdentity | undefined;
  let restart = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--restart" && !restart) {
      restart = true;
      continue;
    }
    if (argument === "--provider-log" && providerLog === undefined) {
      const candidate = arguments_[index + 1];
      if (!candidate || !isAbsolute(candidate)) usage();
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROVIDER_LOG_BYTES) {
        throw new Error("Provider log must be a bounded, regular, non-symlink file");
      }
      const snapshot = providerLogSnapshot({
        device: stat.dev,
        inode: stat.ino,
        path: realpathSync(candidate),
      });
      providerLog = snapshot.identity;
      index += 1;
      continue;
    }
    usage();
  }
  return { providerLog, restart, sandboxName };
}

function providerLogSnapshot(expected: ProviderLogIdentity): {
  identity: ProviderLogIdentity;
  lines: string[];
} {
  const descriptor = openSync(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > MAX_PROVIDER_LOG_BYTES ||
      stat.dev !== expected.device ||
      stat.ino !== expected.inode
    ) {
      throw new Error("Provider log changed outside the bounded regular-file contract");
    }
    return {
      identity: { device: stat.dev, inode: stat.ino, path: expected.path },
      lines: readFileSync(descriptor, "utf8").split(/\r?\n/u).filter(Boolean),
    };
  } finally {
    closeSync(descriptor);
  }
}

function runProof(sandboxName: string): Evidence {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "sandbox",
      "exec",
      sandboxName,
      "--no-tty",
      "--no-stdin",
      "--timeout",
      "300",
      "--",
      "bash",
      "/usr/local/lib/nemoclaw/switchyard-inference-local-run-in-sandbox.sh",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 6 * 60_000,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(-12_000);
    throw new Error(
      result.error?.message ?? `Inference-local prototype failed (${result.status}):\n${detail}`,
    );
  }

  const marker = result.stdout.split(/\r?\n/u).find((line) => line.startsWith(RESULT_PREFIX));
  if (!marker) {
    throw new Error(
      `Inference-local prototype returned no result marker:\n${result.stdout.slice(-8_000)}`,
    );
  }
  const evidence = JSON.parse(marker.slice(RESULT_PREFIX.length)) as Evidence;
  if (
    evidence.status !== "pass" ||
    evidence.architecture !== "supervised-hermes-native-relay-switchyard-inference-local" ||
    evidence.provider_boundary !== "https://inference.local" ||
    evidence.route_model_contract !== "gateway-forced-single-model" ||
    evidence.caller_authorization_probe_succeeded !== true ||
    evidence.classifier_provider_authorization_absent !== true ||
    evidence.provider_placeholder_present !== true ||
    evidence.raw_provider_credentials_absent !== true ||
    evidence.gateway_pid_stable !== true ||
    evidence.relay_sidecar_processes !== 0 ||
    evidence.turns?.length !== 2 ||
    !Number.isInteger(evidence.gateway_pid_before) ||
    evidence.gateway_pid_before !== evidence.gateway_pid_after
  ) {
    throw new Error(`Inference-local evidence failed its contract: ${JSON.stringify(evidence)}`);
  }
  return evidence;
}

function restartGateway(sandboxName: string): void {
  const result = spawnSync(
    process.execPath,
    [cli, "sandbox", "gateway", "restart", sandboxName, "--quiet"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 3 * 60_000,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(-12_000);
    throw new Error(
      result.error?.message ?? `Gateway restart failed (${result.status}):\n${detail}`,
    );
  }
}

function verifyProviderLog(
  providerLog: ProviderLogIdentity,
  startLine: number,
): { model: string; requests: number } {
  const appended = providerLogSnapshot(providerLog).lines.slice(startLine);
  const raw = appended.join("\n");
  if (raw.includes("nemoclaw-v3-untrusted-caller-value")) {
    throw new Error("Host provider log exposed the caller-supplied authorization value");
  }
  const posts = appended
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.method === "POST" && entry.rejected == null);
  if (posts.length < 3 || posts.some((entry) => entry.auth_matches !== true)) {
    throw new Error(
      `Host provider did not observe three gateway-authenticated requests (observed ${posts.length})`,
    );
  }
  const models = new Set(posts.map((entry) => String(entry.model ?? "")));
  if (
    models.size !== 1 ||
    models.has("") ||
    models.has("caller-supplied-model") ||
    models.has("nemoclaw-switchyard-efficient") ||
    models.has("nemoclaw-switchyard-capable")
  ) {
    throw new Error(
      `OpenShell did not enforce one host-selected model: ${JSON.stringify([...models])}`,
    );
  }
  return { model: [...models][0], requests: posts.length };
}

function printTurns(evidence: Evidence): void {
  for (const [index, turn] of evidence.turns?.entries() ?? []) {
    console.log(`Turn ${index + 1}: ${String(turn.classifier).toUpperCase()} → ${turn.route}`);
    console.log(`  Provider boundary: ${turn.target}`);
    console.log(`  Hermes: ${turn.answer}\n`);
  }
}

const options = parseOptions(process.argv.slice(2));
const providerLogStart = options.providerLog
  ? providerLogSnapshot(options.providerLog).lines.length
  : 0;

console.log("\nHermes → native Relay → Switchyard → inference.local (NemoClaw-managed)\n");
const before = runProof(options.sandboxName);
printTurns(before);

let after: Evidence | undefined;
if (options.restart) {
  const oldPid = before.gateway_pid_after as number;
  restartGateway(options.sandboxName);
  after = runProof(options.sandboxName);
  const newPid = after.gateway_pid_before as number;
  if (oldPid === newPid) throw new Error(`Gateway restart did not replace Hermes PID ${oldPid}`);
  console.log(`Restart proof: supervised Hermes PID ${oldPid} → ${newPid}; V3 passed again.\n`);
}

const hostBoundary = options.providerLog
  ? verifyProviderLog(options.providerLog, providerLogStart)
  : undefined;
if (hostBoundary) {
  console.log(
    `OpenShell proof: ${hostBoundary.requests} requests received a gateway-owned credential and were forced to host model ${hostBoundary.model}.`,
  );
} else {
  console.log(
    "Sandbox proof passed. Add --provider-log for an independently observable fixture-credential proof.",
  );
}
console.log(
  "Current limit: inference.local exposes one host-selected model, so weak/strong decisions do not yet select two simultaneous real models.",
);
console.log(
  JSON.stringify(
    {
      after_restart: after,
      before_restart: before,
      host_provider_boundary: hostBoundary,
      status: "pass",
    },
    null,
    2,
  ),
);
