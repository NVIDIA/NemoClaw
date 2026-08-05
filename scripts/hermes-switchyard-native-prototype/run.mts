#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RESULT_PREFIX = "NEMOCLAW_HERMES_SWITCHYARD_NATIVE=";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../bin/nemohermes.js", import.meta.url));
const arguments_ = process.argv.slice(2);
const sandboxName = arguments_[0]?.trim();
const restart = arguments_.includes("--restart");

if (
  !sandboxName ||
  !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(sandboxName) ||
  arguments_.some((argument, index) => index > 0 && argument !== "--restart") ||
  arguments_.filter((argument) => argument === "--restart").length > 1
) {
  console.error("Usage: npm run prototype:hermes-switchyard:native -- <sandbox-name> [--restart]");
  process.exit(2);
}

type Evidence = {
  architecture?: unknown;
  gateway_pid_after?: unknown;
  gateway_pid_before?: unknown;
  gateway_pid_stable?: unknown;
  provider_authorization_absent?: unknown;
  relay_sidecar_processes?: unknown;
  status?: unknown;
  turns?: Array<{ answer?: unknown; classifier?: unknown; route?: unknown; target?: unknown }>;
};

function runProof(): Evidence {
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
      "/usr/local/lib/nemoclaw/switchyard-native-run-in-sandbox.sh",
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
      result.error?.message ?? `Native prototype failed (${result.status}):\n${detail}`,
    );
  }

  const marker = result.stdout.split(/\r?\n/u).find((line) => line.startsWith(RESULT_PREFIX));
  if (!marker)
    throw new Error(`Native prototype returned no result marker:\n${result.stdout.slice(-8_000)}`);

  const evidence = JSON.parse(marker.slice(RESULT_PREFIX.length)) as Evidence;
  if (
    evidence.status !== "pass" ||
    evidence.architecture !== "supervised-hermes-native-relay-dynamic-switchyard" ||
    evidence.gateway_pid_stable !== true ||
    evidence.provider_authorization_absent !== true ||
    evidence.relay_sidecar_processes !== 0 ||
    evidence.turns?.length !== 2 ||
    !Number.isInteger(evidence.gateway_pid_before) ||
    evidence.gateway_pid_before !== evidence.gateway_pid_after
  ) {
    throw new Error(`Native prototype evidence failed its contract: ${JSON.stringify(evidence)}`);
  }
  return evidence;
}

function restartGateway(): void {
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

function printTurns(evidence: Evidence): void {
  for (const [index, turn] of evidence.turns?.entries() ?? []) {
    console.log(`Turn ${index + 1}: ${String(turn.classifier).toUpperCase()} → ${turn.route}`);
    console.log(`  Target: ${turn.target}`);
    console.log(`  Hermes: ${turn.answer}\n`);
  }
}

console.log("\nHermes → native Relay → dynamic Switchyard (NemoClaw-managed)\n");
const before = runProof();
printTurns(before);

if (restart) {
  const oldPid = before.gateway_pid_after as number;
  restartGateway();
  const after = runProof();
  const newPid = after.gateway_pid_before as number;
  if (oldPid === newPid) throw new Error(`Gateway restart did not replace Hermes PID ${oldPid}`);
  console.log(`Restart proof: supervised Hermes PID ${oldPid} → ${newPid}; routing passed again.`);
  console.log(
    JSON.stringify(
      {
        after_restart: after,
        before_restart: before,
        gateway_pid_replaced: true,
        status: "pass",
      },
      null,
      2,
    ),
  );
} else {
  console.log("Proof: one supervised Hermes PID, zero Relay sidecars, no provider credential.");
  console.log(JSON.stringify(before, null, 2));
}
