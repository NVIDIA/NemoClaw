// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./installer-sourced-env";

type CommandOptions = {
  cwd?: string;
  encoding?: BufferEncoding;
  env?: NodeJS.ProcessEnv;
  input?: string;
  killSignal?: NodeJS.Signals;
  timeout?: number;
};

export type InstallerCommandResult = {
  error: Error | undefined;
  status: number | null;
  stderr: string;
  stdout: string;
};

const repoRoot = path.resolve(import.meta.dirname, "../..");
const firmwareStates = [
  [/(?:^|[^A-Za-z0-9])Station[\s_-]+GB300(?:$|[^A-Za-z0-9])/iu, "station-gb300"],
  [/DGX[\s_-]+Spark/iu, "spark"],
  [/(?:^|[^A-Za-z0-9])P3830(?:$|[^A-Za-z0-9])|DGX[\s_-]+Station/iu, "station-other"],
  [/Jetson|Tegra|Thor|Orin|Xavier/iu, "jetson"],
] as const;

function firmwareStateForProduct(productName: string): string {
  return firmwareStates.find(([pattern]) => pattern.test(productName))?.[1] ?? "not-station";
}

export function runInstallerCommand(
  file: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<InstallerCommandResult> {
  return new Promise((resolve) => {
    const { encoding: _encoding, input, ...execOptions } = options;
    const child = execFile(
      file,
      [...args],
      { ...execOptions, encoding: "utf-8" },
      (error, stdout, stderr) => {
        const exitCode = error?.code;
        resolve({
          error: error && typeof exitCode !== "number" ? error : undefined,
          status: error ? (typeof exitCode === "number" ? exitCode : child.exitCode) : 0,
          stderr,
          stdout,
        });
      },
    );
    child.stdin?.end(input);
  });
}

export async function detectExpressPlatform(
  productName: string,
  releasePath: string,
  extraEnv: Record<string, string> = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-platform-detect-"));
  try {
    return await runInstallerCommand(
      "bash",
      [
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
classify_dgx_station_release() {
  if [[ -z "$EXPRESS_DGX_RELEASE_PATH" ]]; then
    printf "generic-ubuntu"
    return
  fi
  bash -c '
    source "$STATION_PREPARE" >/dev/null
    dgx_station_release_file_is_safe() { return 0; }
    dgx_station_release_state "$EXPRESS_DGX_RELEASE_PATH"
  '
}
classify_dgx_station_hardware() { printf "%s" "$EXPRESS_FIRMWARE_STATE"; }
function [ {
  if [[ "$#" -eq 3 && "$1" = "-r" && "$2" = "/sys/class/dmi/id/product_name" && "$3" = "]" ]]; then
    return 0
  fi
  builtin [ "$@"
}
cat() {
  if [[ "$#" -eq 1 && "$1" = "/sys/class/dmi/id/product_name" ]]; then
    printf "%s" "$EXPRESS_PRODUCT_NAME"
    return
  fi
  command cat "$@"
}
is_wsl_host() { return 1; }
detect_express_platform
`,
      ],
      {
        cwd: repoRoot,
        env: {
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          STATION_PREPARE: path.join(repoRoot, "scripts", "prepare-dgx-station-host.sh"),
          EXPRESS_PRODUCT_NAME: productName,
          EXPRESS_FIRMWARE_STATE: firmwareStateForProduct(productName),
          EXPRESS_DGX_RELEASE_PATH: releasePath,
          ...extraEnv,
        },
      },
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export function detectExpressPlatformForProductName(productName: string) {
  return detectExpressPlatform(productName, "");
}

export async function detectExpressPlatformForStockDgxRelease(
  productName: string,
  dgxRelease: string,
) {
  const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dgx-release-"));
  const releasePath = path.join(releaseRoot, "dgx-release");
  fs.writeFileSync(releasePath, dgxRelease);
  try {
    return await detectExpressPlatform(productName, releasePath);
  } finally {
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
}

export function stockDgxRelease(
  version: string,
  platform = "DGX Server for GALAXY-GB300",
  otaPrettyName: string | null = "DGX OS",
) {
  return [
    'DGX_NAME="DGX Server"',
    'DGX_PRETTY_NAME="NVIDIA DGX Server"',
    ...(otaPrettyName === null ? [] : [`DGX_OTA_PRETTY_NAME="${otaPrettyName}"`]),
    `DGX_OTA_VERSION="${version}"`,
    'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
    `DGX_PLATFORM="${platform}"`,
    'DGX_SERIAL_NUMBER="Unknown"',
    "",
  ].join("\n");
}

export function noOtaFactoryRelease(profile: "colossus-baseos" | "ai-developer-tools") {
  const identity =
    profile === "colossus-baseos"
      ? {
          pretty: "NVIDIA DGX Server",
          version: "7.5.0-GB300ws-GB200ws",
          buildDate: "2026-04-02-08-20-16",
        }
      : {
          pretty: "NVIDIA DGX GB300WS",
          version: "7.5.0",
          buildDate: "2026-06-16-11-48-10",
        };
  return [
    'DGX_NAME="DGX Server"',
    `DGX_PRETTY_NAME="${identity.pretty}"`,
    `DGX_SWBUILD_DATE="${identity.buildDate}"`,
    `DGX_SWBUILD_VERSION="${identity.version}"`,
    'DGX_PLATFORM="DGX Server for GALAXY-GB300"',
    'DGX_SERIAL_NUMBER="host-specific-value"',
    "",
  ].join("\n");
}

export function noOtaDgxOs76Release(version = "7.6.0", pretty = "NVIDIA DGX GB300WS") {
  return `DGX_NAME="DGX GB300WS"\nDGX_PRETTY_NAME="${pretty}"
DGX_SWBUILD_DATE="2026-07-14-13-59-06"
DGX_SWBUILD_VERSION="${version}"
DGX_COMMIT_ID="d0e99cc"\nDGX_PLATFORM="DGX Server for GALAXY-GB300"
`;
}
