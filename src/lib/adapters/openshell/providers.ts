// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
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
  OpenShellReadError,
} from "./sdk-read";

import {
  ManagedBraveProfileResponseSchema,
  ManagedOpenAiProfileResponseSchema,
  BuiltinNvidiaProfileResponseSchema,
  ProviderResponseSchema,
} from "./sdk-read-schema";

import { BUILD_ENDPOINT_URL } from "../../inference/provider-models";

import type { OpenShellProviderMetadata } from "./provider-adapter";

export type Provider = Readonly<
  Pick<OpenShellProviderMetadata, "name" | "type" | "credentialKeys" | "configKeys"> & {
    id: string;
    workspace: string;
    resourceVersion: string;
    config: Readonly<Record<string, string>>;
    builtinInferenceEndpoint?: string;
    profileWorkspace?: string;
    managedProfile?: Readonly<{
      id: "brave" | "openai";
      source: "builtin" | "user";
      scope: "" | "platform" | "workspace";
      resourceVersion: string;
    }>;
  }
>;
export interface Providers {
  get(
    request: ReadRequest &
      Readonly<{
        name: string;
        configKeys: readonly string[];
        profileContract?: "brave" | "openai";
      }>,
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

async function readManagedProfile(
  client: OpenShellReadClient,
  request: ReadRequest,
  profileId: "brave" | "openai",
  providerType: string,
  profileWorkspace: string | undefined,
): Promise<NonNullable<Provider["managedProfile"]>> {
  if (
    providerType !== profileId ||
    (profileWorkspace !== "" && profileWorkspace !== request.workspace)
  )
    throw new OpenShellReadError("schema");
  request.signal.throwIfAborted();
  const { profile } = readValue(
    profileId === "brave" ? ManagedBraveProfileResponseSchema : ManagedOpenAiProfileResponseSchema,
    await client.raw.getProviderProfile(
      // Resolve the actual profile binding; the default-workspace import is managed state.
      { id: profileId, workspace: profileWorkspace },
      { signal: request.signal },
    ),
  );
  const builtin = profile.source === "builtin";
  const customScope = profileWorkspace === "" ? "platform" : "workspace";
  const expectedScope = builtin ? "" : customScope;
  if (
    !isDeepStrictEqual(
      [profile.scope, profileWorkspace, BigInt(profile.resourceVersion) === 0n],
      [expectedScope, builtin ? "" : profileWorkspace, builtin],
    )
  )
    throw new OpenShellReadError("schema");
  return {
    id: profile.id,
    source: profile.source,
    scope: profile.scope,
    resourceVersion: String(profile.resourceVersion),
  };
}

async function readProfileEvidence(
  client: OpenShellReadClient,
  request: Parameters<Providers["get"]>[0],
  provider: Readonly<{ type: string; profileWorkspace?: string; config: Record<string, unknown> }>,
): Promise<Pick<Provider, "builtinInferenceEndpoint" | "profileWorkspace" | "managedProfile">> {
  let builtinInferenceEndpoint: string | undefined;
  if (
    provider.type === "nvidia" &&
    provider.profileWorkspace === "" &&
    Object.keys(provider.config).length === 0
  ) {
    builtinInferenceEndpoint = await readBuiltinNvidiaEndpoint(client, request);
  }
  const managedProfile =
    request.profileContract === undefined
      ? undefined
      : await readManagedProfile(
          client,
          request,
          request.profileContract,
          provider.type,
          provider.profileWorkspace,
        );
  return {
    ...(builtinInferenceEndpoint === undefined ? {} : { builtinInferenceEndpoint }),
    ...(provider.profileWorkspace === undefined
      ? {}
      : { profileWorkspace: provider.profileWorkspace }),
    ...(managedProfile === undefined ? {} : { managedProfile }),
  };
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
        const profileEvidence = await readProfileEvidence(client, request, provider);
        return owned({
          ...identity,
          ...profileEvidence,
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
