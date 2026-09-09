// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  connectOpenShellReader,
  integer,
  OpenShellReadError,
  isNotFound,
  metadata,
  owned,
  readOpenShell,
  record,
  text,
  type ConnectOpenShellReader,
  type ReadRequest,
} from "./sdk-read";

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
        const sandbox = record(record(response).sandbox);
        const status = record(sandbox.status);
        const spec = record(sandbox.spec);
        if (!Array.isArray(spec.providers)) throw new OpenShellReadError("schema");
        return owned({
          ...metadata(sandbox.metadata, name, request.workspace),
          policyVersion: integer(status.currentPolicyVersion),
          image: text(record(spec.template).image),
          providers: spec.providers.map(text).sort(),
        });
      }),
  };
}
