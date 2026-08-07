// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export const PORTABLE_INFERENCE_BOOTSTRAP_PATH = "/run/nemoclaw/portable-bootstrap";
export const PORTABLE_INFERENCE_DESKTOP_FILENAME = "infrakey.txt";

const PORTABLE_INFERENCE_S3_REGION = "us-east-2";
const PORTABLE_INFERENCE_S3_BUCKET = "gfn-ld-ai-poc-355178295565-us-east-2-an";
const PORTABLE_INFERENCE_S3_KEY = "GFNClawV2/secrets/nvcf-llm.b64";
const MAX_BOOTSTRAP_BYTES = 256;
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

export interface PortableBootstrapCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

export type PortableInferenceBootstrapReader = () => Buffer | null;
export type PortableInferenceObjectReader = (credential: PortableBootstrapCredential) => Buffer;

function readBootstrapCandidate(filePath: string, repairOwnerPermissions: boolean): Buffer | null {
  let bootstrapFd: number;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    bootstrapFd = openSync(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PortableInferenceSourceError(
      "Portable hosted inference could not read its bootstrap credential.",
    );
  }

  try {
    let stats = fstatSync(bootstrapFd);
    const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : null;
    if (!stats.isFile() || (effectiveUid !== null && stats.uid !== effectiveUid)) {
      throw new PortableInferenceSourceError(
        "Portable hosted inference requires its bootstrap credential to be a regular file owned by the current user.",
      );
    }
    if (repairOwnerPermissions) {
      fchmodSync(bootstrapFd, 0o600);
      stats = fstatSync(bootstrapFd);
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new PortableInferenceSourceError(
        "Portable hosted inference requires its bootstrap credential to have mode 0600.",
      );
    }

    const buffer = Buffer.allocUnsafe(MAX_BOOTSTRAP_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(bootstrapFd, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0 || offset > MAX_BOOTSTRAP_BYTES) {
      throw new PortableInferenceSourceError(
        "Portable hosted inference received an empty or oversized bootstrap credential.",
      );
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof PortableInferenceSourceError) throw error;
    throw new PortableInferenceSourceError(
      "Portable hosted inference could not read its bootstrap credential.",
    );
  } finally {
    closeSync(bootstrapFd);
  }
}

export function readPortableInferenceBootstrapFile(filePath?: string): Buffer | null {
  if (filePath) return readBootstrapCandidate(filePath, false);

  const runtimeBootstrap = readBootstrapCandidate(PORTABLE_INFERENCE_BOOTSTRAP_PATH, false);
  if (runtimeBootstrap) return runtimeBootstrap;

  const homeDirectory = process.env.HOME;
  if (!homeDirectory || !path.isAbsolute(homeDirectory)) return null;
  return readBootstrapCandidate(
    path.join(homeDirectory, "Desktop", PORTABLE_INFERENCE_DESKTOP_FILENAME),
    true,
  );
}

function parsePortableBootstrapCredential(raw: Buffer): PortableBootstrapCredential {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim();
  } catch {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received an invalid bootstrap credential.",
    );
  }
  const tokens = value.split(/\s+/);
  const colonSeparated = tokens.length === 1 ? tokens[0].split(":") : [];
  const [accessKeyId = "", secretAccessKey = ""] = tokens.length === 2 ? tokens : colonSeparated;
  if (
    (tokens.length !== 2 && colonSeparated.length !== 2) ||
    !/^[A-Z0-9]{16,128}$/.test(accessKeyId) ||
    !/^[A-Za-z0-9/+=]{32,128}$/.test(secretAccessKey)
  ) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference received an invalid bootstrap credential.",
    );
  }
  return { accessKeyId, secretAccessKey };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string, encoding?: "hex"): Buffer | string {
  const digest = createHmac("sha256", key).update(value);
  return encoding === "hex" ? digest.digest("hex") : digest.digest();
}

export function readPortableInferenceDescriptorFromS3(
  credential: PortableBootstrapCredential,
  runCurl: typeof spawnSync = spawnSync,
  now = new Date(),
): Buffer {
  const host = `${PORTABLE_INFERENCE_S3_BUCKET}.s3.${PORTABLE_INFERENCE_S3_REGION}.amazonaws.com`;
  const canonicalPath = `/${PORTABLE_INFERENCE_S3_KEY.split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
  const requestUrl = `https://${host}${canonicalPath}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256("");
  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `GET\n${canonicalPath}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${PORTABLE_INFERENCE_S3_REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac(`AWS4${credential.secretAccessKey}`, dateStamp) as Buffer;
  const regionKey = hmac(dateKey, PORTABLE_INFERENCE_S3_REGION) as Buffer;
  const serviceKey = hmac(regionKey, "s3") as Buffer;
  const signingKey = hmac(serviceKey, "aws4_request") as Buffer;
  const signature = hmac(signingKey, stringToSign, "hex") as string;
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const curlConfig = [
    "silent",
    "show-error",
    "fail",
    'proto = "=https"',
    'request = "GET"',
    'max-time = "10"',
    `max-filesize = "${MAX_DESCRIPTOR_BYTES}"`,
    `url = "${requestUrl}"`,
    `header = "Authorization: ${authorization}"`,
    `header = "x-amz-content-sha256: ${payloadHash}"`,
    `header = "x-amz-date: ${amzDate}"`,
    "",
  ].join("\n");
  const result = runCurl("curl", ["--config", "-"], {
    input: curlConfig,
    maxBuffer: MAX_DESCRIPTOR_BYTES + 1,
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference could not read its credential descriptor.",
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
  _env: NodeJS.ProcessEnv,
  readBootstrapCredential: PortableInferenceBootstrapReader = readPortableInferenceBootstrapFile,
  readObject: PortableInferenceObjectReader = readPortableInferenceDescriptorFromS3,
): PortableInferenceSource | null {
  let rawBootstrap: Buffer | null;
  try {
    rawBootstrap = readBootstrapCredential();
  } catch (error) {
    if (error instanceof PortableInferenceSourceError) throw error;
    throw new PortableInferenceSourceError(
      "Portable hosted inference could not read its bootstrap credential.",
    );
  }
  if (rawBootstrap === null) return null;

  let credential: PortableBootstrapCredential;
  try {
    credential = parsePortableBootstrapCredential(rawBootstrap);
  } finally {
    rawBootstrap.fill(0);
  }
  let descriptor: Buffer;
  try {
    descriptor = readObject(credential);
  } catch (error) {
    if (error instanceof PortableInferenceSourceError) throw error;
    throw new PortableInferenceSourceError(
      "Portable hosted inference could not read its credential descriptor.",
    );
  }
  let source: PortableInferenceSource;
  try {
    source = parsePortableInferenceDescriptor(descriptor);
  } finally {
    descriptor.fill(0);
  }
  return source;
}
