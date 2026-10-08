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
  ManagedTavilyProfileResponseSchema,
  ManagedHermesTavilyProfileResponseSchema,
  ManagedOpenAiProfileResponseSchema,
  BuiltinNvidiaProfileResponseSchema,
  ProviderResponseSchema,
} from "./sdk-read-schema";
import { isManagedNativeNvidiaProfileResponse } from "./native-nvidia-profile-response";

import { BUILD_ENDPOINT_URL } from "../../inference/provider-models";
import {
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
} from "../../inference/native-nvidia/contract";

import type { OpenShellProviderMetadata } from "./provider-adapter";

const managedProfileSchemas = {
  brave: ManagedBraveProfileResponseSchema,
  openai: ManagedOpenAiProfileResponseSchema,
  tavily: ManagedTavilyProfileResponseSchema,
  "tavily-hermes-v1": ManagedHermesTavilyProfileResponseSchema,
};
type ManagedProfileContract = keyof typeof managedProfileSchemas;
type ProfileContract = ManagedProfileContract | "native-nvidia";

export type Provider = Readonly<
  Pick<OpenShellProviderMetadata, "name" | "type" | "credentialKeys" | "configKeys"> & {
    id: string;
    workspace: string;
    resourceVersion: string;
    config: Readonly<Record<string, string>>;
    builtinInferenceEndpoint?: string;
    managedInferenceEndpoint?: string;
    profileWorkspace?: string;
    // null records a successful not-found read at the OpenAI provider's profile binding.
    managedProfile?: Readonly<{
      id: ManagedProfileContract | typeof NVIDIA_HOSTED_NATIVE_PROFILE_ID;
      source: "builtin" | "user";
      scope: "" | "platform" | "workspace";
      resourceVersion: string;
    }> | null;
  }
>;
export interface Providers {
  get(
    request: ReadRequest &
      Readonly<{
        name: string;
        configKeys: readonly string[];
        profileContract?: ProfileContract;
      }>,
  ): Promise<Provider | null>;
}

async function readBuiltinNvidiaEndpoint(
  client: OpenShellReadClient,
  request: ReadRequest,
  profileWorkspace: string,
): Promise<string> {
  request.signal.throwIfAborted();
  readValue(
    BuiltinNvidiaProfileResponseSchema,
    await client.raw.getProviderProfile(
      { id: "nvidia", workspace: profileWorkspace },
      { signal: request.signal },
    ),
  );
  return BUILD_ENDPOINT_URL;
}

async function readManagedProfile(
  client: OpenShellReadClient,
  request: ReadRequest,
  profileContract: ProfileContract,
  providerType: string,
  profileWorkspace: string | undefined,
): Promise<NonNullable<Provider["managedProfile"]> | null> {
  const profileId =
    profileContract === "native-nvidia" ? NVIDIA_HOSTED_NATIVE_PROFILE_ID : profileContract;
  if (
    providerType !== profileId ||
    (profileWorkspace !== "" && profileWorkspace !== request.workspace)
  )
    throw new OpenShellReadError("schema");
  request.signal.throwIfAborted();
  let response: unknown;
  try {
    response = await client.raw.getProviderProfile(
      // Resolve the actual profile binding; the default-workspace import is managed state.
      { id: profileId, workspace: profileWorkspace },
      { signal: request.signal },
    );
  } catch (error) {
    // OpenShell 0.0.116 has an OpenAI provider type without a builtin profile.
    if (profileContract === "openai" && isNotFound(error)) return null;
    throw error;
  }
  return validateManagedProfileResponse(response, profileContract, profileWorkspace);
}

function validateNativeManagedProfileResponse(
  response: unknown,
  profileWorkspace: string,
): NonNullable<Provider["managedProfile"]> {
  if (!isManagedNativeNvidiaProfileResponse(response)) {
    throw new OpenShellReadError("schema");
  }
  const profile = response.profile;
  const expectedScope = profileWorkspace === "" ? "platform" : "workspace";
  if (profile.scope !== expectedScope) throw new OpenShellReadError("schema");
  return {
    id: profile.id,
    source: "user",
    scope: profile.scope,
    resourceVersion: String(profile.resourceVersion),
  };
}

function validateManagedProfileResponse(
  response: unknown,
  profileContract: ProfileContract,
  profileWorkspace: string,
): NonNullable<Provider["managedProfile"]> {
  if (profileContract === "native-nvidia") {
    return validateNativeManagedProfileResponse(response, profileWorkspace);
  }
  const { profile } = readValue(managedProfileSchemas[profileContract], response);
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

function managedInferenceEndpointFor(
  managedProfile: Provider["managedProfile"],
): string | undefined {
  return managedProfile?.id === NVIDIA_HOSTED_NATIVE_PROFILE_ID
    ? NVIDIA_HOSTED_NATIVE_ENDPOINT
    : undefined;
}

async function readProfileEvidence(
  client: OpenShellReadClient,
  request: Parameters<Providers["get"]>[0],
  provider: Readonly<{ type: string; profileWorkspace?: string; config: Record<string, unknown> }>,
): Promise<
  Pick<
    Provider,
    "builtinInferenceEndpoint" | "managedInferenceEndpoint" | "profileWorkspace" | "managedProfile"
  >
> {
  let builtinInferenceEndpoint: string | undefined;
  if (
    provider.type === "nvidia" &&
    (provider.profileWorkspace === "" || provider.profileWorkspace === request.workspace) &&
    Object.keys(provider.config).length === 0
  ) {
    builtinInferenceEndpoint = await readBuiltinNvidiaEndpoint(
      client,
      request,
      provider.profileWorkspace,
    );
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
  const managedInferenceEndpoint = managedInferenceEndpointFor(managedProfile);
  return {
    ...(builtinInferenceEndpoint === undefined ? {} : { builtinInferenceEndpoint }),
    ...(provider.profileWorkspace === undefined
      ? {}
      : { profileWorkspace: provider.profileWorkspace }),
    ...(managedProfile === undefined ? {} : { managedProfile }),
    ...(managedInferenceEndpoint === undefined ? {} : { managedInferenceEndpoint }),
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
