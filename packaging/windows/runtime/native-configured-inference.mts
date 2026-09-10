// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ensureNativeInference } from "./native-inference.mts";
import type { ProgressSink } from "./native-inference-manifest.mts";
import { readWindowsCredential, type NativeCredentialIdentity } from "./native-security.mts";

type Configuration = Omit<NativeCredentialIdentity, "endpoint"> & {
  endpoint?: string;
  model: string;
  credentialStored: boolean;
  profile?: string;
  localModel?: string;
};

export async function resolveNativeConfiguredInference(
  installRoot: string,
  launcher: string,
  config: Configuration,
  options: { signal?: AbortSignal; onProgress?: ProgressSink } = {},
) {
  options.signal?.throwIfAborted();
  if (config.profile !== undefined && config.profile !== "personal")
    throw new Error("The installed native configuration has an unsupported profile.");
  if (config.localModel !== undefined) {
    if (
      config.localModel !== "n1x-qwen3.6-35b-a3b" ||
      config.inference !== "local" ||
      config.credentialStored
    )
      throw new Error("The managed local inference selection is invalid.");
    const owned = await ensureNativeInference({
      installRoot,
      signal: options.signal,
      onProgress: options.onProgress ?? ((event) => console.log(event.message)),
    });
    if (owned.localModel !== config.localModel)
      throw new Error("The running local model does not match the installed selection.");
    // The supervisor supplies both endpoint and token as one verified identity.
    // A custom endpoint is never paired with this shared host credential.
    return {
      configuration: { ...config, endpoint: owned.endpoint, model: owned.model },
      credential: owned.credential,
    };
  }
  if (typeof config.endpoint !== "string")
    throw new Error("The configured inference endpoint is missing.");
  const resolved = { ...config, endpoint: config.endpoint };
  return {
    configuration: resolved,
    credential: await readWindowsCredential(launcher, resolved, config.credentialStored),
  };
}
