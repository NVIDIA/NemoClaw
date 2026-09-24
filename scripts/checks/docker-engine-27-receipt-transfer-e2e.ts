// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dockerDaemonReceiptMount,
  transferDockerReceiptToDaemon,
} from "../../src/lib/onboard/managed-startup/docker-receipt-transfer.ts";

const DIND_IMAGE =
  "docker.io/library/docker:27.5.1-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce";
const RECEIPT_IMAGE =
  "docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";
const RECEIPT_VOLUME_DIRECTORY = "/run/nemoclaw/managed-startup-receipt-transfer";
const DAEMON_OWNER_LABEL = "io.nvidia.nemoclaw.e2e.docker27-receipt";
export const DOCKER_ENGINE_27_OPERATION_TIMEOUT_MS = 30_000;
export const DOCKER_ENGINE_27_PULL_TIMEOUT_MS = 120_000;
export const DOCKER_ENGINE_27_CLEANUP_TIMEOUT_MS = 15_000;
export const DOCKER_ENGINE_27_READINESS_ATTEMPTS = 45;
export const DOCKER_ENGINE_27_READINESS_COMMAND_TIMEOUT_MS = 5_000;
export const DOCKER_ENGINE_27_READINESS_INTERVAL_MS = 1_000;
export const DOCKER_ENGINE_27_MAX_OPERATION_COUNT = 28;
export const DOCKER_ENGINE_27_PULL_COUNT = 2;
export const DOCKER_ENGINE_27_CLEANUP_OPERATION_COUNT = 3;
export const DOCKER_ENGINE_27_PROCESS_ALLOWANCE_MS = 60_000;
export const DOCKER_ENGINE_27_MINIMUM_PROBE_TIMEOUT_MS =
  DOCKER_ENGINE_27_READINESS_ATTEMPTS *
    (DOCKER_ENGINE_27_READINESS_COMMAND_TIMEOUT_MS + DOCKER_ENGINE_27_READINESS_INTERVAL_MS) +
  DOCKER_ENGINE_27_MAX_OPERATION_COUNT * DOCKER_ENGINE_27_OPERATION_TIMEOUT_MS +
  DOCKER_ENGINE_27_PULL_COUNT * DOCKER_ENGINE_27_PULL_TIMEOUT_MS +
  DOCKER_ENGINE_27_CLEANUP_OPERATION_COUNT * DOCKER_ENGINE_27_CLEANUP_TIMEOUT_MS +
  DOCKER_ENGINE_27_PROCESS_ALLOWANCE_MS;
export const DOCKER_ENGINE_27_MINIMUM_CLEANUP_PROCESS_TIMEOUT_MS =
  DOCKER_ENGINE_27_CLEANUP_OPERATION_COUNT * DOCKER_ENGINE_27_CLEANUP_TIMEOUT_MS +
  DOCKER_ENGINE_27_PROCESS_ALLOWANCE_MS / 2;

export type DockerEngine27Platform = "linux/amd64" | "linux/arm64";

export function dockerEngine27ReceiptDaemonName(
  runId: number | string,
  runAttempt: number | string,
  platform: DockerEngine27Platform,
): string {
  const run = String(runId);
  const attempt = String(runAttempt);
  requireCondition(/^[1-9][0-9]{0,15}$/u.test(run), "Docker Engine 27 run ID is invalid");
  requireCondition(/^[1-9][0-9]{0,5}$/u.test(attempt), "Docker Engine 27 run attempt is invalid");
  requireCondition(
    platform === "linux/amd64" || platform === "linux/arm64",
    "Docker Engine 27 platform is invalid",
  );
  return `nemoclaw-receipt-engine27-${run}-${attempt}-${platform.replace("/", "-")}`;
}

export function dockerEngine27ReceiptIdentityArguments(
  runId: number | string,
  runAttempt: number | string,
  platform: DockerEngine27Platform,
): string[] {
  dockerEngine27ReceiptDaemonName(runId, runAttempt, platform);
  return ["--run-id", String(runId), "--run-attempt", String(runAttempt), "--platform", platform];
}

export type CommandResult = {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

type DockerCommandProfile = "cleanup" | "operation" | "pull" | "readiness";

function runDocker(
  args: readonly string[],
  profile: DockerCommandProfile = "operation",
): CommandResult {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: profile === "operation" || profile === "pull" ? 8 * 1024 * 1024 : 1024 * 1024,
    timeout:
      profile === "pull"
        ? DOCKER_ENGINE_27_PULL_TIMEOUT_MS
        : profile === "readiness"
          ? DOCKER_ENGINE_27_READINESS_COMMAND_TIMEOUT_MS
          : profile === "cleanup"
            ? DOCKER_ENGINE_27_CLEANUP_TIMEOUT_MS
            : DOCKER_ENGINE_27_OPERATION_TIMEOUT_MS,
  });
  return {
    ...(result.error ? { error: result.error } : {}),
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function commandDetail(result: CommandResult): string {
  return `${result.stderr} ${result.stdout} ${result.error?.message ?? ""}`.trim().slice(-1_600);
}

function requireSuccess(result: CommandResult, operation: string): string {
  if (result.status !== 0) {
    throw new Error(`${operation} failed: ${commandDetail(result)}`);
  }
  return result.stdout.trim();
}

function requireCondition(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

async function waitForDocker27(daemonName: string): Promise<void> {
  for (let attempt = 0; attempt < DOCKER_ENGINE_27_READINESS_ATTEMPTS; attempt += 1) {
    if (runDocker(["exec", daemonName, "docker", "info"], "readiness").status === 0) return;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, DOCKER_ENGINE_27_READINESS_INTERVAL_MS),
    );
  }
  throw new Error("Docker Engine 27 daemon did not become ready");
}

function seedName(args: readonly string[]): string {
  const nameIndex = args.indexOf("--name");
  requireCondition(nameIndex >= 0 && args[nameIndex + 1], "receipt seed command omitted --name");
  return args[nameIndex + 1];
}

function assertSeedIsolation(
  innerDocker: (args: readonly string[]) => CommandResult,
  name: string,
): void {
  const inspected = JSON.parse(
    requireSuccess(innerDocker(["inspect", name]), "inspect receipt seed"),
  );
  requireCondition(
    Array.isArray(inspected) && inspected.length === 1,
    "receipt seed inspect changed shape",
  );
  validateDockerEngine27SeedIsolation(inspected[0]);
}

export function validateDockerEngine27SeedIsolation(value: unknown): void {
  requireCondition(typeof value === "object" && value !== null, "receipt seed inspect is invalid");
  const seed = value as {
    Config?: { User?: unknown };
    HostConfig?: {
      CapDrop?: unknown;
      Mounts?: unknown;
      NetworkMode?: unknown;
      Privileged?: unknown;
      ReadonlyRootfs?: unknown;
      SecurityOpt?: unknown;
    };
  };
  requireCondition(seed.Config?.User === "0", "receipt seed did not use numeric root");
  requireCondition(seed.HostConfig?.NetworkMode === "none", "receipt seed retained networking");
  requireCondition(seed.HostConfig?.Privileged === false, "receipt seed was privileged");
  requireCondition(seed.HostConfig?.ReadonlyRootfs === true, "receipt seed root was writable");
  requireCondition(
    Array.isArray(seed.HostConfig?.SecurityOpt) &&
      seed.HostConfig.SecurityOpt.includes("no-new-privileges"),
    "receipt seed omitted no-new-privileges",
  );
  requireCondition(
    Array.isArray(seed.HostConfig?.CapDrop) && seed.HostConfig.CapDrop.includes("ALL"),
    "receipt seed retained capabilities",
  );
  requireCondition(
    Array.isArray(seed.HostConfig?.Mounts) &&
      seed.HostConfig.Mounts.some(
        (mount) =>
          typeof mount === "object" &&
          mount !== null &&
          Reflect.get(mount, "Type") === "volume" &&
          Reflect.get(mount, "Target") === RECEIPT_VOLUME_DIRECTORY,
      ),
    "receipt seed omitted the daemon volume",
  );
}

export function requireDockerResourceAbsent(result: CommandResult, resource: string): void {
  const detail = commandDetail(result);
  requireCondition(
    result.status !== 0 && /\bno such (?:container|object|volume)\b/iu.test(detail),
    `${resource} absence was not proven after receipt-transfer cleanup: ${detail}`,
  );
}

export function cleanupDockerEngine27ReceiptDaemon(daemonName: string): void {
  const inspected = runDocker(
    [
      "container",
      "inspect",
      "--format",
      `{{ index .Config.Labels "${DAEMON_OWNER_LABEL}" }}`,
      daemonName,
    ],
    "cleanup",
  );
  if (inspected.status !== 0) {
    requireCondition(
      /No such (?:container|object)/iu.test(commandDetail(inspected)),
      `could not inspect Docker Engine 27 daemon during cleanup: ${commandDetail(inspected)}`,
    );
    return;
  }
  requireCondition(
    inspected.stdout.trim() === daemonName,
    "refusing to remove a Docker Engine 27 daemon with mismatched ownership",
  );
  requireSuccess(runDocker(["rm", "-f", daemonName], "cleanup"), "remove Docker Engine 27 daemon");
  requireDockerResourceAbsent(
    runDocker(["container", "inspect", daemonName], "cleanup"),
    "Docker Engine 27 daemon",
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function finalizeDockerEngine27ReceiptProbe(
  primaryError: unknown | null,
  cleanupDaemon: () => void,
  cleanupFixture: () => void,
): void {
  const cleanupErrors: unknown[] = [];
  try {
    cleanupDaemon();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    cleanupFixture();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== null) {
    if (cleanupErrors.length === 0) throw primaryError;
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `Docker Engine 27 receipt probe failed: ${errorDetail(primaryError)}; cleanup also failed: ${cleanupErrors.map(errorDetail).join("; ")}`,
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Docker Engine 27 receipt probe cleanup failed: ${cleanupErrors.map(errorDetail).join("; ")}`,
    );
  }
}

async function verifyDockerEngine27ReceiptTransfer(daemonName: string): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const legacySeed = `nemoclaw-receipt-legacy-seed-${suffix}`;
  const legacyVolume = `nemoclaw-receipt-legacy-volume-${suffix}`;
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-receipt-engine27-"));
  const fixtureReceipt = path.join(fixtureRoot, "receipt");
  const daemonReceipt = `/nemoclaw-receipt-${suffix}`;
  let primaryError: unknown | null = null;
  let successfulVolume: string | null = null;

  fs.mkdirSync(fixtureReceipt, { mode: 0o700 });
  fs.writeFileSync(path.join(fixtureReceipt, "receipt.json"), "verified\n", { mode: 0o400 });

  const innerDocker = (args: readonly string[]): CommandResult =>
    runDocker(["exec", daemonName, "docker", ...args]);

  try {
    requireSuccess(
      runDocker(["pull", DIND_IMAGE], "pull"),
      "pull digest-pinned Docker Engine 27 image",
    );
    requireSuccess(
      runDocker([
        "run",
        "--pull",
        "never",
        "--privileged",
        "--detach",
        "--name",
        daemonName,
        "--label",
        `${DAEMON_OWNER_LABEL}=${daemonName}`,
        "--env",
        "DOCKER_TLS_CERTDIR=",
        DIND_IMAGE,
        "--host=unix:///var/run/docker.sock",
      ]),
      "start isolated Docker Engine 27 daemon",
    );
    await waitForDocker27(daemonName);
    const engineVersion = requireSuccess(
      innerDocker(["version", "--format", "{{.Server.Version}}"]),
      "read isolated Docker version",
    );
    requireCondition(
      engineVersion === "27.5.1",
      `unexpected Docker Engine version ${engineVersion}`,
    );

    requireSuccess(
      runDocker(["exec", daemonName, "docker", "pull", RECEIPT_IMAGE], "pull"),
      "pull digest-pinned receipt image",
    );
    requireSuccess(
      runDocker(["cp", fixtureReceipt, `${daemonName}:${daemonReceipt}`]),
      "stage protected receipt in Docker Engine 27 client",
    );

    requireSuccess(innerDocker(["volume", "create", legacyVolume]), "create legacy probe volume");
    requireSuccess(
      innerDocker([
        "create",
        "--name",
        legacySeed,
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--mount",
        `type=volume,src=${legacyVolume},dst=${RECEIPT_VOLUME_DIRECTORY}`,
        RECEIPT_IMAGE,
      ]),
      "create legacy receipt seed",
    );
    const legacyCopy = innerDocker([
      "cp",
      "-a",
      daemonReceipt,
      `${legacySeed}:${RECEIPT_VOLUME_DIRECTORY}/receipt`,
    ]);
    requireCondition(legacyCopy.status !== 0, "Docker Engine 27 unexpectedly accepted --user 0:0");
    requireCondition(
      /unable to find entry "0:0" in passwd(?: database)?/u.test(commandDetail(legacyCopy)),
      `Docker Engine 27 returned an unexpected legacy failure: ${commandDetail(legacyCopy)}`,
    );
    requireSuccess(innerDocker(["rm", "-f", legacySeed]), "remove legacy receipt seed");
    requireSuccess(innerDocker(["volume", "rm", legacyVolume]), "remove legacy receipt volume");

    let successfulSeed = "";
    const dockerRun = (args: readonly string[]): CommandResult => {
      const result = innerDocker(args);
      if (args[0] === "create" && result.status === 0) {
        successfulSeed = seedName(args);
        assertSeedIsolation(innerDocker, successfulSeed);
      }
      return result;
    };
    const receipt = transferDockerReceiptToDaemon({
      image: RECEIPT_IMAGE,
      receiptPath: daemonReceipt,
      destinations: ["/run/nemoclaw/receipt"],
      dockerOptions: {},
      dockerRun,
    });
    successfulVolume = receipt.volumeName;
    requireCondition(successfulSeed.length > 0, "receipt transfer did not create a seed");
    requireDockerResourceAbsent(
      innerDocker(["container", "inspect", successfulSeed]),
      "successful receipt seed",
    );
    requireSuccess(
      innerDocker([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--mount",
        dockerDaemonReceiptMount(receipt, "/run/nemoclaw/receipt"),
        RECEIPT_IMAGE,
        "sh",
        "-ceu",
        [
          'test "$(cat /run/nemoclaw/receipt/receipt.json)" = verified',
          'test "$(stat -c %u:%g:%a /run/nemoclaw/receipt)" = 0:0:700',
          'test "$(stat -c %u:%g:%a /run/nemoclaw/receipt/receipt.json)" = 0:0:400',
          "! touch /run/nemoclaw/receipt/write-denied",
        ].join(" && "),
      ]),
      "verify Docker Engine 27 receipt volume",
    );
    requireSuccess(innerDocker(["volume", "rm", receipt.volumeName]), "remove receipt volume");
    successfulVolume = null;

    let failedSeed = "";
    let failedVolume = "";
    const failingDockerRun = (args: readonly string[]): CommandResult => {
      if (args[0] === "volume" && args[1] === "create") failedVolume = String(args.at(-1) ?? "");
      if (args[0] === "create") failedSeed = seedName(args);
      return innerDocker(args);
    };
    const missingReceipt = `/nemoclaw-missing-receipt-${suffix}`;
    let transferFailure: unknown;
    try {
      transferDockerReceiptToDaemon({
        image: RECEIPT_IMAGE,
        receiptPath: missingReceipt,
        destinations: ["/run/nemoclaw/receipt"],
        dockerOptions: {},
        dockerRun: failingDockerRun,
      });
    } catch (error) {
      transferFailure = error;
    }
    requireCondition(transferFailure instanceof Error, "missing receipt transfer did not fail");
    requireCondition(
      transferFailure.message.includes(`host receipt ${missingReceipt}`),
      "receipt failure omitted the retained host receipt",
    );
    requireCondition(
      failedSeed.length > 0 && failedVolume.length > 0,
      "failed transfer omitted resources",
    );
    requireDockerResourceAbsent(
      innerDocker(["container", "inspect", failedSeed]),
      "failed receipt seed",
    );
    requireDockerResourceAbsent(
      innerDocker(["volume", "inspect", failedVolume]),
      "failed receipt volume",
    );
  } catch (error) {
    primaryError = error;
  }
  finalizeDockerEngine27ReceiptProbe(
    primaryError,
    () => {
      innerDocker(["rm", "-f", legacySeed]);
      innerDocker(["volume", "rm", legacyVolume]);
      if (successfulVolume) innerDocker(["volume", "rm", successfulVolume]);
      cleanupDockerEngine27ReceiptDaemon(daemonName);
    },
    () => fs.rmSync(fixtureRoot, { force: true, recursive: true }),
  );
}

function requiredArgument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? "" : String(args[index + 1] ?? "");
  requireCondition(value.length > 0, `Docker Engine 27 probe requires ${name}`);
  return value;
}

function daemonNameFromArguments(args: readonly string[]): string {
  const platform = requiredArgument(args, "--platform");
  requireCondition(
    platform === "linux/amd64" || platform === "linux/arm64",
    "Docker Engine 27 platform is invalid",
  );
  return dockerEngine27ReceiptDaemonName(
    requiredArgument(args, "--run-id"),
    requiredArgument(args, "--run-attempt"),
    platform,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const daemonName = daemonNameFromArguments(args);
  const operation = args.includes("--cleanup-only")
    ? Promise.resolve().then(() => cleanupDockerEngine27ReceiptDaemon(daemonName))
    : verifyDockerEngine27ReceiptTransfer(daemonName);
  void operation.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
