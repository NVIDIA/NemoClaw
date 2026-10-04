// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { isErrnoException } from "../../core/errno";
import { parseTrustedPrivateInferenceHostsFromEnv } from "../../inference/endpoint-ssrf-preflight";
import {
  assertEndpointResolvesPublic,
  type EndpointDnsLookupFn,
} from "../../security/trusted-private-endpoint";

export const PORTABLE_INFERENCE_DESCRIPTOR_PATH = "/run/nemoclaw/portable-inference.json";
export const PORTABLE_INFERENCE_CREDENTIAL_ENV = "COMPATIBLE_API_KEY";

const DESCRIPTOR_SCHEMA_VERSION = 1;
const DESCRIPTOR_MAX_BYTES = 64 * 1024;
const API_KEY_MAX_LENGTH = 16 * 1024;
const MODEL_MAX_LENGTH = 512;
const ENDPOINT_MAX_LENGTH = 2048;
const DESCRIPTOR_KEYS = ["apiKey", "baseUrl", "expiresAt", "model", "schemaVersion"].sort();
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface PortableInferenceDescriptor {
  readonly schemaVersion: 1;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly expiresAt: string;
}

export type PortableInferenceActivation = Omit<PortableInferenceDescriptor, "apiKey">;

export class PortableInferenceDescriptorError extends Error {
  readonly code = "EPORTABLEINFERENCEDESCRIPTOR";

  constructor(message: string) {
    super(message);
    this.name = "PortableInferenceDescriptorError";
  }
}

interface LoadPortableInferenceDescriptorOptions {
  readonly filePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly currentUid?: () => number;
  readonly resolveEndpointHost?: EndpointDnsLookupFn;
}

function descriptorError(message: string): PortableInferenceDescriptorError {
  return new PortableInferenceDescriptorError(`Runtime inference descriptor ${message}`);
}

function parseIsoUtcTimestamp(value: string): number | null {
  if (!ISO_UTC_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;

  const withoutZulu = value.slice(0, -1);
  const [wholeSeconds, fraction = ""] = withoutZulu.split(".");
  const canonical = `${wholeSeconds}.${fraction.padEnd(3, "0")}Z`;
  return new Date(parsed).toISOString() === canonical ? parsed : null;
}

function currentEffectiveUid(): number {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) {
    throw descriptorError("cannot verify the current user on this platform.");
  }
  return uid;
}

function assertDescriptorDirectory(filePath: string, uid: number): void {
  const directoryPath = path.dirname(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch {
    throw descriptorError(`cannot inspect its directory at ${directoryPath}.`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw descriptorError(`directory ${directoryPath} must be a real directory.`);
  }
  if (stat.uid !== 0 && stat.uid !== uid) {
    throw descriptorError(`directory ${directoryPath} must be owned by root or the current user.`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw descriptorError(`directory ${directoryPath} must not be writable by group or others.`);
  }
}

function openDescriptor(filePath: string): number | null {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const nonBlocking = fs.constants.O_NONBLOCK ?? 0;
  const closeOnExec =
    (fs.constants as typeof fs.constants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
  try {
    return fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking | closeOnExec);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    const code = isErrnoException(error) && error.code ? ` (${error.code})` : "";
    throw descriptorError(`cannot open ${filePath} without following links or blocking${code}.`);
  }
}

function assertDescriptorMetadata(filePath: string, stat: fs.Stats, uid: number): void {
  if (!stat.isFile()) throw descriptorError(`${filePath} must be a regular file.`);
  if (stat.uid !== uid) throw descriptorError(`${filePath} must be owned by the current user.`);
  if ((stat.mode & 0o777) !== 0o600) {
    throw descriptorError(`${filePath} must have mode 0600.`);
  }
  if (stat.nlink !== 1) throw descriptorError(`${filePath} must have exactly one hard link.`);
}

function readDescriptorBytes(fd: number): Buffer {
  const buffer = Buffer.alloc(DESCRIPTOR_MAX_BYTES + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > DESCRIPTOR_MAX_BYTES) {
      throw descriptorError(`exceeds the ${String(DESCRIPTOR_MAX_BYTES)}-byte limit.`);
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    buffer.fill(0);
    throw error;
  }
}

function consumeOpenedDescriptor(filePath: string, opened: fs.Stats): void {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw descriptorError(`cannot verify ${filePath} before consuming it.`);
  }
  if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
    throw descriptorError(`${filePath} changed while it was being consumed.`);
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    throw descriptorError(`cannot remove ${filePath} after reading it.`);
  }
}

function readAndConsumeDescriptor(filePath: string, currentUid: () => number): Buffer | null {
  let present: fs.Stats;
  try {
    present = fs.lstatSync(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw descriptorError(`cannot inspect ${filePath}.`);
  }
  const uid = currentUid();
  assertDescriptorDirectory(filePath, uid);
  if (present.isSymbolicLink()) {
    throw descriptorError(`${filePath} must not be a symbolic link.`);
  }
  assertDescriptorMetadata(filePath, present, uid);
  const fd = openDescriptor(filePath);
  if (fd === null) return null;

  let opened: fs.Stats;
  let bytes: Buffer | null = null;
  let readError: unknown;
  try {
    opened = fs.fstatSync(fd);
    assertDescriptorMetadata(filePath, opened, uid);
    try {
      bytes = readDescriptorBytes(fd);
    } catch (error) {
      readError = error;
    }
  } finally {
    fs.closeSync(fd);
  }

  consumeOpenedDescriptor(filePath, opened!);
  if (readError) throw readError;
  return bytes!;
}

function parseDescriptor(bytes: Buffer): PortableInferenceDescriptor {
  let parsed: unknown;
  try {
    const raw = utf8Decoder.decode(bytes);
    parsed = JSON.parse(raw);
  } catch {
    throw descriptorError("must contain valid UTF-8 JSON.");
  } finally {
    bytes.fill(0);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw descriptorError("must contain one JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== DESCRIPTOR_KEYS.length ||
    keys.some((key, index) => key !== DESCRIPTOR_KEYS[index])
  ) {
    throw descriptorError(`must contain exactly these fields: ${DESCRIPTOR_KEYS.join(", ")}.`);
  }
  if (record.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) {
    throw descriptorError(`schemaVersion must be ${String(DESCRIPTOR_SCHEMA_VERSION)}.`);
  }
  if (typeof record.apiKey !== "string" || record.apiKey.length === 0) {
    throw descriptorError("apiKey must be a non-empty string.");
  }
  if (
    record.apiKey.length > API_KEY_MAX_LENGTH ||
    record.apiKey !== record.apiKey.trim() ||
    /[\u0000\r\n]/u.test(record.apiKey)
  ) {
    throw descriptorError("apiKey has an invalid length or format.");
  }
  if (
    typeof record.model !== "string" ||
    record.model.length === 0 ||
    record.model.length > MODEL_MAX_LENGTH ||
    record.model !== record.model.trim() ||
    /[\u0000-\u001f\u007f]/u.test(record.model)
  ) {
    throw descriptorError("model has an invalid length or format.");
  }
  if (typeof record.baseUrl !== "string" || record.baseUrl !== record.baseUrl.trim()) {
    throw descriptorError("baseUrl must be a non-empty HTTP(S) URL.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(record.baseUrl);
  } catch {
    throw descriptorError("baseUrl must be a non-empty HTTP(S) URL.");
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.search || parsedUrl.hash) {
    throw descriptorError("baseUrl must use HTTPS and must not contain a query or fragment.");
  }
  if (parsedUrl.username || parsedUrl.password || record.baseUrl.length > ENDPOINT_MAX_LENGTH) {
    throw descriptorError(
      "baseUrl must not contain credentials or exceed the 2048-character limit.",
    );
  }
  const endpointSuffixes = ["/responses", "/chat/completions", "/completions", "/models"];
  let pathname = parsedUrl.pathname.replace(/\/+$/, "");
  for (const suffix of endpointSuffixes) {
    if (pathname === suffix) {
      pathname = "";
      break;
    }
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length);
      break;
    }
  }
  pathname = pathname.replace(/\/+$/, "");
  parsedUrl.pathname = pathname || "/";
  const baseUrl =
    parsedUrl.pathname === "/" ? parsedUrl.origin : `${parsedUrl.origin}${parsedUrl.pathname}`;

  if (typeof record.expiresAt !== "string") {
    throw descriptorError("expiresAt must be an ISO 8601 UTC timestamp.");
  }
  const expiresAt = parseIsoUtcTimestamp(record.expiresAt);
  if (expiresAt === null) {
    throw descriptorError("expiresAt must be an ISO 8601 UTC timestamp.");
  }

  return {
    schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
    apiKey: record.apiKey,
    baseUrl,
    model: record.model,
    expiresAt: record.expiresAt,
  };
}

export async function loadPortableInferenceDescriptor(
  options: LoadPortableInferenceDescriptorOptions = {},
): Promise<PortableInferenceDescriptor | null> {
  const filePath = options.filePath ?? PORTABLE_INFERENCE_DESCRIPTOR_PATH;
  const bytes = readAndConsumeDescriptor(filePath, options.currentUid ?? currentEffectiveUid);
  if (bytes === null) return null;

  const descriptor = parseDescriptor(bytes);
  if (Date.parse(descriptor.expiresAt) <= (options.now ?? Date.now)()) {
    throw descriptorError("has expired.");
  }

  const env = options.env ?? process.env;
  const preflight = await assertEndpointResolvesPublic(
    descriptor.baseUrl,
    options.resolveEndpointHost,
    { trustedPrivateHosts: parseTrustedPrivateInferenceHostsFromEnv(env) },
  );
  if (!preflight.ok) {
    throw descriptorError(`baseUrl failed endpoint policy: ${preflight.reason ?? "rejected"}.`);
  }
  return descriptor;
}
