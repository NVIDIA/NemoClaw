// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ToolDisclosure } from "../../tool-disclosure";
import {
  isExactExternalImageReference,
  isRuntimeImageContentId,
} from "../../state/registry/workload";
import type { RuntimeProviderCommandCapture } from "../runtime-provider/contract";
import type {
  ExternalImageAgent,
  ExternalImageWorkloadSource,
  SandboxWorkloadRuntimeCapabilities,
} from "./source";

const INSPECT_LIMIT_BYTES = 256 * 1024;
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

interface DockerImageInspect {
  readonly Id?: unknown;
  readonly Os?: unknown;
  readonly Architecture?: unknown;
  readonly Config?: {
    readonly User?: unknown;
    readonly WorkingDir?: unknown;
    readonly Entrypoint?: unknown;
    readonly Cmd?: unknown;
    readonly Env?: unknown;
    readonly Labels?: unknown;
  } | null;
}

export interface PrepareExternalImageInput {
  readonly reference: string;
  readonly agentName: string;
  readonly runtime: SandboxWorkloadRuntimeCapabilities;
}

export interface PrepareExternalImageDependencies {
  readonly capture: (
    operation: "external-image-preparation",
    args: readonly string[],
    timeoutMs?: number,
  ) => RuntimeProviderCommandCapture;
}

export class ExternalImagePreparationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`External image preparation failed: ${message}`, options);
    this.name = "ExternalImagePreparationError";
  }
}

/** Adopt the publisher declaration unless the operator explicitly requested a mode. */
export function resolveExternalImageToolDisclosure(
  imageDisclosure: ToolDisclosure,
  requested: ToolDisclosure | null,
): ToolDisclosure {
  if (requested && requested !== imageDisclosure) {
    throw new ExternalImagePreparationError(
      `requested tool disclosure '${requested}' does not match image tool disclosure '${imageDisclosure}'.`,
    );
  }
  return requested ?? imageDisclosure;
}

export function parseExactExternalImageReference(value: unknown): string {
  if (typeof value !== "string") {
    throw new ExternalImagePreparationError("--from-image requires an image reference.");
  }
  const reference = value.trim();
  if (reference !== value || !isExactExternalImageReference(reference)) {
    throw new ExternalImagePreparationError(
      "the image reference must use repository@sha256:<64 lowercase hexadecimal characters>.",
    );
  }
  return reference;
}

function requireExternalImageAgent(agentName: string): ExternalImageAgent {
  if (agentName === "openclaw" || agentName === "hermes") return agentName;
  throw new ExternalImagePreparationError(
    `agent '${agentName}' is not supported for user-supplied images.`,
  );
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (value === null || value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((entry) => typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > 8192)
  ) {
    throw new ExternalImagePreparationError(`image ${field} is not a bounded string array.`);
  }
  return value;
}

function environmentValues(environment: readonly string[], name: string): readonly string[] {
  const prefix = `${name}=`;
  return environment
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
}

function requireSingleEnvironmentValue(
  environment: readonly string[],
  name: string,
  required: boolean,
): string | null {
  const values = environmentValues(environment, name);
  if (values.length > 1) {
    throw new ExternalImagePreparationError(`image contains duplicate ${name} metadata.`);
  }
  if (values.length === 0) {
    if (required) throw new ExternalImagePreparationError(`image must set ${name}.`);
    return null;
  }
  return values[0]!;
}

function requireToolDisclosure(environment: readonly string[]): ToolDisclosure {
  const raw = requireSingleEnvironmentValue(environment, "NEMOCLAW_TOOL_DISCLOSURE", true);
  if (raw !== "progressive" && raw !== "direct") {
    throw new ExternalImagePreparationError(
      "image NEMOCLAW_TOOL_DISCLOSURE must be progressive or direct.",
    );
  }
  return raw;
}

function requireAgentMetadata(
  inspect: DockerImageInspect,
  environment: readonly string[],
  agent: ExternalImageAgent,
): void {
  const environmentAgent = requireSingleEnvironmentValue(environment, "NEMOCLAW_AGENT", false);
  const labels = inspect.Config?.Labels;
  if (
    labels !== undefined &&
    labels !== null &&
    (typeof labels !== "object" || Array.isArray(labels))
  ) {
    throw new ExternalImagePreparationError("image labels are malformed.");
  }
  const labelAgent =
    labels && typeof labels === "object"
      ? (labels as Record<string, unknown>)["io.nvidia.nemoclaw.agent"]
      : null;
  if (labelAgent !== null && labelAgent !== undefined && typeof labelAgent !== "string") {
    throw new ExternalImagePreparationError("image agent label is malformed.");
  }
  const declared = [environmentAgent, labelAgent].filter(
    (value): value is string => typeof value === "string",
  );
  if (declared.some((value) => value !== agent) || new Set(declared).size > 1) {
    throw new ExternalImagePreparationError(
      `image agent metadata does not match selected agent '${agent}'.`,
    );
  }
}

function parseInspectOutput(output: string): DockerImageInspect {
  if (Buffer.byteLength(output, "utf8") > INSPECT_LIMIT_BYTES) {
    throw new ExternalImagePreparationError("Docker returned oversized image metadata.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new ExternalImagePreparationError("Docker returned malformed image metadata.", {
      cause: error,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    typeof parsed[0] !== "object" ||
    !parsed[0]
  ) {
    throw new ExternalImagePreparationError("Docker must return exactly one image record.");
  }
  return parsed[0] as DockerImageInspect;
}

function isMissingLocalImage(inspection: RuntimeProviderCommandCapture): boolean {
  return /(?:No such image|No such object)(?::|$)/iu.test(inspection.stderr);
}

function validateInspect(
  reference: string,
  inspect: DockerImageInspect,
  agent: ExternalImageAgent,
  runtime: SandboxWorkloadRuntimeCapabilities,
): ExternalImageWorkloadSource {
  const support = runtime.externalImages;
  if (!support?.exactDigestReferences || support.platforms.length !== 1) {
    throw new ExternalImagePreparationError(
      `driver '${runtime.driverName}' does not support user-supplied exact-digest images.`,
    );
  }
  if (!support.agents.includes(agent)) {
    throw new ExternalImagePreparationError(
      `driver '${runtime.driverName}' does not support user-supplied images for '${agent}'.`,
    );
  }
  const platform = `${String(inspect.Os ?? "")}/${String(inspect.Architecture ?? "")}`;
  if (platform !== support.platforms[0]) {
    throw new ExternalImagePreparationError(
      `image platform '${platform}' does not match host platform '${support.platforms[0]}'.`,
    );
  }
  const user = typeof inspect.Config?.User === "string" ? inspect.Config.User.trim() : "";
  if (!user || /^(?:root|[+-]?0+)(?::|$)/u.test(user)) {
    throw new ExternalImagePreparationError("image must declare an explicit non-root final user.");
  }
  if (inspect.Config?.WorkingDir !== "/sandbox") {
    throw new ExternalImagePreparationError("image working directory must be exactly /sandbox.");
  }
  const entrypoint = requireStringArray(inspect.Config?.Entrypoint, "entrypoint");
  const command = requireStringArray(inspect.Config?.Cmd, "command");
  const executable = entrypoint.length > 0 ? entrypoint[0] : command[0];
  if (!executable || executable.trim() === "") {
    throw new ExternalImagePreparationError("image must declare a usable entrypoint or command.");
  }
  const environment = requireStringArray(inspect.Config?.Env, "environment");
  requireAgentMetadata(inspect, environment, agent);
  const toolDisclosure = requireToolDisclosure(environment);
  const runtimeImageContentId = inspect.Id;
  if (!isRuntimeImageContentId(runtimeImageContentId)) {
    throw new ExternalImagePreparationError("Docker returned an invalid immutable image identity.");
  }
  return {
    kind: "external-image",
    reference,
    platform: support.platforms[0],
    runtimeImageContentId,
    toolDisclosure,
  };
}

export function prepareExternalImageWorkloadSource(
  input: PrepareExternalImageInput,
  dependencies: PrepareExternalImageDependencies,
): ExternalImageWorkloadSource {
  const reference = parseExactExternalImageReference(input.reference);
  const agent = requireExternalImageAgent(input.agentName);
  if (input.runtime.externalImages === null || input.runtime.externalImages === undefined) {
    throw new ExternalImagePreparationError(
      `driver '${input.runtime.driverName}' does not support user-supplied images.`,
    );
  }
  let inspected = dependencies.capture(
    "external-image-preparation",
    ["image", "inspect", reference],
    PREPARE_TIMEOUT_MS,
  );
  if (inspected.error) {
    throw new ExternalImagePreparationError("Docker image inspection is unavailable.", {
      cause: inspected.error,
    });
  }
  if (inspected.status !== 0) {
    if (!isMissingLocalImage(inspected)) {
      throw new ExternalImagePreparationError(
        "Docker could not inspect the requested image locally.",
      );
    }
    const pulled = dependencies.capture(
      "external-image-preparation",
      ["pull", reference],
      PREPARE_TIMEOUT_MS,
    );
    if (pulled.status !== 0 || pulled.error) {
      throw new ExternalImagePreparationError(
        "Docker could not pull the requested image. Check image visibility or authenticate with Docker, then retry.",
        pulled.error ? { cause: pulled.error } : undefined,
      );
    }
    inspected = dependencies.capture(
      "external-image-preparation",
      ["image", "inspect", reference],
      PREPARE_TIMEOUT_MS,
    );
    if (inspected.status !== 0 || inspected.error) {
      throw new ExternalImagePreparationError(
        "Docker could not inspect the pulled image.",
        inspected.error ? { cause: inspected.error } : undefined,
      );
    }
  }
  return validateInspect(reference, parseInspectOutput(inspected.stdout), agent, input.runtime);
}
