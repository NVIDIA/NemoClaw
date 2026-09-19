#!/usr/bin/env -S node --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMMUTABLE_REFERENCE_PATTERN =
  /^(?:sha256:[0-9a-f]{64}|[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+@sha256:[0-9a-f]{64})$/u;
const PLATFORM_PATTERN = /^linux\/(?:amd64|arm64)$/u;
const SUCCESS_MARKER = "nemoclaw-dcode-runtime-contract-ok";
const VALIDATOR_PATH = "/usr/local/lib/nemoclaw/validate-dcode-runtime-contract.py";

export type DockerRunner = (args: readonly string[]) => string;

function dockerFailureClass(error: unknown): string {
  if (!error || typeof error !== "object" || !("stderr" in error)) {
    return "Docker command failed without a runtime diagnostic";
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail =
    typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : "";
  const missingModule = detail.match(
    /ModuleNotFoundError:\s+No module named ['"](deepagents_code|deepagents)['"]/u,
  )?.[1];
  return missingModule
    ? `missing required runtime module: ${missingModule}`
    : "Docker command failed without a recognized runtime diagnostic";
}

export function dcodeRuntimeValidationArgs(reference: string, platform: string): readonly string[] {
  if (!IMMUTABLE_REFERENCE_PATTERN.test(reference)) {
    throw new Error("Deep Agents Code runtime validation requires an immutable image reference");
  }
  if (!PLATFORM_PATTERN.test(platform)) {
    throw new Error("Deep Agents Code runtime validation requires linux/amd64 or linux/arm64");
  }
  return [
    "run",
    "--rm",
    "--platform",
    platform,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--user",
    "999:999",
    "--entrypoint",
    "/opt/venv/bin/python3",
    reference,
    "-I",
    VALIDATOR_PATH,
  ];
}

export function validateDcodeRuntimeContract(
  reference: string,
  platform: string,
  runDocker: DockerRunner = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }),
): void {
  const args = dcodeRuntimeValidationArgs(reference, platform);
  let output: string;
  try {
    output = runDocker(args);
  } catch (error) {
    throw new Error(
      `Deep Agents Code runtime contract validation failed for reference=${JSON.stringify(reference)} platform=${JSON.stringify(platform)}: ${dockerFailureClass(error)}`,
    );
  }
  if (output.trim() !== SUCCESS_MARKER) {
    throw new Error("Deep Agents Code runtime contract validation returned invalid evidence");
  }
}

function requiredArgument(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1 || argv.indexOf(name, index + 1) >= 0) {
    throw new Error(`expected one ${name} argument`);
  }
  return argv[index + 1] ?? "";
}

export function main(argv = process.argv.slice(2)): void {
  if (argv.length !== 4) {
    throw new Error(
      "usage: validate-dcode-runtime-contract.mts --reference <digest> --platform <platform>",
    );
  }
  validateDcodeRuntimeContract(
    requiredArgument(argv, "--reference"),
    requiredArgument(argv, "--platform"),
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Deep Agents Code runtime validation failed",
    );
    process.exitCode = 1;
  }
}
