// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pending network rule requests over the pinned OpenShell SDK.
 *
 * When a sandboxed process is denied network access, OpenShell can record a
 * pending draft chunk that proposes the rule needed to allow it. These helpers
 * list the pending chunks and approve or reject one by ID. Approval submits the
 * review token returned with the chunk that was read, so the gateway refuses
 * the approval if the candidate policy changed after it was shown.
 */

import { isValidName } from "../../../../nemoclaw/dist/shared/sandbox-name.cjs";
import type { OpenShellGatewayTarget } from "./sandbox-observer";
import { OPENSHELL_DEFAULT_WORKSPACE } from "./sandbox-ssh-host";

export type PolicyRequestEndpoint = Readonly<{
  host: string;
  port: number;
  protocol: string;
  access: string;
  rules: readonly Readonly<{ method: string; path: string }>[];
}>;

export type PolicyRequest = Readonly<{
  id: string;
  status: string;
  ruleName: string;
  binary: string;
  endpoints: readonly PolicyRequestEndpoint[];
  rationale: string;
  securityNotes: string;
  validationResult: string;
  applicationError: string;
  hitCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
  reviewToken: string;
}>;

export type PolicyRequestErrorKind =
  | "schema"
  | "authentication"
  | "timeout"
  | "not_found"
  | "stale"
  | "local_state"
  | "unavailable";

export type PolicyRequestError = Readonly<{
  kind: PolicyRequestErrorKind;
  message: string;
}>;

export type PolicyRequestResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: PolicyRequestError }>;

export type PolicyRequestTarget = Readonly<{
  sandboxName: string;
  target: Extract<OpenShellGatewayTarget, { kind: "named" }>;
  timeoutMs?: number;
}>;

export type ApprovePolicyRequest = PolicyRequestTarget &
  Readonly<{ chunkId: string; reviewToken: string }>;

export type RejectPolicyRequest = PolicyRequestTarget &
  Readonly<{ chunkId: string; reason: string }>;

export type ApprovedPolicyRequest = Readonly<{
  policyVersion: number;
  policyHash: string;
}>;

export interface OpenShellPolicyRequests {
  listPending(request: PolicyRequestTarget): Promise<PolicyRequestResult<PolicyRequest[]>>;
  approve(request: ApprovePolicyRequest): Promise<PolicyRequestResult<ApprovedPolicyRequest>>;
  reject(request: RejectPolicyRequest): Promise<PolicyRequestResult<null>>;
}

type CallOptions = Readonly<{ signal: AbortSignal }>;

type SdkEndpoint = Readonly<{
  host?: string;
  port?: number;
  ports?: readonly number[];
  protocol?: string;
  access?: string;
  rules?: readonly Readonly<{
    allow?: Readonly<{ method?: string; path?: string }>;
  }>[];
}>;

type SdkChunk = Readonly<{
  id?: string;
  status?: string;
  ruleName?: string;
  binary?: string;
  proposedRule?: Readonly<{ endpoints?: readonly SdkEndpoint[] }>;
  rationale?: string;
  securityNotes?: string;
  validationResult?: string;
  applicationError?: string;
  hitCount?: number;
  firstSeenMs?: bigint | number;
  lastSeenMs?: bigint | number;
  reviewToken?: string;
}>;

type SdkClient = Readonly<{
  raw: Readonly<{
    getDraftPolicy(
      request: Readonly<{
        name: string;
        statusFilter: string;
        workspace: string;
      }>,
      options: CallOptions,
    ): Promise<Readonly<{ chunks?: readonly SdkChunk[] }>>;
    approveDraftChunk(
      request: Readonly<{
        name: string;
        chunkId: string;
        workspace: string;
        reviewToken: string;
      }>,
      options: CallOptions,
    ): Promise<Readonly<{ policyVersion?: number; policyHash?: string }>>;
    rejectDraftChunk(
      request: Readonly<{
        name: string;
        chunkId: string;
        reason: string;
        workspace: string;
      }>,
      options: CallOptions,
    ): Promise<unknown>;
  }>;
}>;

export type SdkOpenShellPolicyRequestsDeps = Readonly<{
  connect?: (target: OpenShellGatewayTarget, options: CallOptions) => Promise<SdkClient>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}>;

const DEFAULT_TIMEOUT_MS = 30_000;
const CHUNK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_REVIEW_TOKEN_LENGTH = 4096;

function failure<T>(kind: PolicyRequestErrorKind, message: string): PolicyRequestResult<T> {
  return { ok: false, error: { kind, message } };
}

function errorField(error: unknown, field: "code" | "connectCode"): string {
  return error && typeof error === "object" && field in error
    ? String((error as Record<string, unknown>)[field])
    : "";
}

function classifyError(error: unknown, timedOut: boolean): PolicyRequestError {
  if (timedOut) return { kind: "timeout", message: "OpenShell did not respond in time." };
  const message = error instanceof Error ? error.message : "";
  if (error instanceof Error && error.name === "OpenShellSdkPreflightUnavailableError") {
    // The preflight names the local gateway state problem (for example an unsafe
    // directory mode); pass it through so the operator can fix it.
    return { kind: "local_state", message: error.message };
  }
  if (/Cannot find (?:module|package) ['"]@nvidia\/openshell-sdk['"]/u.test(message)) {
    return { kind: "unavailable", message: "OpenShell SDK is unavailable." };
  }
  const code = errorField(error, "code");
  const connectCode = errorField(error, "connectCode");
  if (
    ["7", "16", "auth", "permission_denied", "unauthenticated"].includes(code) ||
    ["7", "16"].includes(connectCode)
  ) {
    return { kind: "authentication", message: "OpenShell denied access." };
  }
  if (["4", "canceled", "deadline_exceeded"].includes(code) || connectCode === "4") {
    return { kind: "timeout", message: "OpenShell did not respond in time." };
  }
  if (["5", "not_found"].includes(code) || connectCode === "5") {
    return {
      kind: "not_found",
      message: "OpenShell could not find that sandbox or request.",
    };
  }
  if (["9", "failed_precondition"].includes(code) || connectCode === "9") {
    return {
      kind: "stale",
      message: "The request changed after it was read and needs a fresh review.",
    };
  }
  const name = error instanceof Error && error.name ? error.name : "unknown error";
  const detail = [name, code ? `code ${code}` : "", connectCode ? `connect ${connectCode}` : ""]
    .filter(Boolean)
    .join(", ");
  return {
    kind: "unavailable",
    message: `OpenShell is unavailable (${detail}).`,
  };
}

function validTarget(request: PolicyRequestTarget): boolean {
  return (
    isValidName(request.sandboxName) &&
    isValidName(request.target.gatewayName) &&
    (request.timeoutMs === undefined ||
      (Number.isFinite(request.timeoutMs) && request.timeoutMs > 0))
  );
}

function toNumber(value: bigint | number | undefined): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toEndpoint(endpoint: SdkEndpoint): PolicyRequestEndpoint {
  const port = endpoint.port || endpoint.ports?.find((value) => value > 0) || 0;
  return {
    host: endpoint.host ?? "",
    port,
    protocol: endpoint.protocol ?? "",
    access: endpoint.access ?? "",
    rules: (endpoint.rules ?? [])
      .map((rule) => ({
        method: rule.allow?.method ?? "",
        path: rule.allow?.path ?? "",
      }))
      .filter((rule) => rule.method || rule.path),
  };
}

function toPolicyRequest(chunk: SdkChunk): PolicyRequest | null {
  const id = chunk.id ?? "";
  if (!CHUNK_ID_PATTERN.test(id)) return null;
  return {
    id,
    status: chunk.status ?? "",
    ruleName: chunk.ruleName ?? "",
    binary: chunk.binary ?? "",
    endpoints: (chunk.proposedRule?.endpoints ?? []).map(toEndpoint),
    rationale: chunk.rationale ?? "",
    securityNotes: chunk.securityNotes ?? "",
    validationResult: chunk.validationResult ?? "",
    applicationError: chunk.applicationError ?? "",
    hitCount: typeof chunk.hitCount === "number" ? chunk.hitCount : 0,
    firstSeenMs: toNumber(chunk.firstSeenMs),
    lastSeenMs: toNumber(chunk.lastSeenMs),
    reviewToken: chunk.reviewToken ?? "",
  };
}

async function withClient<T>(
  request: PolicyRequestTarget,
  connect: (target: OpenShellGatewayTarget, options: CallOptions) => Promise<SdkClient>,
  operation: (client: SdkClient, options: CallOptions) => Promise<T>,
): Promise<PolicyRequestResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          Object.assign(new Error("OpenShell SDK call timed out."), {
            code: "4",
          }),
        ),
      { once: true },
    );
  });
  try {
    const options = { signal: controller.signal };
    const client = await Promise.race([connect(request.target, options), aborted]);
    const value = await Promise.race([operation(client, options), aborted]);
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: classifyError(error, controller.signal.aborted),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Use the pinned OpenShell SDK to review pending network rule requests. */
export function createSdkOpenShellPolicyRequests(
  deps: SdkOpenShellPolicyRequestsDeps = {},
): OpenShellPolicyRequests {
  const connect =
    deps.connect ??
    (async (target, options) => {
      const { connectManagedOpenShellSdk } = require("./sdk") as typeof import("./sdk");
      return (await connectManagedOpenShellSdk(target, {
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        signal: options.signal,
      })) as SdkClient;
    });

  return {
    async listPending(request) {
      if (!validTarget(request)) return failure("schema", "Invalid sandbox request.");
      const result = await withClient(request, connect, (client, options) =>
        client.raw.getDraftPolicy(
          {
            name: request.sandboxName,
            statusFilter: "pending",
            workspace: OPENSHELL_DEFAULT_WORKSPACE,
          },
          options,
        ),
      );
      if (!result.ok) return result;
      const requests = (result.value.chunks ?? [])
        .map(toPolicyRequest)
        .filter((chunk): chunk is PolicyRequest => chunk !== null && chunk.status === "pending");
      return { ok: true, value: requests };
    },

    async approve(request) {
      if (
        !validTarget(request) ||
        !CHUNK_ID_PATTERN.test(request.chunkId) ||
        !request.reviewToken ||
        request.reviewToken.length > MAX_REVIEW_TOKEN_LENGTH
      ) {
        return failure("schema", "Invalid approval request.");
      }
      const result = await withClient(request, connect, (client, options) =>
        client.raw.approveDraftChunk(
          {
            name: request.sandboxName,
            chunkId: request.chunkId,
            workspace: OPENSHELL_DEFAULT_WORKSPACE,
            reviewToken: request.reviewToken,
          },
          options,
        ),
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          policyVersion: result.value.policyVersion ?? 0,
          policyHash: result.value.policyHash ?? "",
        },
      };
    },

    async reject(request) {
      if (!validTarget(request) || !CHUNK_ID_PATTERN.test(request.chunkId)) {
        return failure("schema", "Invalid rejection request.");
      }
      const result = await withClient(request, connect, (client, options) =>
        client.raw.rejectDraftChunk(
          {
            name: request.sandboxName,
            chunkId: request.chunkId,
            reason: request.reason,
            workspace: OPENSHELL_DEFAULT_WORKSPACE,
          },
          options,
        ),
      );
      return result.ok ? { ok: true, value: null } : result;
    },
  };
}
