// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  PORTABLE_INFERENCE_DESCRIPTOR_PATH,
  type PortableInferenceDescriptor,
} from "../../../src/lib/onboard/experimental/portable-inference-descriptor.ts";
import { createPrivateRegularFile } from "../../../tools/e2e/private-file.mts";

export const HOSTED_INFERENCE_SECRET = "NVIDIA_INFERENCE_API_KEY";
export const HOSTED_INFERENCE_CREDENTIAL_ENV = "COMPATIBLE_API_KEY";
export const HOSTED_INFERENCE_MODELS_PROBE_SECRET_ENV = HOSTED_INFERENCE_SECRET;
export const HOSTED_INFERENCE_PROVIDER = "custom";
export const HOSTED_INFERENCE_PROVIDER_NAME = "compatible-endpoint";
export const DEFAULT_HOSTED_INFERENCE_BASE_URL = "https://inference-api.nvidia.com/v1";
export const DEFAULT_HOSTED_INFERENCE_MODEL = "nvidia/nvidia/nemotron-3-ultra";

const PORTABLE_DESCRIPTOR_VALIDITY_MS = 60 * 60_000;

export interface HostedInferenceSecrets {
  required(name: string): string;
}

export interface HostedInferenceOptions {
  model?: string;
}

export interface HostedInferenceConfig {
  apiKey: string;
  sourceSecretName: typeof HOSTED_INFERENCE_SECRET;
  credentialEnv: typeof HOSTED_INFERENCE_CREDENTIAL_ENV;
  provider: typeof HOSTED_INFERENCE_PROVIDER;
  providerName: typeof HOSTED_INFERENCE_PROVIDER_NAME;
  env: NodeJS.ProcessEnv;
  model: string;
  endpointUrl: string;
  contractLabel: string;
}

export interface HostedInferenceModelsProbe {
  args: string[];
  command: "bash";
  env: NodeJS.ProcessEnv;
}

function currentEffectiveUid(): number {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error("Portable hosted inference staging cannot verify the current user.");
  }
  return uid;
}

function assertPrivateDescriptorDirectory(directory: string, uid: number): void {
  const metadata = fs.lstatSync(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Portable hosted inference staging requires a private current-user directory at ${directory}.`,
    );
  }
}

function removeExactDescriptor(filePath: string, expected: fs.Stats): void {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error(`Portable hosted inference descriptor at ${filePath} changed before cleanup.`);
  }
  fs.unlinkSync(filePath);
}

function removeOwnedDescriptorAfterFailure(filePath: string, expected: fs.Stats | null): void {
  if (!expected) return;
  try {
    removeExactDescriptor(filePath, expected);
  } catch {
    // Preserve the staging failure. The workflow's always-run cleanup still
    // owns exact-path removal and reports a cleanup failure separately.
  }
}

export function stagePortableHostedInferenceDescriptor(
  config: HostedInferenceConfig,
  options: { readonly filePath?: string; readonly now?: () => number } = {},
): { readonly filePath: string; dispose(): void } {
  const filePath = options.filePath ?? PORTABLE_INFERENCE_DESCRIPTOR_PATH;
  const directory = path.dirname(filePath);
  const uid = currentEffectiveUid();
  assertPrivateDescriptorDirectory(directory, uid);
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Portable hosted inference staging requires O_NOFOLLOW.");
  }

  const descriptor: PortableInferenceDescriptor = {
    schemaVersion: 1,
    apiKey: config.apiKey,
    baseUrl: config.endpointUrl,
    model: config.model,
    expiresAt: new Date(
      (options.now ?? Date.now)() + PORTABLE_DESCRIPTOR_VALIDITY_MS,
    ).toISOString(),
  };
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp`);
  let stagedTemporary: fs.Stats | null = null;
  let published: fs.Stats | null = null;
  try {
    createPrivateRegularFile(temporary, `${JSON.stringify(descriptor)}\n`);
    const staged = fs.lstatSync(temporary);
    stagedTemporary = staged;
    if (staged.uid !== uid || (staged.mode & 0o777) !== 0o600) {
      throw new Error(
        "Portable hosted inference staging did not create a current-user-owned mode-0600 file.",
      );
    }
    try {
      fs.linkSync(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Portable hosted inference descriptor already exists at ${filePath}; refusing to replace it.`,
        );
      }
      throw error;
    }
    published = staged;
    fs.unlinkSync(temporary);
    stagedTemporary = null;

    const final = fs.lstatSync(filePath);
    if (
      final.isSymbolicLink() ||
      !final.isFile() ||
      final.uid !== uid ||
      (final.mode & 0o777) !== 0o600 ||
      final.nlink !== 1 ||
      final.dev !== staged.dev ||
      final.ino !== staged.ino
    ) {
      throw new Error(
        "Portable hosted inference staging did not publish the staged current-user-owned mode-0600 single-link regular file.",
      );
    }
    return {
      filePath,
      dispose: () => removeExactDescriptor(filePath, final),
    };
  } catch (error) {
    removeOwnedDescriptorAfterFailure(filePath, published);
    removeOwnedDescriptorAfterFailure(temporary, stagedTemporary);
    throw error;
  }
}

export function buildHostedInferenceModelsProbe(
  apiKey: string,
  endpointUrl: string,
): HostedInferenceModelsProbe {
  if (!apiKey || /[\r\n]/u.test(apiKey)) {
    throw new Error("hosted inference API key must be nonempty and single-line");
  }
  const baseUrl = endpointUrl.endsWith("/") ? endpointUrl : `${endpointUrl}/`;
  const modelsUrl = new URL("models", baseUrl).toString();
  return {
    command: "bash",
    args: [
      "-c",
      `set -euo pipefail; printf 'Authorization: Bearer %s\\n' "$${HOSTED_INFERENCE_MODELS_PROBE_SECRET_ENV}" | curl -fsS --max-time 60 --header @- "$1"`,
      "hosted-inference-models-probe",
      modelsUrl,
    ],
    env: { [HOSTED_INFERENCE_MODELS_PROBE_SECRET_ENV]: apiKey },
  };
}

export function requireHostedInferenceConfig(
  secrets: HostedInferenceSecrets,
  env: NodeJS.ProcessEnv = process.env,
  options: HostedInferenceOptions = {},
): HostedInferenceConfig {
  const apiKey = secrets.required(HOSTED_INFERENCE_SECRET);
  const endpointUrl = env.NEMOCLAW_ENDPOINT_URL || DEFAULT_HOSTED_INFERENCE_BASE_URL;
  const model =
    env.NEMOCLAW_MODEL ||
    env.NEMOCLAW_COMPAT_MODEL ||
    options.model ||
    DEFAULT_HOSTED_INFERENCE_MODEL;
  return {
    apiKey,
    sourceSecretName: HOSTED_INFERENCE_SECRET,
    credentialEnv: HOSTED_INFERENCE_CREDENTIAL_ENV,
    provider: HOSTED_INFERENCE_PROVIDER,
    providerName: HOSTED_INFERENCE_PROVIDER_NAME,
    endpointUrl,
    model,
    env: {
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NEMOCLAW_PROVIDER: HOSTED_INFERENCE_PROVIDER,
      NEMOCLAW_ENDPOINT_URL: endpointUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_COMPAT_MODEL: model,
      NEMOCLAW_PREFERRED_API: env.NEMOCLAW_PREFERRED_API || "openai-completions",
      [HOSTED_INFERENCE_SECRET]: apiKey,
      [HOSTED_INFERENCE_CREDENTIAL_ENV]: apiKey,
    },
    contractLabel: "NVIDIA_INFERENCE_API_KEY is staged as the compatible endpoint credential",
  };
}
