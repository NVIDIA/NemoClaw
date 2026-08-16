// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  VOICE_GATEWAY_DEPLOYMENT_CREDENTIAL_FD,
  VOICE_GATEWAY_FEATURE_ENV,
  VOICE_GATEWAY_OPENCLAW_CREDENTIAL_FD,
} from "./contracts";
import { validatePrivateCredentialDescriptor } from "./credential-file";

/** Trusted source paths and fixed runtime fields for one voice-gateway launch. */
export interface VoiceGatewayLaunchOptions {
  readonly deploymentCredentialPath: string;
  readonly openClawCredentialPath: string;
  readonly gatewayUrl: string;
  readonly runtimeIdentity: string;
  readonly runtimeProfile: string;
  readonly sandbox: string;
  readonly agent: string;
  readonly listenPort?: number;
}

/** Credential-free process contract emitted by the bounded launcher. */
export interface VoiceGatewayLaunchContract {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const CLI = path.resolve(__dirname, "../../../bin/nemoclaw.js");

/** Build the path- and value-free child process contract for the voice gateway. */
export function buildVoiceGatewayLaunchContract(
  options: VoiceGatewayLaunchOptions,
): VoiceGatewayLaunchContract {
  const args = [
    CLI,
    "internal",
    "voice-gateway",
    "serve",
    "--gateway-url",
    options.gatewayUrl,
    "--runtime-identity",
    options.runtimeIdentity,
    "--runtime-profile",
    options.runtimeProfile,
    "--sandbox",
    options.sandbox,
    "--agent",
    options.agent,
  ];
  if (options.listenPort !== undefined) args.push("--listen-port", String(options.listenPort));
  return {
    command: process.execPath,
    args,
    env: { [VOICE_GATEWAY_FEATURE_ENV]: "1" },
  };
}

/** Open and validate one trusted credential source without exposing its path downstream. */
function openCredential(pathname: string, label: string): number {
  if (!path.isAbsolute(pathname)) throw new Error(`${label} path must be absolute.`);
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Secure no-follow credential opens are unavailable on this platform.");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      pathname,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`${label} path must not be a symbolic link.`);
    }
    throw new Error(`${label} source could not be opened.`);
  }
  try {
    validatePrivateCredentialDescriptor(fs.fstatSync(descriptor), label);
    return descriptor;
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the validation failure; the process still owns final descriptor cleanup.
    }
    throw error;
  }
}

/** Close every owned descriptor while preserving the first cleanup failure. */
function closeDescriptors(descriptors: readonly number[]): void {
  let cleanupError: unknown;
  for (const descriptor of descriptors) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBADF" && cleanupError === undefined) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
}

/** Launch the real gateway with only the two selected credential objects inherited. */
export function launchVoiceGateway(options: VoiceGatewayLaunchOptions): ChildProcess {
  const descriptors: number[] = [];
  let child: ChildProcess | undefined;
  let operationError: { readonly value: unknown } | undefined;
  try {
    const deployment = openCredential(
      options.deploymentCredentialPath,
      "Voice gateway deployment credential",
    );
    descriptors.push(deployment);
    const openClaw = openCredential(
      options.openClawCredentialPath,
      "Voice gateway OpenClaw credential",
    );
    descriptors.push(openClaw);
    const deploymentStat = fs.fstatSync(deployment);
    const openClawStat = fs.fstatSync(openClaw);
    if (deploymentStat.dev === openClawStat.dev && deploymentStat.ino === openClawStat.ino) {
      throw new Error("Voice gateway credential sources must refer to different files.");
    }

    const contract = buildVoiceGatewayLaunchContract(options);
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
    stdio[VOICE_GATEWAY_DEPLOYMENT_CREDENTIAL_FD] = deployment;
    stdio[VOICE_GATEWAY_OPENCLAW_CREDENTIAL_FD] = openClaw;
    child = spawn(contract.command, contract.args, {
      env: contract.env,
      stdio,
    });
  } catch (error) {
    operationError = { value: error };
  }

  try {
    closeDescriptors(descriptors);
  } catch (error) {
    if (operationError === undefined) throw error;
  }
  if (operationError !== undefined) throw operationError.value;
  return child!;
}
