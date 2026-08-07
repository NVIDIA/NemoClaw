// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";

const DEFAULT_RELATIVE_OBJECT_KEY = "secrets/nvcf-llm.b64";
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_MODEL_ID_LENGTH = 512;
const MIN_CREDENTIAL_LENGTH = 16;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const OPENAI_ENDPOINT_SUFFIXES = ["/responses", "/chat/completions", "/completions", "/models"];

export interface PortableInferenceSource {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class PortableInferenceSourceError extends Error {
  override readonly name = "PortableInferenceSourceError";
}

export type PortableInferenceObjectReader = (uri: string, env: NodeJS.ProcessEnv) => Buffer;

function configurationValue(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? "").trim();
}

function resolveObjectUri(env: NodeJS.ProcessEnv): string | null {
  const bucket = configurationValue(env, "S3_BUCKET");
  const configuredKey = configurationValue(env, "S3_KEY");
  const configuredPrefix = configurationValue(env, "S3_PREFIX");
  if (!bucket && !configuredKey && !configuredPrefix) return null;
  if (!bucket || (!configuredKey && !configuredPrefix)) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference requires S3_BUCKET and exactly one of S3_KEY or S3_PREFIX.",
    );
  }
  if (configuredKey && configuredPrefix) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference accepts S3_KEY or S3_PREFIX, not both.",
    );
  }
  if (
    bucket.length > 255 ||
    /[\s/\\\u0000-\u001f\u007f]/.test(bucket) ||
    !/^[A-Za-z0-9]/.test(bucket)
  ) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received an invalid S3_BUCKET.",
    );
  }
  const normalizedPrefix = configuredPrefix.replace(/^\/+|\/+$/g, "");
  if (configuredPrefix && !normalizedPrefix) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received an invalid S3_PREFIX.",
    );
  }
  const key = configuredKey
    ? configuredKey.replace(/^\/+/, "")
    : `${normalizedPrefix}/${DEFAULT_RELATIVE_OBJECT_KEY}`;
  if (!key || key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received an invalid object key.",
    );
  }
  return `s3://${bucket}/${key}`;
}

function readObjectWithAwsCli(uri: string, env: NodeJS.ProcessEnv): Buffer {
  const result = spawnSync("aws", ["s3", "cp", uri, "-", "--only-show-errors"], {
    env,
    maxBuffer: MAX_DESCRIPTOR_BYTES + 1,
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new PortableInferenceSourceError(
      result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Portable hosted inference requires the AWS CLI on PATH."
        : "Portable hosted inference could not read its credential descriptor.",
    );
  }
  if (result.stdout.length === 0 || result.stdout.length > MAX_DESCRIPTOR_BYTES) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received an empty or oversized descriptor.",
    );
  }
  return result.stdout;
}

function decodeBase64Json(raw: Buffer): Record<string, unknown> {
  let encoded: string;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/\s/g, "");
  } catch {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received a descriptor that is not UTF-8.",
    );
  }
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received an invalid base64 descriptor.",
    );
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received an invalid base64 descriptor.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received a descriptor that is not valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference requires a JSON object descriptor.",
    );
  }
  return parsed as Record<string, unknown>;
}

function aliasedString(
  payload: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): string {
  const values = fields.flatMap((field) => {
    const value = payload[field];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
  if (new Set(values).size > 1) {
    throw new PortableInferenceSourceError(
      `Portable hosted inference descriptor has conflicting ${label} fields.`,
    );
  }
  return values[0] ?? "";
}

function canonicalHostedEndpoint(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > MAX_ENDPOINT_LENGTH) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    let pathname = parsed.pathname.replace(/\/+$/, "");
    for (const suffix of OPENAI_ENDPOINT_SUFFIXES) {
      if (pathname === suffix || pathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length).replace(/\/+$/, "");
        break;
      }
    }
    parsed.pathname = pathname || "/";
    return parsed.pathname === "/" ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function parsePortableInferenceDescriptor(raw: Buffer): PortableInferenceSource {
  const payload = decodeBase64Json(raw);
  const apiKey = aliasedString(payload, ["apiKey", "api_key", "key", "token"], "credential");
  if (
    apiKey.length < MIN_CREDENTIAL_LENGTH ||
    apiKey.length > 8192 ||
    !/^[\u0021-\u007e]+$/.test(apiKey)
  ) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference descriptor has no usable credential.",
    );
  }

  const rawBaseUrl = aliasedString(payload, ["url", "baseUrl", "base_url"], "URL");
  const baseUrl = canonicalHostedEndpoint(rawBaseUrl);
  if (!baseUrl) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference descriptor requires a credential-free HTTPS URL.",
    );
  }

  const model = aliasedString(payload, ["model", "defaultModel", "default_model"], "model ID");
  if (!model || model.length > MAX_MODEL_ID_LENGTH || !SAFE_MODEL_ID_PATTERN.test(model)) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference descriptor has no usable model ID.",
    );
  }
  return { apiKey, baseUrl, model };
}

export function resolvePortableInferenceSource(
  env: NodeJS.ProcessEnv,
  readObject: PortableInferenceObjectReader = readObjectWithAwsCli,
): PortableInferenceSource | null {
  const uri = resolveObjectUri(env);
  if (!uri) return null;
  let raw: Buffer;
  try {
    raw = readObject(uri, env);
  } catch (error) {
    if (error instanceof PortableInferenceSourceError) throw error;
    throw new PortableInferenceSourceError(
      "Portable hosted inference could not read its credential descriptor.",
    );
  }
  return parsePortableInferenceDescriptor(raw);
}
