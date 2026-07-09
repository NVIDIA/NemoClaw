// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for credential-shaped name detection. Both the curl
// argv/URL validator (curl-args.ts) and the curl probe environment scrubber
// (probe.ts) consult this so a regression in one place cannot diverge from the
// other. Covers common credential stem words and compound credential names so
// separator-free provider parameters such as `clientSecret`, browser/session
// material such as cookies, and connection strings cannot slip past the
// validator. The standalone local credential helper and browser form embed this
// literal pattern; scripts/checks/local-credential-helper-pin.ts enforces exact
// parity because those reviewed artifacts cannot import this module at runtime.
export const CREDENTIAL_SHAPED_NAME_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|refresh[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key|pass[_-]?code|personal[_-]?access[_-]?token|connection[_-]?string|webhook(?:[_-]?url)?|key|secret|token|password|passwd|passcode|auth|authorization|credential|credentials|bearer|bearer[_-]?token|cookie|cookies|pat|private|privatekey|pin|webhookurl|dsn|connectionstring)(?:$|[_-])/i;

export function isCredentialShapedName(name: string): boolean {
  return CREDENTIAL_SHAPED_NAME_PATTERN.test(name);
}

// Supported provider/runtime credential env var names. Keep this shared
// inventory explicit even when a name also matches the generic shape below:
// callers that enforce no-leak boundaries can table-test every supported name
// instead of maintaining their own partial assignment regexes.
export const SUPPORTED_CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set([
  "NGC_API_KEY",
  "NEMOCLAW_PROVIDER_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "NOUS_API_KEY",
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HUGGINGFACE_API_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
  "NEMOCLAW_OLLAMA_PROXY_TOKEN",
  "NEMOCLAW_VLLM_LOCAL_TOKEN",
]);

// Backwards-compatible name retained for existing scrubber consumers.
export const CREDENTIAL_ENV_EXPLICIT_DENY = SUPPORTED_CREDENTIAL_ENV_NAMES;

export function shouldStripCredentialEnv(name: string): boolean {
  if (SUPPORTED_CREDENTIAL_ENV_NAMES.has(name)) return true;
  return CREDENTIAL_SHAPED_NAME_PATTERN.test(name);
}

// Drops credential-shaped variables from a single environment map without
// pulling in anything else. Benign replacement values such as PATH, proxy
// variables, and NO_PROXY are not credential-shaped, so they survive.
export function scrubCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !shouldStripCredentialEnv(name)) {
      scrubbed[name] = value;
    }
  }
  return scrubbed;
}

// Builds an environment for a curl probe child that inherits process.env plus
// an optional overlay, dropping credential-shaped variables. Defence-in-depth
// so a future provider env var that follows the convention is automatically
// scrubbed without an allowlist update.
export function buildScrubbedCurlProbeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return scrubCredentialEnv({ ...process.env, ...extra });
}
