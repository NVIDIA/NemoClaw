// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid scan evidence.");
  }
  return value as RecordValue;
}

// Never include scanner-controlled text in an error or public summary.
export function scanPassed(kind: string, exitCode: number, source: string): boolean {
  if (kind === "secrets") {
    if (![0, 185, 189].includes(exitCode)) return false;
    const results = source.split(/\r?\n/u).filter((line) => line.trim());
    const verified = results.map((line) => {
      const result = record(JSON.parse(line));
      if (typeof result.Verified !== "boolean") throw new Error("Invalid scan evidence.");
      return result.Verified;
    });
    // 189 means all findings were allowlisted by the repository's reviewed allowlist.
    return exitCode === 189 || !verified.some(Boolean);
  }
  if (exitCode !== 0) return false;
  const report = record(JSON.parse(source));
  if (kind === "vulnerabilities") {
    if (!Array.isArray(report.matches)) throw new Error("Invalid scan evidence.");
    return report.matches.every((match) => {
      const severity = record(record(match).vulnerability).severity;
      if (typeof severity !== "string") throw new Error("Invalid scan evidence.");
      return severity.toLowerCase() !== "critical";
    });
  }
  if (kind === "malware") {
    const data = record(report.data);
    if (!Array.isArray(data.report)) throw new Error("Invalid scan evidence.");
    return data.status === "CLEAN";
  }
  throw new Error("Unknown scan category.");
}

export function candidateReference(value: unknown, env: NodeJS.ProcessEnv): string {
  const candidate = record(value);
  const source = record(candidate.source);
  const run = record(candidate.run);
  const evidence = record(candidate.publicationEvidence);
  const workload = record(evidence.workloadDescriptor);
  const platform = record(workload.platform);
  const digest = /^sha256:[0-9a-f]{64}$/u;
  if (
    candidate.contractVersion !== 2 ||
    candidate.phase !== "candidate" ||
    candidate.agent !== env.AGENT ||
    candidate.platform !== env.PLATFORM ||
    candidate.image !== env.IMAGE ||
    typeof candidate.digest !== "string" ||
    !digest.test(candidate.digest) ||
    candidate.reference !== `${candidate.image}@${candidate.digest}` ||
    source.repository !== "NVIDIA/NemoClaw" ||
    source.repository !== env.GITHUB_REPOSITORY ||
    source.revision !== env.GITHUB_SHA ||
    source.ref !== "refs/heads/main" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    run.id !== Number(env.GITHUB_RUN_ID) ||
    !Number.isSafeInteger(run.attempt) ||
    Number(run.attempt) < 1 ||
    Number(run.attempt) > Number(env.GITHUB_RUN_ATTEMPT) ||
    typeof workload.digest !== "string" ||
    !digest.test(workload.digest) ||
    workload.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    `${platform.os}/${platform.architecture}` !== env.PLATFORM
  ) {
    throw new Error("Candidate does not belong to this publication.");
  }
  // Scan the platform workload, not the OCI index containing its attestations.
  return `${candidate.image}@${workload.digest}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === "candidate" && args.length === 1) {
      process.stdout.write(
        candidateReference(JSON.parse(readFileSync(args[0]!, "utf8")), process.env),
      );
    } else if (mode === "result" && args.length === 3) {
      const code = Number(args[1]);
      if (!Number.isSafeInteger(code) || code < 0 || code > 255)
        throw new Error("Invalid exit code.");
      process.exitCode = scanPassed(args[0]!, code, readFileSync(args[2]!, "utf8")) ? 0 : 1;
    } else {
      throw new Error("Invalid arguments.");
    }
  } catch {
    console.error("Scan evidence is missing, invalid, or blocking.");
    process.exitCode = 1;
  }
}
