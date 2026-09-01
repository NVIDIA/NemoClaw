// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { sanitizeReadinessText } from "../../readiness/sanitize";

const OFFICIAL_OLLAMA_EXECUTABLE_PATH = "/usr/local/bin/ollama";
const METADATA_TIMEOUT_MS = 5_000;
const EXECUTION_PROOF_TIMEOUT_SECONDS = 15;
const EXECUTION_PROOF_TIMEOUT_MS = EXECUTION_PROOF_TIMEOUT_SECONDS * 1_000;
const EXECUTION_PROOF_SUPERVISOR_TIMEOUT_MS = EXECUTION_PROOF_TIMEOUT_MS + 2_000;
const EXECUTION_FAILURE_DETAIL_LIMIT = 240;
const SYSTEMD_RUN_TIMEOUT_RESULT = /^\s*Finished with result: timeout\s*$/mu;
const MAX_PROGRAM_HEADERS = 1_024;
const MAX_PROGRAM_HEADER_SIZE = 1_024;
const MAX_INTERPRETER_PATH_BYTES = 4_096;
const SYSTEMD_EXECUTION_PROPERTIES = new Set(["ExecStart", "User"]);
const SERVICE_USER_ACCESS_MARKER = "nemoclaw-service-user-access";
const SERVICE_USER_ACCESS_SCRIPT = [
  '/usr/bin/test -x "$1"',
  "status=$?",
  `/usr/bin/printf '${SERVICE_USER_ACCESS_MARKER}:%s\\n' "$status"`,
  'exit "$status"',
].join("\n");

export type OllamaExecutablePathMetadata = {
  dev: number;
  gid: number;
  ino: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  uid: number;
};

export type OllamaExecutableCaptureResult = {
  exitCode: number | null;
  stderr?: string;
  stdout: string;
  timedOut: boolean;
};

type OllamaExecutableCommandRunner = (
  command: readonly string[],
  options: { timeout: number },
) => OllamaExecutableCaptureResult;

export type OllamaServiceExecutableProofFailureClassification =
  | "execution-after-repair"
  | "execution-failed"
  | "execution-timeout"
  | "executable-invalid"
  | "executable-timeout"
  | "interpreter-inaccessible"
  | "interpreter-invalid"
  | "interpreter-timeout"
  | "repair-failed"
  | "repair-outside-authority"
  | "rollback-failed"
  | "service-metadata-invalid"
  | "service-metadata-timeout"
  | "service-user-invalid"
  | "service-user-timeout";

export type OllamaServiceExecutableProof =
  | {
      executablePath: string;
      interpreterPath: string;
      ok: true;
      repaired: boolean;
      serviceUser: string;
    }
  | {
      classification: OllamaServiceExecutableProofFailureClassification;
      message: string;
      ok: false;
      rolledBack?: boolean;
    };

export type OllamaSystemdExecutableProofOptions = {
  sudoPrefix: "sudo" | "sudo -n";
  inspectPathImpl?: (candidate: string) => OllamaExecutablePathMetadata | null;
  readElfInterpreterImpl?: (executablePath: string) => string;
  runCaptureExImpl: OllamaExecutableCommandRunner;
};

type ElfLayout = {
  byteOrder: "big" | "little";
  class: 32 | 64;
  programHeaderCount: number;
  programHeaderOffset: number;
  programHeaderSize: number;
};

type InstallerExecutableRepair = {
  dev: number;
  ino: number;
  mode: number;
  repairedMode: number;
};

function failed(
  classification: OllamaServiceExecutableProofFailureClassification,
  message: string,
  rolledBack?: boolean,
): OllamaServiceExecutableProof {
  return {
    classification,
    message,
    ok: false,
    ...(rolledBack === undefined ? {} : { rolledBack }),
  };
}

function defaultInspectPath(candidate: string): OllamaExecutablePathMetadata | null {
  try {
    const metadata = fs.lstatSync(candidate);
    return {
      dev: metadata.dev,
      gid: metadata.gid,
      ino: metadata.ino,
      isDirectory: metadata.isDirectory(),
      isFile: metadata.isFile(),
      isSymbolicLink: metadata.isSymbolicLink(),
      mode: metadata.mode & 0o7777,
      uid: metadata.uid,
    };
  } catch {
    return null;
  }
}

function readExact(descriptor: number, size: number, position: number): Buffer {
  const buffer = Buffer.alloc(size);
  let bytesRead = 0;
  while (bytesRead < size) {
    const count = fs.readSync(
      descriptor,
      buffer,
      bytesRead,
      size - bytesRead,
      position + bytesRead,
    );
    if (count === 0) throw new Error("Ollama ELF metadata is truncated");
    bytesRead += count;
  }
  return buffer;
}

function readUnsigned(
  buffer: Buffer,
  offset: number,
  size: 2 | 4 | 8,
  byteOrder: ElfLayout["byteOrder"],
): number {
  if (size === 2) {
    return byteOrder === "little" ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  }
  if (size === 4) {
    return byteOrder === "little" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  }
  const value =
    byteOrder === "little" ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Ollama ELF offset is too large");
  return Number(value);
}

function parseElfLayout(header: Buffer): ElfLayout {
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("Ollama ExecStart is not an ELF executable");
  }
  const elfClass = header[4] === 1 ? 32 : header[4] === 2 ? 64 : null;
  const byteOrder = header[5] === 1 ? "little" : header[5] === 2 ? "big" : null;
  if (elfClass === null || byteOrder === null) {
    throw new Error("Ollama ELF class or byte order is invalid");
  }
  const programHeaderOffset = readUnsigned(
    header,
    elfClass === 64 ? 32 : 28,
    elfClass === 64 ? 8 : 4,
    byteOrder,
  );
  const programHeaderSize = readUnsigned(header, elfClass === 64 ? 54 : 42, 2, byteOrder);
  const programHeaderCount = readUnsigned(header, elfClass === 64 ? 56 : 44, 2, byteOrder);
  const minimumProgramHeaderSize = elfClass === 64 ? 56 : 32;
  if (
    programHeaderOffset <= 0 ||
    programHeaderSize < minimumProgramHeaderSize ||
    programHeaderSize > MAX_PROGRAM_HEADER_SIZE ||
    programHeaderCount <= 0 ||
    programHeaderCount > MAX_PROGRAM_HEADERS
  ) {
    throw new Error("Ollama ELF program-header table is invalid");
  }
  return {
    byteOrder,
    class: elfClass,
    programHeaderCount,
    programHeaderOffset,
    programHeaderSize,
  };
}

/** Read the exact ELF PT_INTERP path without executing the file. */
export function readElfInterpreterPath(executablePath: string): string {
  const descriptor = fs.openSync(executablePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("Ollama ExecStart is not a regular file");
    }
    const header = readExact(descriptor, 64, 0);
    const layout = parseElfLayout(header);
    const candidates: Array<{ offset: number; size: number }> = [];
    for (let index = 0; index < layout.programHeaderCount; index += 1) {
      const offset = layout.programHeaderOffset + index * layout.programHeaderSize;
      const programHeader = readExact(descriptor, layout.programHeaderSize, offset);
      const type = readUnsigned(programHeader, 0, 4, layout.byteOrder);
      if (type !== 3) continue;
      candidates.push({
        offset: readUnsigned(
          programHeader,
          layout.class === 64 ? 8 : 4,
          layout.class === 64 ? 8 : 4,
          layout.byteOrder,
        ),
        size: readUnsigned(
          programHeader,
          layout.class === 64 ? 32 : 16,
          layout.class === 64 ? 8 : 4,
          layout.byteOrder,
        ),
      });
    }
    if (candidates.length !== 1) {
      throw new Error("Ollama ELF must contain exactly one PT_INTERP entry");
    }
    const [{ offset, size }] = candidates;
    if (size < 2 || size > MAX_INTERPRETER_PATH_BYTES) {
      throw new Error("Ollama ELF PT_INTERP size is invalid");
    }
    const encoded = readExact(descriptor, size, offset);
    if (encoded.at(-1) !== 0 || encoded.subarray(0, -1).includes(0)) {
      throw new Error("Ollama ELF PT_INTERP is not one NUL-terminated path");
    }
    const interpreterPath = new TextDecoder("utf-8", { fatal: true }).decode(
      encoded.subarray(0, -1),
    );
    if (!path.isAbsolute(interpreterPath) || path.normalize(interpreterPath) !== interpreterPath) {
      throw new Error("Ollama ELF PT_INTERP is not an absolute normalized path");
    }
    return interpreterPath;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Parse one configured systemd User and one absolute ExecStart executable. */
export function parseOllamaSystemdExecutionMetadata(
  output: string,
): { executablePath: string; serviceUser: string } | null {
  const properties: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    const name = separator > 0 ? line.slice(0, separator) : "";
    if (!SYSTEMD_EXECUTION_PROPERTIES.has(name) || Object.hasOwn(properties, name)) return null;
    properties[name] = line.slice(separator + 1).trim();
  }
  const serviceUser = properties.User ?? "";
  if (!/^(?:[A-Za-z_][A-Za-z0-9_-]*|[0-9]+)$/u.test(serviceUser)) return null;
  const candidates = Array.from(
    (properties.ExecStart ?? "").matchAll(/(?:^|[\s;])path=([^\s;]+)/gu),
    (match) => match[1] ?? "",
  );
  if (candidates.length !== 1 || !path.isAbsolute(candidates[0])) return null;
  const executablePath = path.normalize(candidates[0]);
  if (executablePath !== candidates[0]) return null;
  return { executablePath, serviceUser };
}

function commandPrefix(sudoPrefix: "sudo" | "sudo -n"): string[] {
  return sudoPrefix === "sudo -n" ? ["/usr/bin/sudo", "-n"] : ["/usr/bin/sudo"];
}

function sudoServiceUserArgument(serviceUser: string): string {
  return /^[0-9]+$/u.test(serviceUser) ? `#${serviceUser}` : serviceUser;
}

function sameFile(
  metadata: OllamaExecutablePathMetadata | null,
  expected: Pick<InstallerExecutableRepair, "dev" | "ino">,
): metadata is OllamaExecutablePathMetadata {
  return metadata !== null && metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function inspectInstallerExecutableRepair(
  executablePath: string,
  inspectPath: NonNullable<OllamaSystemdExecutableProofOptions["inspectPathImpl"]>,
): InstallerExecutableRepair | null {
  if (executablePath !== OFFICIAL_OLLAMA_EXECUTABLE_PATH) return null;
  const executable = inspectPath(executablePath);
  if (
    executable === null ||
    !executable.isFile ||
    executable.isSymbolicLink ||
    executable.gid !== 0 ||
    executable.uid !== 0 ||
    (executable.mode & 0o7000) !== 0 ||
    (executable.mode & 0o022) !== 0 ||
    (executable.mode & 0o111) === 0o111
  ) {
    return null;
  }
  for (const ancestor of ["/", "/usr", "/usr/local", "/usr/local/bin"]) {
    const metadata = inspectPath(ancestor);
    if (
      metadata === null ||
      !metadata.isDirectory ||
      metadata.isSymbolicLink ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o111) !== 0o111
    ) {
      return null;
    }
  }
  return {
    dev: executable.dev,
    ino: executable.ino,
    mode: executable.mode,
    repairedMode: executable.mode | 0o111,
  };
}

function chmodExecutable(
  executablePath: string,
  mode: number,
  options: OllamaSystemdExecutableProofOptions,
): OllamaExecutableCaptureResult {
  return options.runCaptureExImpl(
    [
      ...commandPrefix(options.sudoPrefix),
      "/usr/bin/chmod",
      mode.toString(8).padStart(4, "0"),
      "--",
      executablePath,
    ],
    { timeout: METADATA_TIMEOUT_MS },
  );
}

function rollbackExecutableMode(
  executablePath: string,
  repair: InstallerExecutableRepair,
  options: OllamaSystemdExecutableProofOptions,
): boolean {
  const inspectPath = options.inspectPathImpl ?? defaultInspectPath;
  if (!sameFile(inspectPath(executablePath), repair)) return false;
  const result = chmodExecutable(executablePath, repair.mode, options);
  const restored = inspectPath(executablePath);
  return (
    !result.timedOut &&
    result.exitCode === 0 &&
    sameFile(restored, repair) &&
    restored.mode === repair.mode
  );
}

function runServiceUserProof(
  serviceUser: string,
  executablePath: string,
  options: OllamaSystemdExecutableProofOptions,
): OllamaExecutableCaptureResult {
  // The transient service owns the complete proof cgroup. RuntimeMaxSec stops
  // every descendant before the outer synchronous runner can release its caller.
  const result = options.runCaptureExImpl(
    [
      ...commandPrefix(options.sudoPrefix),
      "/usr/bin/env",
      "LC_ALL=C",
      "/usr/bin/systemd-run",
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
      `--uid=${serviceUser}`,
      "--property=KillMode=control-group",
      `--property=RuntimeMaxSec=${String(EXECUTION_PROOF_TIMEOUT_SECONDS)}s`,
      "--property=TimeoutStopSec=250ms",
      "--property=SendSIGKILL=yes",
      executablePath,
      "--version",
    ],
    { timeout: EXECUTION_PROOF_SUPERVISOR_TIMEOUT_MS },
  );
  return {
    ...result,
    timedOut: result.timedOut || SYSTEMD_RUN_TIMEOUT_RESULT.test(result.stderr ?? ""),
  };
}

function runServiceUserPathAccessProof(
  serviceUser: string,
  candidatePath: string,
  options: OllamaSystemdExecutableProofOptions,
): OllamaExecutableCaptureResult {
  return options.runCaptureExImpl(
    [
      ...commandPrefix(options.sudoPrefix),
      "-u",
      sudoServiceUserArgument(serviceUser),
      "--",
      "/bin/sh",
      "-c",
      SERVICE_USER_ACCESS_SCRIPT,
      "nemoclaw-service-user-access-proof",
      candidatePath,
    ],
    { timeout: METADATA_TIMEOUT_MS },
  );
}

function serviceUserPathAccessOutcome(
  result: OllamaExecutableCaptureResult,
): "accessible" | "inaccessible" | "invalid" {
  if (result.exitCode !== 0 && result.exitCode !== 1) return "invalid";
  if (result.stdout.trim() !== `${SERVICE_USER_ACCESS_MARKER}:${result.exitCode}`) return "invalid";
  return result.exitCode === 0 ? "accessible" : "inaccessible";
}

function systemdRunFailureDetail(result: OllamaExecutableCaptureResult): string {
  const detail = sanitizeReadinessText(result.stderr ?? "", EXECUTION_FAILURE_DETAIL_LIMIT)
    .replace(/\s+/gu, " ")
    .trim();
  return detail ? ` systemd-run detail: ${detail}` : "";
}

/** Prove that systemd's configured Ollama user can execute the exact binary and PT_INTERP. */
export function proveOllamaSystemdServiceExecutable(
  options: OllamaSystemdExecutableProofOptions,
): OllamaServiceExecutableProof {
  const { runCaptureExImpl } = options;
  const metadataResult = runCaptureExImpl(
    ["/usr/bin/systemctl", "show", "ollama.service", "--property=User", "--property=ExecStart"],
    { timeout: METADATA_TIMEOUT_MS },
  );
  if (metadataResult.timedOut) {
    return failed(
      "service-metadata-timeout",
      "systemctl did not return Ollama service metadata within 5 seconds",
    );
  }
  const metadata =
    metadataResult.exitCode === 0
      ? parseOllamaSystemdExecutionMetadata(metadataResult.stdout)
      : null;
  if (metadata === null) {
    return failed(
      "service-metadata-invalid",
      "systemd did not return one configured User and one absolute ExecStart executable",
    );
  }
  const userResult = runCaptureExImpl(["/usr/bin/id", "-u", metadata.serviceUser], {
    timeout: METADATA_TIMEOUT_MS,
  });
  if (userResult.timedOut) {
    return failed(
      "service-user-timeout",
      `could not verify that systemd User '${metadata.serviceUser}' resolves to a host account within 5 seconds`,
    );
  }
  if (userResult.exitCode !== 0) {
    return failed(
      "service-user-invalid",
      `systemd User '${metadata.serviceUser}' does not resolve to a host account`,
    );
  }

  let interpreterPath: string;
  try {
    interpreterPath = (options.readElfInterpreterImpl ?? readElfInterpreterPath)(
      metadata.executablePath,
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
    const message = error instanceof Error ? error.message : String(error);
    const classification =
      code === "EACCES" || code === "ENOENT" || code === "ENOTDIR" || !message.includes("PT_INTERP")
        ? "executable-invalid"
        : "interpreter-invalid";
    return failed(
      classification,
      `could not resolve one absolute ELF PT_INTERP for '${metadata.executablePath}': ${message}`,
    );
  }

  const initialProof = runServiceUserProof(metadata.serviceUser, metadata.executablePath, options);
  if (!initialProof.timedOut && initialProof.exitCode === 0) {
    return { ...metadata, interpreterPath, ok: true, repaired: false };
  }
  if (initialProof.timedOut) {
    return failed(
      "execution-timeout",
      `Ollama ExecStart did not complete '--version' as systemd User '${metadata.serviceUser}' within ${String(EXECUTION_PROOF_TIMEOUT_SECONDS)} seconds`,
    );
  }
  const executionFailureDetail = systemdRunFailureDetail(initialProof);

  const executableAccessResult = runServiceUserPathAccessProof(
    metadata.serviceUser,
    metadata.executablePath,
    options,
  );
  if (executableAccessResult.timedOut) {
    return failed(
      "executable-timeout",
      `could not verify that systemd User '${metadata.serviceUser}' can execute Ollama ExecStart '${metadata.executablePath}' within 5 seconds`,
    );
  }
  const executableAccess = serviceUserPathAccessOutcome(executableAccessResult);
  if (executableAccess === "invalid") {
    return failed(
      "execution-failed",
      `Ollama ExecStart failed as systemd User '${metadata.serviceUser}', and the execute-access check returned no confirmed result from that user.${executionFailureDetail}`,
    );
  }

  const interpreterResult = runServiceUserPathAccessProof(
    metadata.serviceUser,
    interpreterPath,
    options,
  );
  if (interpreterResult.timedOut) {
    return failed(
      "interpreter-timeout",
      `could not verify that systemd User '${metadata.serviceUser}' can execute PT_INTERP '${interpreterPath}' within 5 seconds`,
    );
  }
  const interpreterAccess = serviceUserPathAccessOutcome(interpreterResult);
  if (interpreterAccess === "invalid") {
    return failed(
      "execution-failed",
      `Ollama ExecStart failed as systemd User '${metadata.serviceUser}', and the PT_INTERP execute-access check returned no confirmed result from that user.${executionFailureDetail}`,
    );
  }
  if (interpreterAccess === "inaccessible") {
    return failed(
      "interpreter-inaccessible",
      `systemd User '${metadata.serviceUser}' cannot execute PT_INTERP '${interpreterPath}'`,
    );
  }
  if (executableAccess !== "inaccessible") {
    const proofOutcome =
      initialProof.exitCode === null
        ? "did not return an exit status"
        : `exited ${initialProof.exitCode}`;
    const accessOutcome =
      executableAccess === "accessible"
        ? "the service user still has execute access"
        : "the execute-access check did not confirm missing execute access";
    return failed(
      "execution-failed",
      `Ollama ExecStart '--version' ${proofOutcome} as systemd User '${metadata.serviceUser}', and ${accessOutcome}.${executionFailureDetail}`,
    );
  }

  const inspectPath = options.inspectPathImpl ?? defaultInspectPath;
  const repair = inspectInstallerExecutableRepair(metadata.executablePath, inspectPath);
  if (repair === null) {
    return failed(
      "repair-outside-authority",
      `Ollama ExecStart failed as systemd User '${metadata.serviceUser}'. The execute-access check failed, and NemoClaw found no executable permission change within its installer authority`,
    );
  }

  const repairResult = chmodExecutable(metadata.executablePath, repair.repairedMode, options);
  const repaired = inspectPath(metadata.executablePath);
  if (
    repairResult.timedOut ||
    repairResult.exitCode !== 0 ||
    !sameFile(repaired, repair) ||
    repaired.mode !== repair.repairedMode
  ) {
    const needsRollback = sameFile(repaired, repair) && repaired.mode !== repair.mode;
    if (needsRollback && !rollbackExecutableMode(metadata.executablePath, repair, options)) {
      return failed(
        "rollback-failed",
        `could not confirm rollback of '${metadata.executablePath}' to mode ${repair.mode.toString(8).padStart(4, "0")}`,
        false,
      );
    }
    return failed(
      "repair-failed",
      `could not apply and verify mode ${repair.repairedMode.toString(8).padStart(4, "0")} on the installer-owned Ollama executable${needsRollback ? `; NemoClaw restored mode ${repair.mode.toString(8).padStart(4, "0")}` : ""}`,
      needsRollback,
    );
  }

  const repairedProof = runServiceUserProof(metadata.serviceUser, metadata.executablePath, options);
  if (!repairedProof.timedOut && repairedProof.exitCode === 0) {
    return { ...metadata, interpreterPath, ok: true, repaired: true };
  }
  if (!rollbackExecutableMode(metadata.executablePath, repair, options)) {
    return failed(
      "rollback-failed",
      `the repaired execution proof failed and NemoClaw could not confirm rollback of '${metadata.executablePath}'`,
      false,
    );
  }
  return failed(
    "execution-after-repair",
    `Ollama ExecStart still failed as systemd User '${metadata.serviceUser}' after mode repair; NemoClaw restored mode ${repair.mode.toString(8).padStart(4, "0")}`,
    true,
  );
}
