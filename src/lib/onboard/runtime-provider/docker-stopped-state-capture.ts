// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { write } from "node:fs";
import path from "node:path";
import { Transform, type TransformCallback, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import { dockerSpawn, dockerSpawnSync } from "../../adapters/docker/exec";
import { fingerprintOpenShellSandboxId } from "../../domain/sandbox/openshell-identity";
import { NATIVE_STATE_CAPTURE_TIMEOUT_MS } from "../../state/sandbox";
import type { SandboxEntry } from "../../state/registry/types";
import type {
  RuntimeProviderSnapshotRestoreSource,
  RuntimeProviderStoppedStateCapture,
  RuntimeProviderStoppedStateProjection,
} from "./contract";

const TAR_BLOCK_BYTES = 512;
const TAR_METADATA_MAX_BYTES = 1024 * 1024;
const INSPECT_FORMAT =
  "[{{json .Id}},{{json .State}},{{json .Config.Labels}},{{json .RestartCount}},{{json .Image}},{{json .Mounts}}]";

function rejectStoppedCapture(message: string): never {
  throw new Error(message);
}

function createArchiveWriteStream(archiveFd: number): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      const writeRemaining = (): void => {
        write(archiveFd, chunk, offset, chunk.byteLength - offset, (error, written) => {
          if (error) {
            callback(error);
            return;
          }
          if (written <= 0) {
            callback(new Error("short archive write"));
            return;
          }
          offset += written;
          if (offset === chunk.byteLength) callback();
          else writeRemaining();
        });
      };
      writeRemaining();
    },
  });
}

function tarString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function tarNumber(header: Buffer, start: number, length: number): number | null {
  const field = header.subarray(start, start + length);
  if ((field[0] ?? 0) & 0x80) {
    let value = BigInt((field[0] ?? 0) & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  const text = field.toString("ascii").replace(/\0.*$/su, "").trim();
  if (!/^[0-7]*$/u.test(text)) return null;
  const value = text.length === 0 ? 0 : Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tarChecksumIsValid(header: Buffer): boolean {
  const expected = tarNumber(header, 148, 8);
  if (expected === null) return false;
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return actual === expected;
}

function writeTarOctal(header: Buffer, start: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) rejectStoppedCapture("Stopped state archive metadata overflowed.");
  header.fill(0, start, start + length);
  header.write(encoded, start, length - 1, "ascii");
}

function writeTarText(header: Buffer, start: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length)
    rejectStoppedCapture("Stopped state archive path could not be represented.");
  header.fill(0, start, start + length);
  encoded.copy(header, start);
}

function splitUstarPath(value: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: "" };
  for (
    let separator = value.lastIndexOf("/");
    separator > 0;
    separator = value.lastIndexOf("/", separator - 1)
  ) {
    const prefix = value.slice(0, separator);
    const name = value.slice(separator + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  return null;
}

function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  for (;;) {
    const candidate = Buffer.from(`${length} ${body}`, "utf8");
    if (candidate.byteLength === length) return candidate;
    length = candidate.byteLength;
  }
}

function parsePax(payload: Buffer): { path?: string; linkpath?: string; sparse: boolean } | null {
  let cursor = 0;
  const result: { path?: string; linkpath?: string; sparse: boolean } = {
    sparse: false,
  };
  while (cursor < payload.byteLength) {
    const separator = payload.indexOf(0x20, cursor);
    if (separator < 0) return null;
    const length = Number.parseInt(payload.subarray(cursor, separator).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > payload.byteLength) {
      return null;
    }
    const record = payload.subarray(separator + 1, cursor + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) return null;
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") result.path = value;
    if (key === "linkpath") result.linkpath = value;
    if (key.startsWith("GNU.sparse.")) result.sparse = true;
    cursor += length;
  }
  return result;
}

function normalizedTarParts(value: string): string[] | null {
  if (!value || value.includes("\0") || value.startsWith("/")) return null;
  const parts = value.split("/").filter((part) => part.length > 0 && part !== ".");
  return parts.length > 0 && !parts.includes("..") ? parts : null;
}

function rewriteTarHeader(
  source: Buffer,
  entryPath: string,
  linkPath: string,
  root: boolean,
): Buffer[] {
  const header = Buffer.from(source);
  const pathFields = splitUstarPath(entryPath);
  const pax: Buffer[] = [];
  if (!pathFields) pax.push(paxRecord("path", entryPath));
  if (Buffer.byteLength(linkPath) > 100) pax.push(paxRecord("linkpath", linkPath));
  const effectivePath = pathFields ?? {
    name: ".nemoclaw-pax-entry",
    prefix: "",
  };
  writeTarText(header, 0, 100, effectivePath.name);
  writeTarText(header, 345, 155, effectivePath.prefix);
  writeTarText(header, 157, 100, Buffer.byteLength(linkPath) <= 100 ? linkPath : "");
  const mode = root ? 0o700 : (tarNumber(source, 100, 8) ?? 0) & 0o777;
  writeTarOctal(header, 100, 8, mode);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  if (pax.length === 0) return [header];
  const payload = Buffer.concat(pax);
  const paxHeader = Buffer.alloc(TAR_BLOCK_BYTES);
  writeTarText(paxHeader, 0, 100, "PaxHeaders/nemoclaw");
  writeTarOctal(paxHeader, 100, 8, 0o600);
  writeTarOctal(paxHeader, 108, 8, 0);
  writeTarOctal(paxHeader, 116, 8, 0);
  writeTarOctal(paxHeader, 124, 12, payload.byteLength);
  writeTarOctal(paxHeader, 136, 12, 0);
  paxHeader[156] = "x".charCodeAt(0);
  paxHeader.write("ustar\0", 257, 6, "ascii");
  paxHeader.write("00", 263, 2, "ascii");
  paxHeader.fill(0x20, 148, 156);
  let paxChecksum = 0;
  for (const byte of paxHeader) paxChecksum += byte;
  paxHeader.write(`${paxChecksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc(
    Math.ceil(payload.byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES - payload.byteLength,
  );
  return [paxHeader, payload, padding, header];
}

/** Normalize Docker's archive in-process without executing a host interpreter. */
class CompleteNativeStateArchiveTransform extends Transform {
  readonly #rootName: string;
  #buffer = Buffer.alloc(0);
  #rootSeen = false;
  #consecutiveZeroBlocks = 0;
  #pendingPath: string | undefined;
  #pendingLink: string | undefined;
  #entry:
    | { kind: "metadata"; type: string; size: number; padded: number }
    | { kind: "data"; remaining: number }
    | undefined;

  constructor(rootName: string) {
    super();
    this.#rootName = rootName;
  }

  #consume(): void {
    for (;;) {
      if (this.#entry?.kind === "data") {
        if (this.#buffer.byteLength === 0) return;
        const count = Math.min(this.#entry.remaining, this.#buffer.byteLength);
        this.push(this.#buffer.subarray(0, count));
        this.#buffer = this.#buffer.subarray(count);
        this.#entry.remaining -= count;
        if (this.#entry.remaining === 0) this.#entry = undefined;
        continue;
      }
      if (this.#entry?.kind === "metadata") {
        if (this.#buffer.byteLength < this.#entry.padded) return;
        const payload = this.#buffer.subarray(0, this.#entry.size);
        this.#buffer = this.#buffer.subarray(this.#entry.padded);
        const { type } = this.#entry;
        this.#entry = undefined;
        if (type === "x" || type === "g") {
          const metadata = parsePax(payload);
          if (!metadata || metadata.sparse)
            rejectStoppedCapture("Stopped state archive contained invalid metadata.");
          if (type === "g" && (metadata.path !== undefined || metadata.linkpath !== undefined)) {
            rejectStoppedCapture("Stopped state archive contained global path metadata.");
          }
          if (type === "x") {
            this.#pendingPath = metadata.path;
            this.#pendingLink = metadata.linkpath;
          }
        } else {
          const value = payload.toString("utf8").replace(/\0.*$/su, "");
          if (!value) rejectStoppedCapture("Stopped state archive contained empty metadata.");
          if (type === "L") this.#pendingPath = value;
          else this.#pendingLink = value;
        }
        continue;
      }
      if (this.#buffer.byteLength < TAR_BLOCK_BYTES) return;
      const header = this.#buffer.subarray(0, TAR_BLOCK_BYTES);
      this.#buffer = this.#buffer.subarray(TAR_BLOCK_BYTES);
      if (header.every((byte) => byte === 0)) {
        this.#consecutiveZeroBlocks += 1;
        continue;
      }
      if (this.#consecutiveZeroBlocks >= 2 || !tarChecksumIsValid(header)) {
        rejectStoppedCapture("Stopped state archive was malformed.");
      }
      this.#consecutiveZeroBlocks = 0;
      const size = tarNumber(header, 124, 12);
      if (size === null) rejectStoppedCapture("Stopped state archive had an invalid size.");
      const padded = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
      const type = String.fromCharCode(header[156] ?? 0);
      if (["x", "g", "L", "K"].includes(type)) {
        if (size > TAR_METADATA_MAX_BYTES)
          rejectStoppedCapture("Stopped state archive metadata was too large.");
        this.#entry = { kind: "metadata", type, size, padded };
        continue;
      }
      if (type === "S" || !["\0", "0", "1", "2", "5", "7"].includes(type)) {
        rejectStoppedCapture("Stopped state archive contained an unsupported entry.");
      }
      if (!["\0", "0", "7"].includes(type) && size !== 0) {
        rejectStoppedCapture("Stopped state archive contained invalid non-file data.");
      }
      const name = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const sourcePath = this.#pendingPath ?? (prefix ? `${prefix}/${name}` : name);
      const parts = normalizedTarParts(sourcePath);
      if (!parts || parts[0] !== this.#rootName) {
        rejectStoppedCapture("Stopped state archive path escaped the native root.");
      }
      const root = parts.length === 1;
      if (root) {
        if (this.#rootSeen || type !== "5")
          rejectStoppedCapture("Stopped state root was not one directory.");
        this.#rootSeen = true;
      } else if (!this.#rootSeen) {
        rejectStoppedCapture("Stopped state root header was missing.");
      }
      let linkPath = this.#pendingLink ?? tarString(header, 157, 100);
      if (type === "1") {
        const linkParts = normalizedTarParts(linkPath);
        if (!linkParts || linkParts[0] !== this.#rootName || linkParts.length === 1) {
          rejectStoppedCapture("Stopped state archive contained an invalid hard link.");
        }
        linkPath = linkParts.slice(1).join("/");
      }
      this.#pendingPath = undefined;
      this.#pendingLink = undefined;
      for (const output of rewriteTarHeader(
        header,
        root ? "." : parts.slice(1).join("/"),
        linkPath,
        root,
      )) {
        if (output.byteLength > 0) this.push(output);
      }
      this.#entry = { kind: "data", remaining: padded };
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#consume();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#consume();
      if (
        !this.#rootSeen ||
        this.#consecutiveZeroBlocks < 2 ||
        this.#entry !== undefined ||
        this.#pendingPath !== undefined ||
        this.#pendingLink !== undefined ||
        this.#buffer.some((byte) => byte !== 0)
      ) {
        rejectStoppedCapture("Stopped state archive ended before it was complete.");
      }
      this.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

function observeManagedStateMounts(
  mounts: readonly unknown[],
  roots: NonNullable<RuntimeProviderStoppedStateProjection["managedStateRoots"]>,
  nativeRoot: string,
  containerId: string,
  readDocker: (args: readonly string[]) => string | null,
): readonly unknown[] | null {
  const observations: Array<readonly [string, ...unknown[]]> = [];
  const seen = new Set<string>();
  for (const value of mounts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const mount = value as Record<string, unknown>;
    const destination = mount.Destination;
    if (
      typeof destination !== "string" ||
      !path.posix.isAbsolute(destination) ||
      path.posix.normalize(destination) !== destination
    )
      return null;
    const source = nativeRoot;
    if (
      destination !== source &&
      !destination.startsWith(`${source}/`) &&
      !source.startsWith(destination === "/" ? "/" : `${destination}/`)
    )
      continue;
    const root = roots.find((candidate) => candidate.mountTarget === destination);
    if (
      !root ||
      seen.has(destination) ||
      mount.Type !== "volume" ||
      mount.RW !== true ||
      mount.Name !== root.resourceIdentity ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(root.resourceIdentity) ||
      Object.keys(root.ownershipLabels).length === 0
    )
      return null;
    seen.add(destination);
    const raw = readDocker(["volume", "inspect", "--format", "{{json .}}", root.resourceIdentity]);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const volume = parsed as Record<string, unknown>;
    const labels = volume.Labels;
    if (
      volume.Name !== root.resourceIdentity ||
      volume.Driver !== "local" ||
      volume.Scope !== "local" ||
      mount.Driver !== "local" ||
      typeof volume.CreatedAt !== "string" ||
      !Number.isFinite(Date.parse(volume.CreatedAt)) ||
      typeof volume.Mountpoint !== "string" ||
      !path.posix.isAbsolute(volume.Mountpoint) ||
      volume.Mountpoint !== mount.Source ||
      (volume.Options !== null &&
        (typeof volume.Options !== "object" ||
          !volume.Options ||
          Array.isArray(volume.Options) ||
          Object.keys(volume.Options).length !== 0)) ||
      !labels ||
      typeof labels !== "object" ||
      Array.isArray(labels) ||
      !Object.entries(root.ownershipLabels).every(
        ([key, expected]) => (labels as Record<string, unknown>)[key] === expected,
      )
    )
      return null;
    const users = readDocker([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `volume=${root.resourceIdentity}`,
      "--format",
      "{{.ID}}",
    ]);
    if (users?.trim() !== containerId) return null;
    observations.push([
      root.resourceIdentity,
      volume.Driver,
      volume.Scope,
      volume.CreatedAt,
      volume.Mountpoint,
      volume.Options,
      labels,
    ]);
  }
  return observations.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Read the complete native root from one stopped Docker runtime. This operation
 * never starts or executes in the container and never mutates OpenShell state.
 * The provider owns interpretation of its opaque runtime handle.
 */
export function prepareStoppedDockerStateCapture(
  sandbox: SandboxEntry,
  runtime: RuntimeProviderSnapshotRestoreSource,
  projection: RuntimeProviderStoppedStateProjection,
  dependencies: {
    inspect?: typeof dockerSpawnSync;
    spawn?: typeof dockerSpawn;
    createArchiveWriteStream?: (archiveFd: number) => Writable;
    captureTimeoutMs?: number;
  } = {},
): RuntimeProviderStoppedStateCapture {
  const agentName = sandbox.agent ?? "openclaw";
  if (
    !["openclaw", "langchain-deepagents-code"].includes(agentName) ||
    sandbox.openshellDriver !== "docker" ||
    !sandbox.lifecycleLiveIdentityFingerprint ||
    runtime.providerId !== "docker" ||
    runtime.lifecycleState !== "stopped" ||
    runtime.runtime.providerId !== "docker" ||
    runtime.runtime.runtime.kind !== "docker-container" ||
    !/^[a-f0-9]{64}$/u.test(runtime.runtime.runtime.handle)
  ) {
    rejectStoppedCapture(
      "Stopped state capture requires an identified Docker OpenClaw or Deep Agents sandbox.",
    );
  }
  if (projection.nativeRoot !== "/sandbox") {
    rejectStoppedCapture("Stopped state projection requires the complete canonical native root.");
  }
  const nativeRootName = path.posix.basename(projection.nativeRoot);
  const managedStateRoots = structuredClone(projection.managedStateRoots ?? []);
  const containerId = runtime.runtime.runtime.handle;
  const inspect = dependencies.inspect ?? dockerSpawnSync;
  const spawn = dependencies.spawn ?? dockerSpawn;
  const createArchiveWriter = dependencies.createArchiveWriteStream ?? createArchiveWriteStream;
  const captureTimeoutMs = dependencies.captureTimeoutMs ?? NATIVE_STATE_CAPTURE_TIMEOUT_MS;
  const readDocker = (args: readonly string[]): string | null => {
    const result = inspect(args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return result.status === 0 && !result.error && !result.signal ? String(result.stdout) : null;
  };
  const observe = (): unknown => {
    const raw = readDocker([
      "inspect",
      "--type",
      "container",
      "--format",
      INSPECT_FORMAT,
      containerId,
    ]);
    if (raw === null) rejectStoppedCapture("Could not verify the stopped source container.");
    let fields: unknown;
    try {
      fields = JSON.parse(raw);
    } catch {
      rejectStoppedCapture("The stopped source container returned invalid identity evidence.");
    }
    if (!Array.isArray(fields) || fields.length !== 6) {
      rejectStoppedCapture("The stopped source container returned invalid identity evidence.");
    }
    const [id, state, labels, restarts, image, mounts] = fields;
    if (
      id !== containerId ||
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      !["exited", "created"].includes(state.Status) ||
      state.Running !== false ||
      state.Paused !== false ||
      state.Restarting !== false ||
      typeof state.StartedAt !== "string" ||
      typeof state.FinishedAt !== "string" ||
      !labels ||
      typeof labels !== "object" ||
      Array.isArray(labels) ||
      labels["openshell.ai/managed-by"] !== "openshell" ||
      labels["openshell.ai/sandbox-name"] !== sandbox.name ||
      fingerprintOpenShellSandboxId(labels["openshell.ai/sandbox-id"]) !==
        sandbox.lifecycleLiveIdentityFingerprint ||
      !Number.isSafeInteger(restarts) ||
      restarts < 0 ||
      typeof image !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(image) ||
      !Array.isArray(mounts)
    ) {
      rejectStoppedCapture("The source container is no longer the stopped registered sandbox.");
    }
    const ownedVolumes = observeManagedStateMounts(
      mounts,
      managedStateRoots,
      projection.nativeRoot,
      containerId,
      readDocker,
    );
    if (!ownedVolumes)
      rejectStoppedCapture("The source container is no longer the stopped registered sandbox.");
    // Docker enumerates mounts from a map. Their order is not source identity;
    // retain every validated mount and field while comparing them by destination.
    const orderedMounts = [...mounts].sort((left, right) =>
      left.Destination < right.Destination ? -1 : left.Destination > right.Destination ? 1 : 0,
    );
    return [
      id,
      state.Status,
      state.StartedAt,
      state.FinishedAt,
      labels,
      restarts,
      image,
      orderedMounts,
      ownedVolumes,
    ];
  };
  const initial = observe();
  const assertCurrent = (): void => {
    if (!isDeepStrictEqual(observe(), initial)) {
      rejectStoppedCapture("The stopped source container changed during recovery capture.");
    }
  };
  return {
    assertCurrent,
    async capture(archiveFd, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
        rejectStoppedCapture("Stopped state capture requires a valid backup-space limit.");
      }
      assertCurrent();
      await new Promise<void>((resolve, reject) => {
        // No -L or trailing '/.': an agent-replaced root symlink stays a link
        // in the archive and the state owner rejects it instead of following it.
        const child = spawn(["cp", `${containerId}:${projection.nativeRoot}`, "-"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const filter = new CompleteNativeStateArchiveTransform(nativeRootName);
        const writer = createArchiveWriter(archiveFd);
        let inputBytes = 0;
        let outputBytes = 0;
        let childComplete = false;
        let writerComplete = false;
        let settled = false;
        let failure: Error | undefined;
        const fail = (message: string): void => {
          if (settled) return;
          failure ??= new Error(message);
          child.kill("SIGKILL");
          filter.destroy();
          writer.destroy();
          settled = true;
          clearTimeout(timer);
          reject(failure);
        };
        const failRead = (): void =>
          fail("Could not read and filter the stopped source container.");
        const timer = setTimeout(() => fail("Stopped state capture timed out."), captureTimeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => {
          inputBytes += chunk.length;
          if (inputBytes > maxBytes)
            fail(`Stopped state exceeds the ${maxBytes}-byte backup-space limit.`);
        });
        child.stdout?.on("error", failRead).pipe(filter);
        filter.on("error", () => fail("Stopped state archive projection failed."));
        filter.on("data", (chunk: Buffer) => {
          if (failure) return;
          outputBytes += chunk.length;
          if (outputBytes > maxBytes) {
            fail(`Stopped state exceeds the ${maxBytes}-byte backup-space limit.`);
          }
        });
        filter.pipe(writer);
        writer.on("error", () => fail("Could not write the private stopped-state archive."));
        const finish = (): void => {
          if (settled || !childComplete || !writerComplete) return;
          settled = true;
          clearTimeout(timer);
          if (inputBytes === 0 || outputBytes === 0)
            reject(new Error("Stopped state capture was empty."));
          else resolve();
        };
        // Never echo Docker or tar diagnostics: they can contain private source paths.
        child.stderr?.on("error", failRead).resume();
        child.on("error", failRead);
        child.once("close", (code, signal) => {
          if (code !== 0 || signal) {
            fail("Stopped state capture did not complete.");
            return;
          }
          childComplete = true;
          finish();
        });
        writer.once("finish", () => {
          writerComplete = true;
          finish();
        });
      });
      assertCurrent();
    },
  };
}
