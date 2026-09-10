// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import { MetadataSchema, ReadTextSchema, WorkspaceSchema } from "./sdk-read-schema";
import { cloneAndDeepFreeze } from "../../core/immutable";
import { connectManagedOpenShellSdk } from "./sdk";
import type { OpenShellGatewayTarget, OpenShellSandboxError } from "./sandbox-observer";

const { Check } = require("typebox/value") as typeof TypeBoxValueModule;

export type ReadRequest = Readonly<{
  target: OpenShellGatewayTarget;
  workspace: string;
  signal: AbortSignal;
}>;

type Options = Readonly<{ signal: AbortSignal }>;
/** Only SDK reads used by configuration export. Integration tests check the SDK boundary. */
export interface OpenShellReadClient {
  readonly raw: {
    getProvider(request: { name: string; workspace: string }, options: Options): Promise<unknown>;
    getProviderProfile(
      request: { id: string; workspace: string },
      options: Options,
    ): Promise<unknown>;
    getSandbox(request: { name: string; workspace: string }, options: Options): Promise<unknown>;
    getSandboxConfig(request: { sandboxId: string }, options: Options): Promise<unknown>;
  };
}
export type ConnectOpenShellReader = (
  target: OpenShellGatewayTarget,
) => Promise<OpenShellReadClient>;

export const connectOpenShellReader: ConnectOpenShellReader = async (target) =>
  (await connectManagedOpenShellSdk(target)) as OpenShellReadClient;

export class OpenShellReadError extends Error {
  constructor(readonly kind: Exclude<OpenShellSandboxError["kind"], "command">) {
    super(`OpenShell read failed (${kind}).`);
  }
}

export function readValue<Schema extends TypeBoxModule.Type.TSchema>(
  schema: Schema,
  value: unknown,
): TypeBoxModule.Type.Static<Schema> {
  if (!Check(schema, value)) throw new OpenShellReadError("schema");
  return value;
}

export function text(value: unknown): string {
  return readValue(ReadTextSchema, value);
}

export function metadata(
  meta: TypeBoxModule.Type.Static<typeof MetadataSchema>,
  name: string,
  workspace: string,
) {
  if (meta.name !== name || meta.workspace !== workspace) throw new OpenShellReadError("schema");
  return { id: meta.id, name, workspace, resourceVersion: String(meta.resourceVersion) };
}
export const owned = cloneAndDeepFreeze;

function readError(error: unknown): OpenShellReadError {
  if (error instanceof OpenShellReadError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if ([7, 16, "permission_denied", "unauthenticated"].some((status) => status === code)) {
    return new OpenShellReadError("authentication");
  }
  if (code === 4 || code === "deadline_exceeded") return new OpenShellReadError("timeout");
  return new OpenShellReadError("transport");
}

/** Honor the caller's abort/deadline signal; never expose transport details or response data. */
export async function readOpenShell<T>(
  request: ReadRequest,
  operation: () => Promise<T>,
): Promise<T> {
  if (request.target.kind !== "named" || !Check(WorkspaceSchema, request.workspace)) {
    throw new OpenShellReadError("schema");
  }
  const { signal } = request;
  let abort: () => void = () => {};
  try {
    signal.throwIfAborted();
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new OpenShellReadError("timeout"));
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (signal.aborted) throw new OpenShellReadError("timeout");
    throw readError(error);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === 5;
}
