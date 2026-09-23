// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import type { ToolDisclosure } from "../../tool-disclosure";
import type { OpenShellSandboxBufferedCommandExecutor } from "../../adapters/openshell/sandbox-command";

const REFERENCE =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/u;
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/u;

export interface ExternalImageReceipt {
  readonly schemaVersion: 1;
  readonly kind: "external-image";
  readonly reference: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly imageId: string;
  readonly agent: "openclaw" | "hermes";
  readonly toolDisclosure: ToolDisclosure;
  readonly shared: true;
}

export function requireExternalImageReference(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !REFERENCE.test(value)) {
    throw new Error(
      "--from-image requires a repository@sha256:<64 lowercase hex digits> reference; mutable tags are not supported.",
    );
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function cloneExternalImageReceipt(value: unknown): ExternalImageReceipt | undefined {
  const receipt = object(value);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "external-image" ||
    receipt.shared !== true ||
    typeof receipt.reference !== "string" ||
    receipt.reference.length > 512 ||
    !REFERENCE.test(receipt.reference) ||
    typeof receipt.imageId !== "string" ||
    !CONTENT_ID.test(receipt.imageId) ||
    (receipt.platform !== "linux/amd64" && receipt.platform !== "linux/arm64") ||
    (receipt.agent !== "openclaw" && receipt.agent !== "hermes") ||
    (receipt.toolDisclosure !== "progressive" && receipt.toolDisclosure !== "direct")
  )
    return undefined;
  return {
    schemaVersion: 1,
    kind: "external-image",
    reference: receipt.reference,
    platform: receipt.platform,
    imageId: receipt.imageId,
    agent: receipt.agent,
    toolDisclosure: receipt.toolDisclosure,
    shared: true,
  };
}

export function inspectExternalImageMetadata(input: {
  reference: string;
  agent: string;
  platform: string;
  metadata: unknown;
  requestedToolDisclosure?: ToolDisclosure | null;
}): ExternalImageReceipt {
  const reference = requireExternalImageReference(input.reference);
  if (input.agent !== "openclaw" && input.agent !== "hermes") {
    throw new Error("Prebuilt external images support OpenClaw and Hermes only.");
  }
  const image = object(input.metadata);
  const config = object(image.Config);
  const platform = `${String(image.Os)}/${String(image.Architecture)}`;
  if ((platform !== "linux/amd64" && platform !== "linux/arm64") || platform !== input.platform) {
    throw new Error(
      `External image platform must match the selected runtime platform ${input.platform}.`,
    );
  }
  const user = typeof config.User === "string" ? config.User.split(":")[0] : "";
  if (!user || user === "root" || (/^[0-9]+$/u.test(user) && Number(user) === 0)) {
    throw new Error("External image must declare a non-root final USER.");
  }
  if (config.WorkingDir !== "/sandbox") {
    throw new Error("External image must declare WORKDIR /sandbox.");
  }
  const command = [config.Entrypoint, config.Cmd].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  if (
    !command.length ||
    command.some((value) => typeof value !== "string" || value.includes("\0")) ||
    !command.some((value) => value.trim())
  ) {
    throw new Error(
      "External image must declare a usable ENTRYPOINT or CMD; readiness verifies that it stays alive.",
    );
  }
  const env = Array.isArray(config.Env) ? config.Env : [];
  const disclosureValues = env.filter(
    (value): value is string =>
      typeof value === "string" && value.startsWith("NEMOCLAW_TOOL_DISCLOSURE="),
  );
  const toolDisclosure = disclosureValues[0]?.slice("NEMOCLAW_TOOL_DISCLOSURE=".length);
  if (
    disclosureValues.length !== 1 ||
    (toolDisclosure !== "progressive" && toolDisclosure !== "direct")
  ) {
    throw new Error(
      "External image must contain one NEMOCLAW_TOOL_DISCLOSURE value: progressive or direct.",
    );
  }
  if (input.requestedToolDisclosure && input.requestedToolDisclosure !== toolDisclosure) {
    throw new Error(
      `Requested tool disclosure conflicts with the external image; select --tool-disclosure ${toolDisclosure}.`,
    );
  }
  const labels = object(config.Labels);
  const agentLabels = [labels["io.nvidia.nemoclaw.agent"], labels["harness.agent"]];
  const agentValues = env.filter(
    (value): value is string => typeof value === "string" && value.startsWith("NEMOCLAW_AGENT="),
  );
  if (
    agentLabels.some((label) => label !== undefined && label !== input.agent) ||
    agentValues.some((value) => value !== `NEMOCLAW_AGENT=${input.agent}`)
  ) {
    throw new Error("External image agent metadata conflicts with the selected agent.");
  }
  if (typeof image.Id !== "string" || !CONTENT_ID.test(image.Id)) {
    throw new Error("The selected runtime did not return an immutable image content identity.");
  }
  return {
    schemaVersion: 1,
    kind: "external-image",
    reference,
    platform,
    imageId: image.Id,
    agent: input.agent,
    toolDisclosure,
    shared: true,
  };
}

export function prepareExternalImage(input: {
  reference: string;
  agent: string;
  provider: RuntimeProviderBundle;
  requestedToolDisclosure?: ToolDisclosure | null;
  architecture?: string;
}): ExternalImageReceipt {
  const reference = requireExternalImageReference(input.reference);
  const provider = input.provider;
  if (input.agent !== "openclaw" && input.agent !== "hermes") {
    throw new Error("Prebuilt external images support OpenClaw and Hermes only.");
  }
  if (!provider.workload.profile.externalImages || !provider.containerEngine.supported) {
    throw new Error(
      `Runtime '${provider.identity.displayName}' does not support external prebuilt images.`,
    );
  }
  const architecture = input.architecture ?? process.arch;
  const platform = `linux/${architecture === "x64" ? "amd64" : architecture}`;
  const pulled = provider.containerEngine.capture(
    "sandbox-lifecycle",
    ["pull", reference],
    120_000,
  );
  if (pulled.status !== 0 || pulled.error) {
    throw new Error(
      "Cannot pull the external image. Check its digest, registry visibility, and credentials configured for the selected container runtime. No image was built.",
    );
  }
  const inspected = provider.containerEngine.capture(
    "sandbox-lifecycle",
    ["image", "inspect", reference],
    15_000,
  );
  if (inspected.status !== 0 || inspected.error || inspected.stdout.length > 2 * 1024 * 1024) {
    throw new Error("Cannot inspect the external image through the selected container runtime.");
  }
  let images: unknown;
  try {
    images = JSON.parse(inspected.stdout);
  } catch {
    throw new Error("The selected container runtime returned invalid image metadata.");
  }
  if (!Array.isArray(images) || images.length !== 1)
    throw new Error("External image inspection must return exactly one image.");
  return inspectExternalImageMetadata({ ...input, reference, platform, metadata: images[0] });
}

export async function verifyExternalOpenClawModel(input: {
  sandboxName: string;
  gatewayName: string;
  model: string;
  commandExecutor: OpenShellSandboxBufferedCommandExecutor;
}): Promise<void> {
  const result = await input.commandExecutor.runBuffered({
    sandboxName: input.sandboxName,
    target: { kind: "named", gatewayName: input.gatewayName },
    command: ["/bin/cat", "/sandbox/.openclaw/openclaw.json"],
    tty: false,
    timeoutMilliseconds: 15_000,
    outputLimitBytes: 1024 * 1024,
  });
  if (result.outcome.kind !== "completed" || result.outcome.exitCode !== 0) {
    throw new Error(
      "Cannot verify the external OpenClaw image's model configuration. Sandbox registration was not published.",
    );
  }
  let config: Record<string, unknown>;
  try {
    config = object(JSON.parse(result.stdout));
  } catch {
    throw new Error(
      "The external OpenClaw image has invalid model configuration. Sandbox registration was not published.",
    );
  }
  const primary = object(object(object(config.agents).defaults).model).primary;
  const models = object(object(object(config.models).providers).inference).models;
  const configuredModel = Array.isArray(models) ? object(models[0]).id : undefined;
  const normalize = (value: unknown) =>
    typeof value === "string" ? value.replace(/^inference\//u, "") : null;
  if (
    normalize(primary) !== normalize(input.model) ||
    normalize(configuredModel) !== normalize(input.model)
  ) {
    throw new Error(
      "The external OpenClaw image's model does not match the selected route. Use a compatible image whose startup can reconcile the sandbox-owned OpenClaw configuration. Sandbox registration was not published.",
    );
  }
}
