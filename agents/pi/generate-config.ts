// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Generate the Pi model catalog from NemoClaw build-arg env vars.
//
// SECURITY: this file writes credential-free provider and model metadata.
// OpenShell supplies the selected route credential to the running agent. The
// upstream provider credential never enters the generated catalog.

import { nativeHostedAgentConfig } from "../../src/lib/inference/native-provider/agent-config.ts";
import {
  nativeLocalCredentialReference,
  NATIVE_LOCAL_AUTH_HEADER_SCRIPT,
} from "../../src/lib/inference/native-local/agent-config.ts";
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
} from "../../src/lib/inference/native-nvidia/contract.ts";

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const SUPPORTED_INFERENCE_API = "openai-completions";
const MANAGED_PROVIDER_ID = "openshell";
const MANAGED_PROVIDER_API_KEY = "nemoclaw-managed-inference";

type Settings = {
  nativeLocalCredentialHandle?: string;
  model: string;
  baseUrl: string;
  providerKey: string;
  upstreamProvider: string;
  inferenceApi: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
};

type ManagedPiConfig = {
  text: string;
  model: string;
  baseUrl: string;
  nativeLocal: boolean;
};

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeMetadata(value: string, name: string): string {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  const text = value.trim();
  if (!text) throw new Error(`${name} must not be empty.`);
  return text;
}

function normalizeInferenceApi(value: string | undefined): string {
  const text = normalizeMetadata(value || SUPPORTED_INFERENCE_API, "NEMOCLAW_INFERENCE_API");
  if (text !== SUPPORTED_INFERENCE_API) {
    throw new Error(`NEMOCLAW_INFERENCE_API must be ${SUPPORTED_INFERENCE_API} for Pi.`);
  }
  return text;
}

function normalizeInferenceBaseUrl(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must not contain line breaks.");
  }
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must not include credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must not include query strings or fragments.");
  }
  return text;
}

function normalizePositiveInteger(value: string | undefined, name: string): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function normalizeReasoning(value: string | undefined): boolean | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error('NEMOCLAW_REASONING must be "true" or "false".');
}

function readSettings(env: NodeJS.ProcessEnv): Settings {
  const providerKey = normalizeMetadata(
    env.NEMOCLAW_INFERENCE_PROVIDER_ID || env.NEMOCLAW_PROVIDER_KEY || "inference",
    "NEMOCLAW_INFERENCE_PROVIDER_ID",
  );
  return {
    nativeLocalCredentialHandle: env.NEMOCLAW_LOCAL_INFERENCE_TOKEN,
    model: normalizeMetadata(readRequiredEnv(env, "NEMOCLAW_MODEL"), "NEMOCLAW_MODEL"),
    baseUrl: normalizeInferenceBaseUrl(
      env.NEMOCLAW_INFERENCE_BASE_URL || "https://inference.local/v1",
    ),
    providerKey,
    upstreamProvider: normalizeMetadata(
      env.NEMOCLAW_UPSTREAM_PROVIDER || providerKey,
      "NEMOCLAW_UPSTREAM_PROVIDER",
    ),
    inferenceApi: normalizeInferenceApi(env.NEMOCLAW_INFERENCE_API),
    contextWindow: normalizePositiveInteger(env.NEMOCLAW_CONTEXT_WINDOW, "NEMOCLAW_CONTEXT_WINDOW"),
    maxTokens: normalizePositiveInteger(env.NEMOCLAW_MAX_TOKENS, "NEMOCLAW_MAX_TOKENS"),
    reasoning: normalizeReasoning(env.NEMOCLAW_REASONING),
  };
}

function buildModel(settings: Settings): Record<string, unknown> {
  const model: Record<string, unknown> = { id: settings.model };
  if (settings.contextWindow !== null) model.contextWindow = settings.contextWindow;
  if (settings.maxTokens !== null) model.maxTokens = settings.maxTokens;
  if (settings.reasoning !== null) model.reasoning = settings.reasoning;
  return model;
}

function buildConfig(settings: Settings): ManagedPiConfig {
  const nativeHosted = nativeHostedAgentConfig(settings.upstreamProvider, settings.baseUrl);
  const nativeLocal = nativeLocalCredentialReference(
    settings.upstreamProvider,
    settings.baseUrl,
    "pi",
    settings.nativeLocalCredentialHandle,
  );
  const credentialEnv =
    settings.baseUrl === NVIDIA_HOSTED_NATIVE_ENDPOINT
      ? NVIDIA_HOSTED_CREDENTIAL_ENV
      : nativeHosted?.credentialEnv;
  // Pi resolves command values when a fresh process requests credentials.
  const nativeKey = `!${NATIVE_LOCAL_AUTH_HEADER_SCRIPT}; printf '%s' "$NEMOCLAW_LOCAL_INFERENCE_TOKEN"`;
  const nativeAuthorization = `!${NATIVE_LOCAL_AUTH_HEADER_SCRIPT}; printf 'Bearer %s' "$NEMOCLAW_LOCAL_INFERENCE_TOKEN"`;
  const config = {
    $comment: `Generated by NemoClaw. This file contains no provider secrets. NemoClaw provider route: ${settings.providerKey}; upstream provider: ${settings.upstreamProvider}; API: ${settings.inferenceApi}.`,
    defaultModel: settings.model,
    providers: {
      [MANAGED_PROVIDER_ID]: {
        api: settings.inferenceApi,
        apiKey: nativeLocal
          ? nativeKey
          : credentialEnv
            ? `\${${credentialEnv}}`
            : MANAGED_PROVIDER_API_KEY,
        // A stored Pi key can override apiKey. Pin the native request header too.
        ...(nativeLocal
          ? { headers: { Authorization: nativeAuthorization } }
          : nativeHosted?.headers
            ? { headers: nativeHosted.headers }
            : {}),
        baseUrl: settings.baseUrl,
        models: [buildModel(settings)],
      },
    },
  };
  return {
    text: `${JSON.stringify(config, null, 2)}\n`,
    model: settings.model,
    baseUrl: settings.baseUrl,
    nativeLocal: nativeLocal !== null,
  };
}

function resolveFileDestination(filePath: string): string {
  let destination = filePath;
  for (;;) {
    try {
      return realpathSync.native(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let target: string;
    try {
      target = readlinkSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return join(realpathSync.native(dirname(destination)), basename(destination));
      }
      throw error;
    }
    // Keep .. intact until the filesystem resolves intervening directory links.
    destination = isAbsolute(target) ? target : `${dirname(destination)}/${target}`;
  }
}

function syncManagedDefaults(configDir: string, model: string, nativeLocal: boolean): void {
  const settingsPath = join(configDir, "settings.json");
  const defaults = { defaultProvider: MANAGED_PROVIDER_ID, defaultModel: model };
  let existing: Record<string, unknown>;
  try {
    const content = readFileSync(settingsPath, "utf8");
    const parsed: unknown = content.length === 0 ? {} : JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Pi settings.json must contain an object.");
    }
    existing = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Hosted startup did not previously create settings.json. Native-local
    // needs explicit defaults because Pi ignores defaultModel in models.json.
    if (!nativeLocal) return;
    existing = {};
  }
  const destination = resolveFileDestination(settingsPath);
  const stagedPath = join(dirname(destination), `.settings.json.${randomUUID()}.tmp`);
  let staged = false;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(stagedPath, "wx", 0o600);
    staged = true;
    writeFileSync(descriptor, `${JSON.stringify({ ...existing, ...defaults }, null, 2)}\n`);
    fchmodSync(descriptor, 0o600);
    const completedDescriptor = descriptor;
    descriptor = null;
    closeSync(completedDescriptor);
    renameSync(stagedPath, destination);
    staged = false;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (staged) {
      try {
        rmSync(stagedPath, { force: true });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `Pi settings staging failed; cleanup also failed for ${stagedPath}.`,
      );
    }
    throw error;
  }
}

function main(): void {
  const settings = readSettings(process.env);
  const configDir = join(homedir(), ".pi", "agent");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const configPath = join(configDir, "models.json");
  const config = buildConfig(settings);
  // Snapshot, write, and roll back the same target without removing a user's link.
  const configDestination = resolveFileDestination(configPath);
  let previousCatalog: Buffer | null;
  try {
    previousCatalog = readFileSync(configDestination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    previousCatalog = null;
  }
  try {
    writeFileSync(configDestination, config.text, { mode: 0o600 });
    chmodSync(configDestination, 0o600);
    syncManagedDefaults(configDir, config.model, config.nativeLocal);
  } catch (error) {
    try {
      if (previousCatalog === null) {
        rmSync(configDestination, { force: true });
      } else {
        writeFileSync(configDestination, previousCatalog, { mode: 0o600 });
        chmodSync(configDestination, 0o600);
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Pi catalog rollback failed.");
    }
    throw error;
  }

  console.log(`[config] Wrote ${configPath} (model=${config.model}, base_url=${config.baseUrl})`);
}

main();
