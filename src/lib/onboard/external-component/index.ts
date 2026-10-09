// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";

function errnoCode(error: unknown): string | null {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : null;
}

export const EXTERNAL_COMPONENT_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_COMPONENT_DECLARATION_NAME = "external-component.json";
export const EXTERNAL_COMPONENT_ACTIVATION_TIMEOUT_MS = 30_000;
export const EXTERNAL_COMPONENT_MAX_RESPONSE_BYTES = 1_048_576;

const DECLARATION_MAX_BYTES = 16 * 1024;
const COMPONENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DECLARATION_FIELDS = new Set([
  "schemaVersion",
  "componentId",
  "interceptorSocketPath",
  "activationSocketPath",
]);

export type ExternalComponentContractErrorCode =
  | "declaration_ambiguous"
  | "declaration_duplicate_key"
  | "declaration_invalid"
  | "declaration_mode"
  | "declaration_owner"
  | "declaration_symlink"
  | "declaration_unknown_field"
  | "lifecycle_unsupported"
  | "platform_unsupported"
  | "schema_unsupported"
  | "endpoint_restricted"
  | "trust_invalid"
  | "trust_changed"
  | "preparation_failed"
  | "socket_ambiguous"
  | "socket_mode"
  | "socket_owner"
  | "socket_parent_unsafe"
  | "socket_type";

export class ExternalComponentContractError extends Error {
  readonly code: ExternalComponentContractErrorCode;

  constructor(code: ExternalComponentContractErrorCode) {
    super(`External component declaration rejected. Reason class: ${code}.`);
    this.name = "ExternalComponentContractError";
    this.code = code;
  }
}

export interface ExternalComponentDeclarationV1 {
  readonly schemaVersion: typeof EXTERNAL_COMPONENT_SCHEMA_VERSION;
  readonly componentId: string;
  readonly interceptorSocketPath: string;
  readonly activationSocketPath: string;
}

export interface ExternalComponentConnection {
  readonly endpoint: string;
  readonly caCertificatePath: string;
  readonly audience: string;
}

export interface ExternalComponentDeclarationV2 {
  readonly schemaVersion: 2;
  readonly componentId: string;
  readonly activationSocketPath: string;
  readonly interceptor: ExternalComponentConnection;
  readonly middleware: ExternalComponentConnection & { readonly name: string };
  readonly providerProfileSource?: string;
}

export type ExternalComponentDeclaration =
  | ExternalComponentDeclarationV1
  | ExternalComponentDeclarationV2;

export type ExternalComponentGatewayConfiguration =
  | Pick<ExternalComponentDeclarationV1, "componentId" | "interceptorSocketPath">
  | Omit<ExternalComponentDeclarationV2, "activationSocketPath">;

export function gatewayConfigurationForExternalComponent(
  declaration: ExternalComponentDeclaration,
): ExternalComponentGatewayConfiguration {
  if (declaration.schemaVersion === 1)
    return {
      componentId: declaration.componentId,
      interceptorSocketPath: declaration.interceptorSocketPath,
    };
  const { activationSocketPath: _socket, ...configuration } = declaration;
  return configuration;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly type: "directory" | "file" | "socket";
}

interface PathProof {
  readonly identity: FileIdentity;
  readonly path: string;
}

interface DeclarationProof extends PathProof {
  readonly bytes: Buffer;
  readonly parents: readonly PathProof[];
}

interface EndpointProof extends PathProof {
  readonly parents: readonly PathProof[];
}

export interface PreparedExternalComponent {
  readonly declaration: ExternalComponentDeclaration;
  setGatewayRevalidation?(revalidate: () => void): void;
  revalidateBeforeGateway(): void;
  revalidateBeforeActivation(): void;
}

interface LoadExternalComponentOptions {
  readonly declarationPath?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
}

class StrictJsonParser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.whitespace();
    if (this.position !== this.source.length) this.invalid();
    return value;
  }

  private value(): unknown {
    this.whitespace();
    const next = this.source[this.position];
    if (next === "{") return this.object();
    if (next === "[") return this.array();
    if (next === '"') return this.string();
    if (next === "t") return this.literal("true", true);
    if (next === "f") return this.literal("false", false);
    if (next === "n") return this.literal("null", null);
    return this.number();
  }

  private object(): Record<string, unknown> {
    this.position += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.whitespace();
    if (this.source[this.position] === "}") {
      this.position += 1;
      return result;
    }
    while (this.position < this.source.length) {
      this.whitespace();
      if (this.source[this.position] !== '"') this.invalid();
      const key = this.string();
      if (keys.has(key)) {
        throw new ExternalComponentContractError("declaration_duplicate_key");
      }
      keys.add(key);
      this.whitespace();
      if (this.source[this.position] !== ":") this.invalid();
      this.position += 1;
      result[key] = this.value();
      this.whitespace();
      const separator = this.source[this.position];
      this.position += 1;
      if (separator === "}") return result;
      if (separator !== ",") this.invalid();
    }
    return this.invalid();
  }

  private array(): unknown[] {
    this.position += 1;
    const result: unknown[] = [];
    this.whitespace();
    if (this.source[this.position] === "]") {
      this.position += 1;
      return result;
    }
    while (this.position < this.source.length) {
      result.push(this.value());
      this.whitespace();
      const separator = this.source[this.position];
      this.position += 1;
      if (separator === "]") return result;
      if (separator !== ",") this.invalid();
    }
    return this.invalid();
  }

  private string(): string {
    const start = this.position;
    this.position += 1;
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      if (character === '"') {
        this.position += 1;
        try {
          return JSON.parse(this.source.slice(start, this.position)) as string;
        } catch {
          return this.invalid();
        }
      }
      if (character === "\\") {
        this.position += 2;
        continue;
      }
      if (!character || character.charCodeAt(0) < 0x20) this.invalid();
      this.position += 1;
    }
    return this.invalid();
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.position),
    );
    if (!match) return this.invalid();
    this.position += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : this.invalid();
  }

  private literal<T>(token: string, value: T): T {
    if (!this.source.startsWith(token, this.position)) return this.invalid();
    this.position += token.length;
    return value;
  }

  private whitespace(): void {
    while (/\s/u.test(this.source[this.position] ?? "") && this.position < this.source.length) {
      const character = this.source[this.position];
      if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") {
        this.invalid();
      }
      this.position += 1;
    }
  }

  private invalid(): never {
    throw new ExternalComponentContractError("declaration_invalid");
  }
}

function fileType(stat: fs.Stats): FileIdentity["type"] | null {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSocket()) return "socket";
  return null;
}

function identity(stat: fs.Stats, expected: FileIdentity["type"]): FileIdentity {
  if (stat.isSymbolicLink() || fileType(stat) !== expected) {
    throw new ExternalComponentContractError(
      expected === "socket" ? "socket_type" : "declaration_ambiguous",
    );
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    type: expected,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.type === right.type
  );
}

function assertPathProof(proof: PathProof, code: ExternalComponentContractErrorCode): void {
  let current: FileIdentity;
  try {
    current = identity(fs.lstatSync(proof.path), proof.identity.type);
  } catch {
    throw new ExternalComponentContractError(code);
  }
  if (!sameIdentity(proof.identity, current)) throw new ExternalComponentContractError(code);
}

function declarationParents(homeDirectory: string, declarationPath: string): string[] {
  const home = path.resolve(homeDirectory);
  const parent = path.dirname(path.resolve(declarationPath));
  const relative = path.relative(home, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExternalComponentContractError("declaration_ambiguous");
  }
  const result = [home];
  let current = home;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    result.push(current);
  }
  return result;
}

function endpointParents(socketPath: string): string[] {
  const result: string[] = [];
  let current = path.dirname(socketPath);
  while (current !== path.dirname(current)) {
    result.push(current);
    current = path.dirname(current);
  }
  result.push(current);
  return result.reverse();
}

function captureSafeParents(
  paths: readonly string[],
  uid: number,
  declaration: boolean,
): PathProof[] {
  return paths.map((candidate) => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      throw new ExternalComponentContractError(
        declaration ? "declaration_ambiguous" : "socket_parent_unsafe",
      );
    }
    let captured: FileIdentity;
    try {
      captured = identity(stat, "directory");
    } catch {
      throw new ExternalComponentContractError(
        declaration ? "declaration_ambiguous" : "socket_parent_unsafe",
      );
    }
    const allowedOwner = declaration
      ? captured.uid === uid
      : captured.uid === uid || captured.uid === 0;
    if (!allowedOwner || (captured.mode & 0o022) !== 0) {
      throw new ExternalComponentContractError(
        declaration ? "declaration_ambiguous" : "socket_parent_unsafe",
      );
    }
    return { identity: captured, path: candidate };
  });
}

function captureDeclaration(
  declarationPath: string,
  homeDirectory: string,
  uid: number,
): DeclarationProof {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(declarationPath);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw new ExternalComponentContractError("declaration_symlink");
    }
    throw new ExternalComponentContractError("declaration_ambiguous");
  }
  if (pathStat.isSymbolicLink()) {
    throw new ExternalComponentContractError("declaration_symlink");
  }
  const captured = identity(pathStat, "file");
  if (captured.uid !== uid) throw new ExternalComponentContractError("declaration_owner");
  if (captured.mode !== 0o600) throw new ExternalComponentContractError("declaration_mode");
  const parents = captureSafeParents(declarationParents(homeDirectory, declarationPath), uid, true);
  let file: ReturnType<typeof openRegularFileNoFollow>;
  try {
    file = openRegularFileNoFollow(declarationPath);
  } catch {
    throw new ExternalComponentContractError("declaration_ambiguous");
  }
  try {
    const descriptorStat = file.stat();
    const descriptorIdentity = identity(descriptorStat, "file");
    if (!sameIdentity(captured, descriptorIdentity)) {
      throw new ExternalComponentContractError("declaration_ambiguous");
    }
    try {
      return {
        bytes: file.readBytes(DECLARATION_MAX_BYTES),
        identity: captured,
        parents,
        path: declarationPath,
      };
    } catch (error) {
      if (error instanceof ExternalComponentContractError) throw error;
      throw new ExternalComponentContractError("declaration_invalid");
    }
  } finally {
    file.close();
  }
}

function captureEndpoint(socketPath: string, uid: number): EndpointProof {
  const parents = captureSafeParents(endpointParents(socketPath), uid, false);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    throw new ExternalComponentContractError("socket_ambiguous");
  }
  const captured = identity(stat, "socket");
  if (captured.uid !== uid) throw new ExternalComponentContractError("socket_owner");
  if ((captured.mode & 0o077) !== 0 || (captured.mode & 0o600) !== 0o600) {
    throw new ExternalComponentContractError("socket_mode");
  }
  return { identity: captured, parents, path: socketPath };
}

function revalidateDeclaration(proof: DeclarationProof): void {
  for (const parent of proof.parents) assertPathProof(parent, "declaration_ambiguous");
  assertPathProof(proof, "declaration_ambiguous");
  let file: ReturnType<typeof openRegularFileNoFollow>;
  try {
    file = openRegularFileNoFollow(proof.path);
  } catch {
    throw new ExternalComponentContractError("declaration_ambiguous");
  }
  try {
    try {
      if (!sameIdentity(proof.identity, identity(file.stat(), "file"))) {
        throw new ExternalComponentContractError("declaration_ambiguous");
      }
      if (!file.readBytes(DECLARATION_MAX_BYTES).equals(proof.bytes)) {
        throw new ExternalComponentContractError("declaration_ambiguous");
      }
    } catch (error) {
      if (error instanceof ExternalComponentContractError) throw error;
      throw new ExternalComponentContractError("declaration_ambiguous");
    }
  } finally {
    file.close();
  }
}

function revalidateEndpoint(proof: EndpointProof): void {
  for (const parent of proof.parents) assertPathProof(parent, "socket_ambiguous");
  assertPathProof(proof, "socket_ambiguous");
}

function validatedSocketPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  return value;
}

export function parseStrictExternalComponentJson(source: string): unknown {
  return new StrictJsonParser(source).parse();
}

export function parseExternalComponentDeclaration(source: string): ExternalComponentDeclaration {
  const parsed = parseStrictExternalComponentJson(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion === 2) return parseConnectionDeclaration(record);
  if (Object.keys(record).some((field) => !DECLARATION_FIELDS.has(field))) {
    throw new ExternalComponentContractError("declaration_unknown_field");
  }
  if (record.schemaVersion !== EXTERNAL_COMPONENT_SCHEMA_VERSION) {
    throw new ExternalComponentContractError("schema_unsupported");
  }
  if (typeof record.componentId !== "string" || !COMPONENT_ID_PATTERN.test(record.componentId)) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  const interceptorSocketPath = validatedSocketPath(record.interceptorSocketPath);
  const activationSocketPath = validatedSocketPath(record.activationSocketPath);
  if (interceptorSocketPath === activationSocketPath) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  if (Object.keys(record).length !== DECLARATION_FIELDS.size) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  return {
    schemaVersion: EXTERNAL_COMPONENT_SCHEMA_VERSION,
    componentId: record.componentId,
    interceptorSocketPath,
    activationSocketPath,
  };
}

export function loadExternalComponentDeclaration(
  options: LoadExternalComponentOptions = {},
): PreparedExternalComponent | null {
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const declarationPath =
    options.declarationPath ??
    path.join(homeDirectory, ".config", "nemoclaw", EXTERNAL_COMPONENT_DECLARATION_NAME);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(declarationPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new ExternalComponentContractError("declaration_ambiguous");
  }
  if (stat.isSymbolicLink()) throw new ExternalComponentContractError("declaration_symlink");
  if ((options.platform ?? process.platform) !== "linux") {
    throw new ExternalComponentContractError("platform_unsupported");
  }
  const uid = options.uid ?? process.geteuid?.();
  if (uid === undefined) throw new ExternalComponentContractError("declaration_owner");
  const declarationProof = captureDeclaration(declarationPath, homeDirectory, uid);
  let source: string;
  try {
    source = UTF8_DECODER.decode(declarationProof.bytes);
  } catch {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  const declaration = parseExternalComponentDeclaration(source);
  const interceptorProof =
    declaration.schemaVersion === 1
      ? captureEndpoint(declaration.interceptorSocketPath, uid)
      : null;
  const trustProofs =
    declaration.schemaVersion === 2
      ? [declaration.interceptor, declaration.middleware].map((connection) =>
          captureExternalComponentTrust(connection.caCertificatePath, uid),
        )
      : [];
  const activationProof = captureEndpoint(declaration.activationSocketPath, uid);
  let revalidateGateway: (() => void) | undefined;
  const revalidate = (): void => {
    revalidateDeclaration(declarationProof);
    if (interceptorProof) revalidateEndpoint(interceptorProof);
    for (const proof of trustProofs) proof.revalidate();
    revalidateEndpoint(activationProof);
    revalidateGateway?.();
  };
  return {
    declaration,
    setGatewayRevalidation(revalidateGatewayProof) {
      if (revalidateGateway) throw new ExternalComponentContractError("preparation_failed");
      revalidateGateway = revalidateGatewayProof;
    },
    revalidateBeforeGateway: revalidate,
    revalidateBeforeActivation: revalidate,
  };
}

function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new ExternalComponentContractError("declaration_unknown_field");
  }
  if (required.some((key) => !Object.hasOwn(record, key))) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  return record;
}

function serviceName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value) ||
    value.startsWith("openshell/")
  )
    throw new ExternalComponentContractError("declaration_invalid");
  return value;
}

function connection(
  record: Record<string, unknown>,
  interceptor: boolean,
): ExternalComponentConnection {
  const endpoint = record.endpoint;
  const match =
    typeof endpoint === "string"
      ? /^https:\/\/(127\.0\.0\.1|host\.openshell\.internal):([1-9]\d{0,4})$/u.exec(endpoint)
      : null;
  const host = match?.[1] ?? "";
  if (
    !match ||
    Number(match[2]) > 65535 ||
    host !== (interceptor ? "127.0.0.1" : "host.openshell.internal")
  ) {
    throw new ExternalComponentContractError("endpoint_restricted");
  }
  if (
    typeof record.audience !== "string" ||
    record.audience.length > 256 ||
    !/^[\x21-\x7e]+$/u.test(record.audience)
  )
    throw new ExternalComponentContractError("declaration_invalid");
  return Object.freeze({
    endpoint: endpoint as string,
    caCertificatePath: validatedSocketPath(record.caCertificatePath),
    audience: record.audience,
  });
}

function parseConnectionDeclaration(value: unknown): ExternalComponentDeclarationV2 {
  const record = fields(
    value,
    ["schemaVersion", "componentId", "activationSocketPath", "interceptor", "middleware"],
    ["providerProfileSource"],
  );
  const interceptor = fields(record.interceptor, ["endpoint", "caCertificatePath", "audience"]);
  const middleware = fields(record.middleware, [
    "name",
    "endpoint",
    "caCertificatePath",
    "audience",
  ]);
  const componentId = serviceName(record.componentId);
  if (record.providerProfileSource !== undefined && record.providerProfileSource !== componentId) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  return Object.freeze({
    schemaVersion: 2,
    componentId,
    activationSocketPath: validatedSocketPath(record.activationSocketPath),
    interceptor: connection(interceptor, true),
    middleware: Object.freeze({
      ...connection(middleware, false),
      name: serviceName(middleware.name),
    }),
    ...(record.providerProfileSource === undefined ? {} : { providerProfileSource: componentId }),
  });
}

/** Certificate bytes stay public; private keys must never enter a supervisor's trust bundle. */
export function captureExternalComponentTrust(
  certificatePath: string,
  uid = process.geteuid?.(),
): {
  readonly sha256: string;
  revalidate(): void;
} {
  if (uid === undefined) throw new ExternalComponentContractError("trust_invalid");
  try {
    validatedSocketPath(certificatePath);
    const parents = captureSafeParents(endpointParents(certificatePath), uid, false);
    const stat = fs.lstatSync(certificatePath);
    const expected = identity(stat, "file");
    if ((stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0 || stat.nlink !== 1) {
      throw new Error("unsafe certificate file");
    }
    const file = openRegularFileNoFollow(certificatePath);
    let bytes: Buffer;
    try {
      if (!sameIdentity(expected, identity(file.stat(), "file")))
        throw new Error("changed certificate");
      bytes = file.readBytes(64 * 1024);
    } finally {
      file.close();
    }
    const pem = UTF8_DECODER.decode(bytes);
    const certificates =
      pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
    if (
      !certificates.length ||
      pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "").trim()
    ) {
      throw new Error("certificate-only PEM required");
    }
    for (const certificate of certificates) {
      const parsed = new X509Certificate(certificate);
      if (
        !parsed.ca ||
        Date.parse(parsed.validFrom) > Date.now() ||
        Date.parse(parsed.validTo) <= Date.now()
      ) {
        throw new Error("valid CA certificate required");
      }
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      sha256,
      revalidate() {
        try {
          for (const parent of parents) assertPathProof(parent, "trust_changed");
          assertPathProof({ path: certificatePath, identity: expected }, "trust_changed");
          if (captureExternalComponentTrust(certificatePath, uid).sha256 !== sha256)
            throw new Error("changed trust");
        } catch {
          throw new ExternalComponentContractError("trust_changed");
        }
      },
    };
  } catch {
    throw new ExternalComponentContractError("trust_invalid");
  }
}
