// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  connectOpenShellReader,
  isNotFound,
  metadata,
  owned,
  readOpenShell,
  readValue,
  text,
  type ConnectOpenShellReader,
  type ReadRequest,
} from "./sdk-read";

import { SandboxResponseSchema } from "./sdk-read-schema";

export type Sandbox = Readonly<{
  id: string;
  name: string;
  workspace: string;
  resourceVersion: string;
  policyVersion: number;
  image: string;
  providers: readonly string[];
}>;

export function createSandboxes(connect: ConnectOpenShellReader = connectOpenShellReader) {
  return {
    get: (request: ReadRequest & Readonly<{ name: string }>): Promise<Sandbox | null> =>
      readOpenShell(request, async () => {
        const name = text(request.name);
        const client = await connect(request.target);
        request.signal.throwIfAborted();
        let response: unknown;
        try {
          // sandbox.get() omits workspace, template image, and the active policy version.
          response = await client.raw.getSandbox(
            { name, workspace: request.workspace },
            { signal: request.signal },
          );
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
        const { sandbox } = readValue(SandboxResponseSchema, response);
        const { status, spec } = sandbox;
        return owned({
          ...metadata(sandbox.metadata, name, request.workspace),
          policyVersion: status.currentPolicyVersion,
          image: spec.template.image,
          providers: [...spec.providers].sort(),
        });
      }),
  };
}
