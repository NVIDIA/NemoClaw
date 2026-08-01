// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { qualifyPodmanGpuAttachments } from "./podman-gpu";

const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 16 * 1024;

function exactArgument(value: unknown, index: number): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES
  ) {
    throw new Error(`Podman local inference argument ${String(index)} is invalid.`);
  }
  return value;
}

function stripExactDoubleQuotes(raw: string): string {
  const trimmed = raw.trim();
  const startsQuoted = trimmed.startsWith('"');
  const endsQuoted = trimmed.endsWith('"');
  if (startsQuoted !== endsQuoted || (startsQuoted && trimmed.length < 2)) {
    throw new Error(`Podman local inference cannot translate Docker GPU selector '${raw}' to CDI.`);
  }
  return startsQuoted ? trimmed.slice(1, -1) : trimmed;
}

function translatedGpuDevices(selector: string, availableCdiDevices: readonly string[]): string[] {
  const normalized = stripExactDoubleQuotes(selector);
  const requested =
    normalized === "all"
      ? ["all"]
      : normalized.startsWith("device=")
        ? normalized.slice("device=".length).split(",")
        : [];
  if (requested.length === 0 || requested.some((device) => device.trim() === "")) {
    throw new Error(
      `Podman local inference cannot translate Docker GPU selector '${selector}' to CDI.`,
    );
  }
  return qualifyPodmanGpuAttachments(
    availableCdiDevices,
    requested.map((device) => device.trim()),
  ).map((attachment) => attachment.device);
}

function appendGpuDevices(target: string[], devices: readonly string[]): void {
  for (const device of devices) target.push("--device", device);
}

/**
 * Translate the bounded Docker-compatible argument subset emitted by the
 * existing NIM and vLLM launchers. NVIDIA GPU selection becomes exact CDI
 * attachment; Docker-only runtime and raw-device modes fail closed.
 */
export function translatePodmanLocalInferenceArgs(
  args: readonly string[],
  availableCdiDevices: readonly string[],
): readonly string[] {
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) {
    throw new Error("Podman local inference has too many command arguments.");
  }
  const source = args.map(exactArgument);
  const translated: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index] ?? "";
    if (value === "--gpus") {
      const selector = source[index + 1];
      if (selector === undefined) {
        throw new Error("Podman local inference requires a GPU selector value.");
      }
      appendGpuDevices(translated, translatedGpuDevices(selector, availableCdiDevices));
      index += 1;
      continue;
    }
    if (value.startsWith("--gpus=")) {
      appendGpuDevices(
        translated,
        translatedGpuDevices(value.slice("--gpus=".length), availableCdiDevices),
      );
      continue;
    }
    if (
      (value === "--runtime" && source[index + 1]?.toLowerCase() === "nvidia") ||
      value.toLowerCase() === "--runtime=nvidia"
    ) {
      throw new Error(
        "Podman local inference refuses Docker's NVIDIA runtime mode; an exact CDI device is required.",
      );
    }
    if (value === "--device") {
      const device = source[index + 1];
      if (device === undefined) {
        throw new Error("Podman local inference requires a --device value.");
      }
      if (/^\/dev\/nvidia/u.test(device)) {
        throw new Error(
          "Podman local inference refuses raw NVIDIA device paths; an exact CDI device is required.",
        );
      }
      if (device.startsWith("nvidia.com/gpu=")) {
        appendGpuDevices(translated, translatedGpuDevices(`device=${device}`, availableCdiDevices));
        index += 1;
        continue;
      }
    }
    if (value.startsWith("--device=/dev/nvidia")) {
      throw new Error(
        "Podman local inference refuses raw NVIDIA device paths; an exact CDI device is required.",
      );
    }
    if (value.startsWith("--device=nvidia.com/gpu=")) {
      appendGpuDevices(
        translated,
        translatedGpuDevices(`device=${value.slice("--device=".length)}`, availableCdiDevices),
      );
      continue;
    }
    if (value.startsWith("name=^/") && value.endsWith("$")) {
      translated.push(`name=^${value.slice("name=^/".length)}`);
      continue;
    }
    translated.push(value);
  }
  return Object.freeze(translated);
}
