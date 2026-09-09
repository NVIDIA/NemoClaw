// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  connectOpenShellReader,
  OpenShellReadError,
  owned,
  readOpenShell,
  readValue,
  text,
  type ConnectOpenShellReader,
  type ReadRequest,
} from "./sdk-read";

import { SandboxConfigResponseSchema } from "./sdk-read-schema";

export type SandboxConfig = Readonly<{
  sandboxId: string;
  workspace: string;
  revision: number;
  policyHash: string;
  configRevision: string;
  providerEnvRevision: string;
  policySource: "sandbox" | "global";
  globalPolicyVersion: number;
}>;

/** Configuration identity complements the existing effective-policy reader (#9805, #9826). */
export function createSandboxConfig(connect: ConnectOpenShellReader = connectOpenShellReader) {
  return {
    get: (request: ReadRequest & Readonly<{ sandboxId: string }>): Promise<SandboxConfig> =>
      readOpenShell(request, async () => {
        const sandboxId = text(request.sandboxId);
        const client = await connect(request.target);
        request.signal.throwIfAborted();
        // sandbox.getConfig(name) performs a new name lookup and omits workspace identity.
        const config = readValue(
          SandboxConfigResponseSchema,
          await client.raw.getSandboxConfig({ sandboxId }, { signal: request.signal }),
        );
        if (config.workspace !== request.workspace) {
          throw new OpenShellReadError("schema");
        }
        return owned({
          sandboxId,
          workspace: request.workspace,
          revision: config.version,
          policyHash: config.policyHash,
          configRevision: String(config.configRevision),
          providerEnvRevision: String(config.providerEnvRevision),
          policySource: config.policySource === 1 ? "sandbox" : "global",
          globalPolicyVersion: config.globalPolicyVersion,
        });
      }),
  };
}
