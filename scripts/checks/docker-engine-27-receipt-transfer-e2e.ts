// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  dockerDaemonReceiptMount,
  transferDockerReceiptToDaemon,
} from "../../src/lib/onboard/managed-startup/docker-receipt-transfer.ts";

const DIND_IMAGE =
  "docker.io/library/docker:27.5.1-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce";
const RECEIPT_IMAGE =
  "docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";
const RECEIPT_VOLUME_DIRECTORY = "/run/nemoclaw/managed-startup-receipt-transfer";

type CommandResult = {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

function runDocker(args: readonly string[]): CommandResult {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 240_000,
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

async function waitForDocker27(
  innerDocker: (args: readonly string[]) => CommandResult,
): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (innerDocker(["info"]).status === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
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
  const seed = inspected[0] as {
    Config?: { User?: unknown };
    HostConfig?: {
      CapDrop?: unknown;
      Mounts?: unknown;
      NetworkMode?: unknown;
      ReadonlyRootfs?: unknown;
      SecurityOpt?: unknown;
    };
  };
  requireCondition(seed.Config?.User === "0", "receipt seed did not use numeric root");
  requireCondition(seed.HostConfig?.NetworkMode === "none", "receipt seed retained networking");
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

function requireAbsent(result: CommandResult, resource: string): void {
  requireCondition(result.status !== 0, `${resource} remained after receipt-transfer cleanup`);
}

async function verifyDockerEngine27ReceiptTransfer(): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const daemonName = `nemoclaw-receipt-engine27-${suffix}`;
  const legacySeed = `nemoclaw-receipt-legacy-seed-${suffix}`;
  const legacyVolume = `nemoclaw-receipt-legacy-volume-${suffix}`;
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-receipt-engine27-"));
  const fixtureReceipt = path.join(fixtureRoot, "receipt");
  const daemonReceipt = `/nemoclaw-receipt-${suffix}`;
  let successfulVolume: string | null = null;

  fs.mkdirSync(fixtureReceipt, { mode: 0o700 });
  fs.writeFileSync(path.join(fixtureReceipt, "receipt.json"), "verified\n", { mode: 0o400 });

  const innerDocker = (args: readonly string[]): CommandResult =>
    runDocker(["exec", daemonName, "docker", ...args]);

  try {
    requireSuccess(
      runDocker([
        "run",
        "--privileged",
        "--detach",
        "--name",
        daemonName,
        "--env",
        "DOCKER_TLS_CERTDIR=",
        DIND_IMAGE,
        "--host=unix:///var/run/docker.sock",
      ]),
      "start isolated Docker Engine 27 daemon",
    );
    await waitForDocker27(innerDocker);
    const engineVersion = requireSuccess(
      innerDocker(["version", "--format", "{{.Server.Version}}"]),
      "read isolated Docker version",
    );
    requireCondition(
      engineVersion === "27.5.1",
      `unexpected Docker Engine version ${engineVersion}`,
    );

    requireSuccess(innerDocker(["pull", RECEIPT_IMAGE]), "pull digest-pinned receipt image");
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
    requireAbsent(innerDocker(["container", "inspect", successfulSeed]), "successful receipt seed");
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
      if (args[0] === "volume" && args[1] === "create") failedVolume = String(args[2] ?? "");
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
    requireAbsent(innerDocker(["container", "inspect", failedSeed]), "failed receipt seed");
    requireAbsent(innerDocker(["volume", "inspect", failedVolume]), "failed receipt volume");
  } finally {
    innerDocker(["rm", "-f", legacySeed]);
    innerDocker(["volume", "rm", legacyVolume]);
    if (successfulVolume) innerDocker(["volume", "rm", successfulVolume]);
    runDocker(["rm", "-f", daemonName]);
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

void verifyDockerEngine27ReceiptTransfer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
