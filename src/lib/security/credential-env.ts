// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for credential-shaped name detection. Both the curl
// argv/URL validator (curl-args.ts) and the curl probe environment scrubber
// (probe.ts) consult this so a regression in one place cannot diverge from the
// other. Covers common credential stem words (key, secret, token, password,
// auth, credential) appearing as the exact name, joined to another word with
// `_`/`-`, or in the `api`/`apikey` no-separator form.
export const CREDENTIAL_SHAPED_NAME_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|key|secret|token|password|passwd|auth|credential|credentials)(?:$|[_-])/i;

export function isCredentialShapedName(name: string): boolean {
  return CREDENTIAL_SHAPED_NAME_PATTERN.test(name);
}

// Known provider credential env var names that do not match the generic
// credential-shaped pattern. Drop these explicitly so a regression in the
// pattern cannot leak a provider key into a curl child's environment.
export const CREDENTIAL_ENV_EXPLICIT_DENY: ReadonlySet<string> = new Set([
  "NGC_API_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "TAVILY_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HUGGINGFACE_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

export function shouldStripCredentialEnv(name: string): boolean {
  if (CREDENTIAL_ENV_EXPLICIT_DENY.has(name)) return true;
  return CREDENTIAL_SHAPED_NAME_PATTERN.test(name);
}

// Builds an environment for a curl probe child that drops credential-shaped
// variables. Defence-in-depth so a future provider env var that follows the
// convention is automatically scrubbed without an allowlist update.
export function buildScrubbedCurlProbeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const source of [process.env, extra]) {
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined && !shouldStripCredentialEnv(name)) {
        scrubbed[name] = value;
      }
    }
  }
  return scrubbed;
}
