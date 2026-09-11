// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBearerAuthConfig } from "../../adapters/http/auth-config";
import {
  type CurlProbeOptions,
  type CurlProbeResult,
  runCurlProbe,
} from "../../adapters/http/probe";
import {
  ATTACHMENT_MAX_PROBE_RESPONSE_BYTES,
  attachmentProbeArgs as probeArgs,
  boundedProbeFailure as boundedAttachmentProbeFailure,
  isAuthenticationStatus,
  parseJsonObject,
  resolveFixedLoopbackOrigin,
} from "../probe/existing-server-attachment";
import { isSafeLlmmanModelReference, LLMMAN_HOST_BASE_URL, LLMMAN_PORT } from "./contract";

export * from "./contract";

export type LlmmanAttachmentFailureReason =
  | "unreachable"
  | "authentication-required"
  | "authentication-rejected"
  | "credential-preparation"
  | "invalid-endpoint"
  | "oversized-response"
  | "probe-timeout"
  | "malformed-fingerprint"
  | "not-llmman"
  | "model-not-found"
  | "ambiguous-model"
  | "unsafe-model-reference";

export type LlmmanAttachmentResult =
  | { ok: true; model: string; version: string; availableModels: string[] }
  | {
      ok: false;
      reason: LlmmanAttachmentFailureReason;
      message: string;
      /** Stored model references from `/api/tags`, when the daemon answered. */
      availableModels?: string[];
    };

export interface ProbeLlmmanAttachmentOptions {
  requestedModel?: string | null;
  baseUrl?: string;
  runCurlProbeImpl?: (argv: string[], options?: CurlProbeOptions) => CurlProbeResult;
}

function failure(
  reason: LlmmanAttachmentFailureReason,
  message: string,
  availableModels?: string[],
): LlmmanAttachmentResult {
  return availableModels
    ? { ok: false, reason, message, availableModels }
    : { ok: false, reason, message };
}

function boundedProbeFailure(result: CurlProbeResult): LlmmanAttachmentResult | null {
  const bounded = boundedAttachmentProbeFailure(result, "llmman");
  return bounded ? failure(bounded.reason, bounded.message) : null;
}

/** Ollama's `/api/version` reports only `version`; llmman adds `exe` and `pid`. */
function parseLlmmanVersion(body: string): string | null {
  const parsed = parseJsonObject(body);
  if (!parsed) return null;
  const { version, exe, pid } = parsed;
  if (typeof version !== "string" || !version.trim()) return null;
  if (typeof exe !== "string" || !exe.trim()) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  return version.trim();
}

function parseStoredModelReferences(body: string): string[] | null {
  const parsed = parseJsonObject(body);
  if (!parsed || !Array.isArray(parsed.models)) return null;
  const names: string[] = [];
  for (const entry of parsed.models) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { name, model } = entry as { name?: unknown; model?: unknown };
    const reference = typeof name === "string" && name ? name : model;
    if (typeof reference !== "string" || !reference) return null;
    names.push(reference);
  }
  return names;
}

/** Match a request against the stored catalog; an untagged request matches `:latest`. */
export function selectLlmmanModelReference(
  availableModels: readonly string[],
  requestedModel: string,
): string | null {
  const requested = requestedModel.trim();
  if (!requested) return null;
  if (availableModels.includes(requested)) return requested;
  // Only the last path segment may carry a tag; `localhost:5000/model` has a port, not a tag.
  const lastSegment = requested.slice(requested.lastIndexOf("/") + 1);
  if (lastSegment.includes(":") || lastSegment.includes("@")) return null;
  const withLatest = `${requested}:latest`;
  return availableModels.includes(withLatest) ? withLatest : null;
}

function selectModel(
  availableModels: string[],
  requestedModel: string | null,
): LlmmanAttachmentResult | string {
  if (requestedModel) {
    return (
      selectLlmmanModelReference(availableModels, requestedModel) ??
      failure(
        "model-not-found",
        `llmman has no stored model '${requestedModel}'. Pull it with \`llmman pull ${requestedModel}\`.`,
        availableModels,
      )
    );
  }
  if (availableModels.length === 1) return availableModels[0]!;
  return failure(
    "ambiguous-model",
    availableModels.length === 0
      ? "llmman has no stored models. Pull one with `llmman pull <model>`."
      : "llmman stores multiple models; specify one model reference.",
    availableModels,
  );
}

/**
 * Identify an operator-run llmman daemon before attachment: `/api/version` must
 * require a key and report llmman's identity, and `/api/tags` lists the models.
 * An open daemon is refused because the OpenShell host bridge would expose it.
 */
export function probeLlmmanAttachment(
  apiKey: string,
  options: ProbeLlmmanAttachmentOptions = {},
): LlmmanAttachmentResult {
  if (!apiKey.trim()) {
    return failure(
      "authentication-required",
      "An llmman API key (LLMMAN_API_KEYS) is required for existing-server attachment.",
    );
  }
  const baseUrl = resolveFixedLoopbackOrigin(options.baseUrl ?? LLMMAN_HOST_BASE_URL, LLMMAN_PORT);
  if (!baseUrl) {
    return failure(
      "invalid-endpoint",
      `llmman attachment is restricted to loopback port ${LLMMAN_PORT}.`,
    );
  }
  const probe = options.runCurlProbeImpl ?? runCurlProbe;
  const anonymous = probe(probeArgs([], `${baseUrl}/api/version`), {
    maxResponseBytes: ATTACHMENT_MAX_PROBE_RESPONSE_BYTES,
    pinnedAddresses: [],
  });
  const anonymousBoundFailure = boundedProbeFailure(anonymous);
  if (anonymousBoundFailure) return anonymousBoundFailure;
  if (anonymous.curlStatus !== 0 || anonymous.httpStatus === 0) {
    return failure(
      "unreachable",
      `No llmman daemon responded on fixed port ${LLMMAN_PORT}. Start it with \`llmman serve\`.`,
    );
  }
  if (anonymous.httpStatus === 200) {
    return parseLlmmanVersion(anonymous.body)
      ? failure(
          "authentication-required",
          "The llmman daemon answered without an API key. Start it with " +
            "`LLMMAN_API_KEYS=<key> llmman serve` so the sandbox route is authenticated.",
        )
      : failure(
          "not-llmman",
          `The server on port ${LLMMAN_PORT} did not identify itself as llmman.`,
        );
  }
  if (!isAuthenticationStatus(anonymous.httpStatus)) {
    return failure(
      "not-llmman",
      "The server did not return a recognizable status from the version endpoint.",
    );
  }

  let auth;
  try {
    auth = createBearerAuthConfig(apiKey, { prefix: "nemoclaw-llmman-probe" });
  } catch {
    return failure(
      "credential-preparation",
      "The llmman credential could not be prepared for a protected probe.",
    );
  }
  try {
    const probeOptions: CurlProbeOptions = {
      maxResponseBytes: ATTACHMENT_MAX_PROBE_RESPONSE_BYTES,
      trustedConfigFiles: auth.trustedConfigFiles,
      pinnedAddresses: [],
    };
    const version = probe(probeArgs(auth.args, `${baseUrl}/api/version`), probeOptions);
    const versionBoundFailure = boundedProbeFailure(version);
    if (versionBoundFailure) return versionBoundFailure;
    if (isAuthenticationStatus(version.httpStatus)) {
      return failure("authentication-rejected", "The llmman API key was rejected.");
    }
    const daemonVersion = version.ok ? parseLlmmanVersion(version.body) : null;
    if (!daemonVersion) {
      return failure(
        "not-llmman",
        "The version endpoint did not report the llmman daemon identity (version, exe, pid).",
      );
    }

    const tags = probe(probeArgs(auth.args, `${baseUrl}/api/tags`), probeOptions);
    const tagsBoundFailure = boundedProbeFailure(tags);
    if (tagsBoundFailure) return tagsBoundFailure;
    if (isAuthenticationStatus(tags.httpStatus)) {
      return failure("authentication-rejected", "The llmman API key was rejected.");
    }
    const availableModels = tags.ok ? parseStoredModelReferences(tags.body) : null;
    if (!availableModels) {
      return failure("malformed-fingerprint", "The llmman model catalog was malformed.");
    }

    const model = selectModel(availableModels, options.requestedModel?.trim() || null);
    if (typeof model !== "string") return model;
    if (!isSafeLlmmanModelReference(model)) {
      return failure(
        "unsafe-model-reference",
        "The llmman model reference is not a safe sandbox model id.",
        availableModels,
      );
    }
    return { ok: true, model, version: daemonVersion, availableModels };
  } finally {
    auth.cleanup();
  }
}
