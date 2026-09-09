// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  connectOpenShellReader,
  isNotFound,
  metadata,
  owned,
  readOpenShell,
  record,
  text,
  type ConnectOpenShellReader,
  type ReadRequest,
} from "./sdk-read";

import type { OpenShellProviderMetadata } from "./provider-adapter";

export type Provider = Readonly<
  Pick<OpenShellProviderMetadata, "name" | "type" | "credentialKeys" | "configKeys"> & {
    id: string;
    workspace: string;
    resourceVersion: string;
    config: Readonly<Record<string, string>>;
  }
>;
export interface Providers {
  get(
    request: ReadRequest & Readonly<{ name: string; configKeys: readonly string[] }>,
  ): Promise<Provider | null>;
}

export function createProviders(
  connect: ConnectOpenShellReader = connectOpenShellReader,
): Providers {
  return {
    get: (request) =>
      readOpenShell(request, async () => {
        const name = text(request.name);
        const configKeys = [...new Set(request.configKeys.map(text))];
        const client = await connect(request.target);
        request.signal.throwIfAborted();
        let response: unknown;
        try {
          // The pinned SDK has no curated gateway provider reader.
          response = await client.raw.getProvider(
            { name, workspace: request.workspace },
            { signal: request.signal },
          );
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
        const provider = record(record(response).provider);
        const config = record(provider.config);
        return owned({
          ...metadata(provider.metadata, name, request.workspace),
          type: text(provider.type),
          credentialKeys: [
            ...new Set([
              ...Object.keys(record(provider.credentials)),
              ...Object.keys(record(provider.credentialHandles ?? {})),
            ]),
          ]
            .map(text)
            .sort(),
          configKeys: Object.keys(config).map(text).sort(),
          config: Object.fromEntries(
            configKeys
              .filter((key) => Object.hasOwn(config, key))
              .map((key) => [key, text(config[key])]),
          ),
        });
      }),
  };
}
