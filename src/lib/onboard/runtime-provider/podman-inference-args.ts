// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIPv4 } from "node:net";
import path from "node:path";

import type { HostLocalOllamaAccelerationAuthority } from "./host-local-inference";
import { qualifyPodmanGpuAttachments } from "./podman-gpu";
import {
  normalizeQualifiedPodmanInferenceAuthorityReceipt,
  type PodmanInferenceAuthorityReceipt,
} from "./podman-preflight";

const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const OCI_DIGEST_REFERENCE =
  /^(?:[A-Za-z0-9._-]+(?::[0-9]+)?\/)*(?:[A-Za-z0-9._-]+)@sha256:[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SIZE = /^[1-9][0-9]*(?:[bkmg]|kb|mb|gb)?$/iu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EXACT_SECRET_ENVIRONMENT_NAMES = new Set([
  "API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "PASSWORD",
  "PASSWD",
  "SECRET",
  "TOKEN",
]);
const SECRET_ENVIRONMENT_NAME_SUFFIX =
  /_(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|SECRET_KEY|SECRET|CREDENTIALS)$/u;
const SHELL_ENVIRONMENT_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;
const ENVIRONMENT_ASSIGNMENT = /(?:^|[\s"'`])([A-Za-z_][A-Za-z0-9_]*)=[^\s"'`]+/gu;
const SECRET_COMMAND_FLAG =
  /(?:^|\s)--(?:api-key|access-token|auth-token|authorization|hf-token|ngc-api-key|password|secret|token)(?:$|[=\s])/iu;
const CREDENTIAL_TOKEN =
  /(?:^|[^A-Za-z0-9_-])(?:hf_[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})(?:$|[^A-Za-z0-9_-])/u;
const CREDENTIAL_HEADER =
  /(?:^|[\s"'])(?:authorization|proxy-authorization|x-api-key|api-key)\s*:\s*\S+/iu;

const OWNED_LABEL_VALUE = new Map<string, (value: string) => boolean>([
  ["ai.nvidia.nemoclaw.inference.managed", (value) => value === "true"],
  ["ai.nvidia.nemoclaw.inference.provider", (value) => value === "podman"],
  [
    "ai.nvidia.nemoclaw.inference.service",
    (value) => value === "ollama" || value === "nim" || value === "vllm",
  ],
  ["ai.nvidia.nemoclaw.inference.spec-sha256", (value) => SHA256.test(value)],
  ["ai.nvidia.nemoclaw.inference.authority-sha256", (value) => SHA256.test(value)],
  ["ai.nvidia.nemoclaw.inference.transaction-sha256", (value) => SHA256.test(value)],
  ["ai.nvidia.nemoclaw.inference.receipt-target-sha256", (value) => SHA256.test(value)],
  [
    "ai.nvidia.nemoclaw.inference.prior-state",
    (value) => value === "absent" || value === "running" || value === "stopped",
  ],
  ["ai.nvidia.nemoclaw.inference.probe.managed", (value) => value === "true"],
  [
    "ai.nvidia.nemoclaw.inference.probe.phase",
    (value) => value === "ready" || value === "gpu" || value === "inference",
  ],
  ["ai.nvidia.nemoclaw.inference.probe.spec-sha256", (value) => SHA256.test(value)],
]);

const BOOLEAN_OPTIONS = new Map([
  ["--detach", "--detach"],
  ["-d", "--detach"],
  ["--init", "--init"],
  ["--read-only", "--read-only"],
]);

const VALUE_OPTIONS = new Map([
  ["--device", "--device"],
  ["--entrypoint", "--entrypoint"],
  ["--env", "--env"],
  ["-e", "--env"],
  ["--gpus", "--gpus"],
  ["--http-proxy", "--http-proxy"],
  ["--ipc", "--ipc"],
  ["--label", "--label"],
  ["--name", "--name"],
  ["--network", "--network"],
  ["--publish", "--publish"],
  ["-p", "--publish"],
  ["--pull", "--pull"],
  ["--restart", "--restart"],
  ["--shm-size", "--shm-size"],
  ["--tmpfs", "--tmpfs"],
  ["--ulimit", "--ulimit"],
  ["--user", "--user"],
]);

const REPEATABLE_OPTIONS = new Set([
  "--device",
  "--env",
  "--label",
  "--publish",
  "--tmpfs",
  "--ulimit",
]);

interface ParsedOption {
  readonly consumed: number;
  readonly name: string;
  readonly value: string;
}

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
  const startsQuoted = raw.startsWith('"');
  const endsQuoted = raw.endsWith('"');
  if (startsQuoted !== endsQuoted || (startsQuoted && raw.length < 2)) {
    throw new Error(`Podman local inference cannot translate Docker GPU selector '${raw}' to CDI.`);
  }
  return startsQuoted ? raw.slice(1, -1) : raw;
}

function translatedGpuDevices(
  selector: string,
  availableCdiDevices: readonly string[],
): readonly string[] {
  const normalized = stripExactDoubleQuotes(selector);
  const requested =
    normalized === "all"
      ? ["all"]
      : normalized.startsWith("device=")
        ? normalized.slice("device=".length).split(",")
        : [];
  if (
    requested.length === 0 ||
    requested.some((device) => device === "" || device !== device.trim())
  ) {
    throw new Error(
      `Podman local inference cannot translate Docker GPU selector '${selector}' to CDI.`,
    );
  }
  return qualifyPodmanGpuAttachments(availableCdiDevices, requested).map(
    (attachment) => attachment.device,
  );
}

function parseOption(source: readonly string[], index: number): ParsedOption | null {
  const token = source[index] ?? "";
  const separateName = VALUE_OPTIONS.get(token);
  if (separateName) {
    const value = source[index + 1];
    if (value === undefined) {
      throw new Error(`Podman local inference requires a value for ${separateName}.`);
    }
    return { consumed: 2, name: separateName, value };
  }
  if (!token.startsWith("--") || !token.includes("=")) return null;
  const separator = token.indexOf("=");
  const name = VALUE_OPTIONS.get(token.slice(0, separator));
  if (!name) return null;
  const value = token.slice(separator + 1);
  if (value === "") throw new Error(`Podman local inference requires a value for ${name}.`);
  return { consumed: 1, name, value };
}

function requireSafeName(value: string, label: string): void {
  if (!SAFE_NAME.test(value)) throw new Error(`Podman local inference ${label} is invalid.`);
}

function requirePortMapping(value: string, allowedAddresses: ReadonlySet<string>): void {
  const fields = value.split(":");
  if (fields.length !== 3) {
    throw new Error("Podman local inference publish mapping is invalid.");
  }
  const ports = fields.slice(-2);
  if (
    !ports.every((port) => /^\d{1,5}$/u.test(port) && Number(port) > 0 && Number(port) <= 65_535) ||
    !allowedAddresses.has(fields[0] ?? "")
  ) {
    throw new Error("Podman local inference publish mapping lacks exact listener authority.");
  }
}

function canonicalAbsoluteLinuxPath(value: string, label: string): string {
  if (
    !path.posix.isAbsolute(value) ||
    value.includes(":") ||
    CONTROL_CHARACTERS.test(value) ||
    value === "/"
  ) {
    throw new Error(`Podman local inference ${label} must be a canonical absolute Linux path.`);
  }
  const canonical = path.posix.normalize(value);
  if (canonical !== value) {
    throw new Error(`Podman local inference ${label} must be a canonical absolute Linux path.`);
  }
  return canonical;
}

function normalizedOwnedLabel(value: string, seenLabels: Set<string>): string {
  const separator = value.indexOf("=");
  if (separator < 1) throw new Error("Podman local inference label is invalid.");
  const key = value.slice(0, separator);
  const labelValue = value.slice(separator + 1);
  const validate = OWNED_LABEL_VALUE.get(key);
  if (!validate || !validate(labelValue)) {
    throw new Error("Podman local inference permits only exact NemoClaw inference labels.");
  }
  if (seenLabels.has(key)) {
    throw new Error(`Podman local inference label ${key} is duplicated.`);
  }
  seenLabels.add(key);
  return `${key}=${labelValue}`;
}

function normalizedOptionValue(
  name: string,
  value: string,
  seenLabels: Set<string>,
  allowedPublishAddresses: ReadonlySet<string>,
): string {
  switch (name) {
    case "--entrypoint":
      return canonicalAbsoluteLinuxPath(value, "entrypoint");
    case "--env":
      if (!ENVIRONMENT_NAME.test(value)) {
        throw new Error(
          "Podman local inference environment must name a variable without its value.",
        );
      }
      return value;
    case "--ipc":
      if (value !== "private") {
        throw new Error("Podman local inference requires a private IPC namespace.");
      }
      return value;
    case "--http-proxy":
      if (value !== "false") {
        throw new Error("Podman local inference must disable container proxy inheritance.");
      }
      return value;
    case "--label":
      return normalizedOwnedLabel(value, seenLabels);
    case "--name":
      requireSafeName(value, "container name");
      return value;
    case "--network":
      requireSafeName(value, "network name");
      if (value === "host" || value === "none") {
        throw new Error("Podman local inference network mode is unsupported.");
      }
      return value;
    case "--publish":
      requirePortMapping(value, allowedPublishAddresses);
      return value;
    case "--pull":
      if (value !== "never") throw new Error("Podman local inference pull policy must be 'never'.");
      return value;
    case "--restart":
      if (value !== "unless-stopped") {
        throw new Error("Podman local inference restart policy is unsupported.");
      }
      return value;
    case "--shm-size":
      if (!SIZE.test(value))
        throw new Error("Podman local inference shared-memory size is invalid.");
      return value;
    case "--tmpfs": {
      const separator = value.indexOf(":");
      if (separator < 1 || !/^[A-Za-z0-9_=,-]+$/u.test(value.slice(separator + 1))) {
        throw new Error("Podman local inference tmpfs specification is invalid.");
      }
      return `${canonicalAbsoluteLinuxPath(value.slice(0, separator), "tmpfs target")}:${value.slice(separator + 1)}`;
    }
    case "--ulimit":
      if (!/^(?:memlock|stack)=-?\d+(?::-?\d+)?$/u.test(value)) {
        throw new Error("Podman local inference ulimit is unsupported.");
      }
      return value;
    case "--user":
      if (!/^\d+(?::\d+)?$/u.test(value)) {
        throw new Error("Podman local inference user identity is invalid.");
      }
      return value;
    default:
      throw new Error(`Podman local inference option ${name} is unsupported.`);
  }
}

function isSecretEnvironmentName(value: string): boolean {
  return EXACT_SECRET_ENVIRONMENT_NAMES.has(value) || SECRET_ENVIRONMENT_NAME_SUFFIX.test(value);
}

function carriesSecretEnvironmentName(value: string): boolean {
  if (isSecretEnvironmentName(value)) return true;
  return [...value.matchAll(SHELL_ENVIRONMENT_REFERENCE), ...value.matchAll(ENVIRONMENT_ASSIGNMENT)]
    .map((match) => match[1] ?? match[2] ?? "")
    .some(isSecretEnvironmentName);
}

function requireSecretFreeCommandArgument(value: string): void {
  if (
    carriesSecretEnvironmentName(value) ||
    SECRET_COMMAND_FLAG.test(value) ||
    CREDENTIAL_TOKEN.test(value) ||
    CREDENTIAL_HEADER.test(value) ||
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(value) ||
    /["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']\s*:\s*["'][^"']+/iu.test(
      value,
    )
  ) {
    throw new Error("Podman local inference command arguments must not carry credential material.");
  }
}

function appendGpuDevices(
  target: string[],
  devices: readonly string[],
  requested: Set<string>,
): void {
  for (const device of devices) {
    if (requested.has(device)) {
      throw new Error("Podman local inference GPU request contains a duplicate NVIDIA CDI device.");
    }
    if (
      (device === "nvidia.com/gpu=all" && requested.size > 0) ||
      (requested.has("nvidia.com/gpu=all") && device !== "nvidia.com/gpu=all")
    ) {
      throw new Error("Podman local inference GPU request cannot mix 'all' with exact devices.");
    }
    requested.add(device);
    target.push("--device", device);
  }
}

/**
 * Translate only the bounded Docker run shapes used by host-local Ollama,
 * NIM, and vLLM. Unknown engine flags and ambiguous device forms fail closed.
 */
export function translatePodmanLocalInferenceArgs(
  args: readonly string[],
  authority: PodmanInferenceAuthorityReceipt,
  options: {
    readonly acceleration?: HostLocalOllamaAccelerationAuthority;
    readonly allowedPublishAddresses?: readonly string[];
  } = {},
): readonly string[] {
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) {
    throw new Error("Podman local inference has too many command arguments.");
  }
  const source = args.map(exactArgument);
  if (source[0] !== "run") {
    throw new Error("Podman local inference translates only an explicit container run command.");
  }
  const qualified = normalizeQualifiedPodmanInferenceAuthorityReceipt(authority);
  const acceleration = options.acceleration ?? "nvidia-gpu";
  const allowedPublishAddresses = new Set(["127.0.0.1"]);
  for (const address of options.allowedPublishAddresses ?? []) {
    if (!isIPv4(address) || address.startsWith("127.")) {
      throw new Error("Podman local inference listener authority is invalid.");
    }
    allowedPublishAddresses.add(address);
  }
  const translated = ["run", "--http-proxy=false"];
  const seenOptions = new Set<string>(["--http-proxy"]);
  const seenLabels = new Set<string>();
  const requestedGpuDevices = new Set<string>();
  let imageFound = false;

  for (let index = 1; index < source.length;) {
    const token = source[index] ?? "";
    if (imageFound) {
      requireSecretFreeCommandArgument(token);
      translated.push(token);
      index += 1;
      continue;
    }
    if (OCI_DIGEST_REFERENCE.test(token)) {
      translated.push(token);
      imageFound = true;
      index += 1;
      continue;
    }
    const booleanOption = BOOLEAN_OPTIONS.get(token);
    if (booleanOption) {
      if (seenOptions.has(booleanOption)) {
        throw new Error(`Podman local inference option ${booleanOption} is duplicated.`);
      }
      seenOptions.add(booleanOption);
      translated.push(booleanOption);
      index += 1;
      continue;
    }
    if (token === "--runtime" || token.startsWith("--runtime=")) {
      throw new Error("Podman local inference refuses Docker runtime selection; CDI is required.");
    }
    const option = parseOption(source, index);
    if (!option) {
      throw new Error(`Podman local inference does not support Docker argument '${token}'.`);
    }
    if (!REPEATABLE_OPTIONS.has(option.name) && seenOptions.has(option.name)) {
      throw new Error(`Podman local inference option ${option.name} is duplicated.`);
    }
    seenOptions.add(option.name);
    if (option.name === "--gpus") {
      if (acceleration !== "nvidia-gpu") {
        throw new Error("Podman local inference CPU authority forbids GPU attachment.");
      }
      appendGpuDevices(
        translated,
        translatedGpuDevices(option.value, qualified.cdiDevices),
        requestedGpuDevices,
      );
    } else if (option.name === "--device") {
      if (acceleration !== "nvidia-gpu") {
        throw new Error("Podman local inference CPU authority forbids GPU attachment.");
      }
      if (!option.value.startsWith("nvidia.com/gpu=")) {
        throw new Error(
          "Podman local inference refuses raw or unsupported device arguments; exact NVIDIA CDI is required.",
        );
      }
      appendGpuDevices(
        translated,
        qualifyPodmanGpuAttachments(qualified.cdiDevices, [option.value]).map(
          (attachment) => attachment.device,
        ),
        requestedGpuDevices,
      );
    } else {
      translated.push(
        option.name,
        normalizedOptionValue(option.name, option.value, seenLabels, allowedPublishAddresses),
      );
    }
    index += option.consumed;
  }
  if (!imageFound) {
    throw new Error("Podman local inference requires one immutable digest image reference.");
  }
  return Object.freeze(translated);
}
