// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Legacy credential env aliases.
//
// A pre-gateway `~/.nemoclaw/credentials.json` can name a credential under an
// older env key than the one the gateway registers today. Credential
// resolution accepts the alias, so migration accounting has to recognize the
// same relationship or a value that did reach the gateway looks unmigrated
// (#10373). The table lives here, outside the credential store, so both the
// store and onboarding provider registration can read it.

const LEGACY_CREDENTIAL_ENV_ALIASES: Partial<Record<string, readonly string[]>> = {
  NVIDIA_INFERENCE_API_KEY: ["NVIDIA_API_KEY"],
};

/** Legacy env keys whose stored value can satisfy `envName`. */
export function legacyCredentialAliases(envName: string): readonly string[] {
  return LEGACY_CREDENTIAL_ENV_ALIASES[envName] ?? [];
}
