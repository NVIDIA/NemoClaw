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
  type OpenShellReadClient,
} from "./sdk-read";

import { BuiltinNvidiaProfileResponseSchema, ProviderResponseSchema } from "./sdk-read-schema";

import { BUILD_ENDPOINT_URL } from "../../inference/provider-models";

import type { OpenShellProviderMetadata } from "./provider-adapter";

export type Provider = Readonly<
  Pick<OpenShellProviderMetadata, "name" | "type" | "credentialKeys" | "configKeys"> & {
    id: string;
    workspace: string;
    resourceVersion: string;
    config: Readonly<Record<string, string>>;
    builtinInferenceEndpoint?: string;
  }
>;
export interface Providers {
  get(
    request: ReadRequest & Readonly<{ name: string; configKeys: readonly string[] }>,
  ): Promise<Provider | null>;
}

async function readBuiltinNvidiaEndpoint(
  client: OpenShellReadClient,
  request: ReadRequest,
): Promise<string> {
  request.signal.throwIfAborted();
  readValue(
    BuiltinNvidiaProfileResponseSchema,
    await client.raw.getProviderProfile(
      { id: "nvidia", workspace: request.workspace },
      { signal: request.signal },
    ),
  );
  return BUILD_ENDPOINT_URL;
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
        const { provider } = readValue(ProviderResponseSchema, response);
        const { config } = provider;
        const identity = metadata(provider.metadata, name, request.workspace);
        let builtinInferenceEndpoint: string | undefined;
        if (
          provider.type === "nvidia" &&
          provider.profileWorkspace === "" &&
          Object.keys(config).length === 0
        ) {
          builtinInferenceEndpoint = await readBuiltinNvidiaEndpoint(client, request);
        }
        return owned({
          ...identity,
          ...(builtinInferenceEndpoint === undefined ? {} : { builtinInferenceEndpoint }),
          type: provider.type,
          credentialKeys: [
            ...new Set([
              ...Object.keys(provider.credentials),
              ...Object.keys(provider.credentialHandles ?? {}),
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
