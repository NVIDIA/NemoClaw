// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { retryUntilAsync } from "../../core/retry";
import type { ServingModelDefinition } from "./types";

const HUGGING_FACE_ORIGIN = "https://huggingface.co";
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64})$/u;
const RETRY_DELAYS_MS = [250, 1_000] as const;
const DEFAULT_TIMEOUT_MS = 15_000;

type HuggingFaceModelReference = Pick<ServingModelDefinition, "metadata" | "spec">;
type VerificationAttempt =
  | { readonly kind: "response"; readonly response: Pick<Response, "ok" | "status" | "statusText"> }
  | { readonly kind: "error"; readonly error: unknown };

export type HuggingFaceReferenceFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "statusText">>;

export interface HuggingFaceModelVerificationOptions {
  readonly fetch?: HuggingFaceReferenceFetch;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly timeoutMs?: number;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function referenceUrl(modelId: string, revision: string): URL {
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw new Error(`Invalid Hugging Face model ID '${modelId}'.`);
  }
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`Invalid Hugging Face revision '${revision}' for '${modelId}'.`);
  }
  const [owner, repository] = modelId.split("/") as [string, string];
  if ([owner, repository].some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid Hugging Face model ID '${modelId}'.`);
  }
  return new URL(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/resolve/${encodeURIComponent(revision)}/config.json`,
    HUGGING_FACE_ORIGIN,
  );
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function verifyReference(
  model: HuggingFaceModelReference,
  options: HuggingFaceModelVerificationOptions,
): Promise<void> {
  const { id: modelId, revision } = model.spec;
  const url = referenceUrl(modelId, revision);
  const fetchReference = options.fetch ?? fetch;
  const wait = options.sleep ?? sleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await retryUntilAsync<VerificationAttempt>(
    async () => {
      try {
        return {
          kind: "response",
          response: await fetchReference(url, {
            method: "HEAD",
            redirect: "follow",
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
          }),
        };
      } catch (error) {
        return { kind: "error", error };
      }
    },
    {
      accept: (attempt) =>
        attempt.kind === "response" &&
        (attempt.response.ok || !isTransientStatus(attempt.response.status)),
      retryDelaysMs: RETRY_DELAYS_MS,
      sleep: wait,
    },
  );

  if (result.kind === "error") {
    throw new Error(
      `Could not verify Hugging Face model '${modelId}' at revision '${revision}' after ${RETRY_DELAYS_MS.length + 1} attempts: ${errorMessage(result.error)}`,
      { cause: result.error },
    );
  }
  if (result.response.ok) return;
  const accessDetail =
    result.response.status === 401 || result.response.status === 403
      ? " The pinned config.json must be visible to credential-free pull request validation."
      : "";
  throw new Error(
    `Hugging Face model '${modelId}' at revision '${revision}' returned HTTP ${result.response.status}${result.response.statusText ? ` ${result.response.statusText}` : ""}.${accessDetail}`,
  );
}

/** Confirm that every catalog model exposes its pinned config on Hugging Face. */
export async function verifyHuggingFaceModelReferences(
  models: readonly HuggingFaceModelReference[],
  options: HuggingFaceModelVerificationOptions = {},
): Promise<void> {
  for (const model of models) await verifyReference(model, options);
}
