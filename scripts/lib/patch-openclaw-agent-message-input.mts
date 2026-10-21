#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Managed-runtime bridge for #13130. Remove when the pinned native parser
// accepts implicit stdin and reads inherited descriptors without reopening them.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "// nemoclaw: preserve inherited agent message input";
const IMPORT = 'import { fstatSync as nemoclawStdinStat } from "node:fs";';
const ORIGINAL_OPEN = `async function readAgentMessageFile(messageFile) {
\tlet handle;
\ttry {
\t\thandle = await fs.open(messageFile, "r");
\t} catch (err) {
\t\tthrow new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
\t}`;
const PATCHED_OPEN = `${MARKER}
async function readInheritedAgentMessage(timeout) {
\tconst chunks = [];
\tlet size = 0;
\tconst seconds = Number(timeout);
\tconst budget = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 2147483647) : 30000;
\tconst timer = setTimeout(() => process.stdin.destroy(new Error("Timed out waiting for stdin; close the producer, provide --message, or set --timeout <seconds>.")), budget);
\ttry {
\t\tfor await (const chunk of process.stdin) {
\t\t\tsize += chunk.length;
\t\t\tif (size > AGENT_MESSAGE_FILE_MAX_BYTES) throw new Error("File exceeds " + AGENT_MESSAGE_FILE_MAX_BYTES + " bytes");
\t\t\tchunks.push(chunk);
\t\t}
\t\treturn Buffer.concat(chunks, size);
\t} finally {
\t\tclearTimeout(timer);
\t}
}
function borrowAgentMessageStdin() {
\treturn { fd: 0, inheritedStdin: true, stat: async () => nemoclawStdinStat(0), close: async () => {} };
}
async function readAgentMessageFile(messageFile, inheritedStdin = false, timeout) {
\tlet handle;
\ttry {
\t\thandle = inheritedStdin ? borrowAgentMessageStdin() : await fs.open(messageFile, "r");
\t} catch (err) {
\t\t// A sandbox may deny reopening a pipe that the process can already read.
\t\t// Retain the native denial unless the requested path identifies fd 0.
\t\tif (err?.code === "EACCES") {
\t\t\ttry {
\t\t\t\tconst input = nemoclawStdinStat(0);
\t\t\t\tconst file = await fs.stat(messageFile);
\t\t\t\tif (input.dev === file.dev && input.ino === file.ino) handle = borrowAgentMessageStdin();
\t\t\t} catch {}
\t\t}
\t\tif (!handle) throw new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
\t}`;
const ORIGINAL_MESSAGE = '\tconst message = opts.message ?? "";';
const PATCHED_MESSAGE = `\tconst message = opts.message ?? (process.stdin.isTTY === true ? "" : await readAgentMessageFile("stdin", true, opts.timeout));`;

const ORIGINAL_READ =
  "buffer = await readFileDescriptorBounded(handle.fd, AGENT_MESSAGE_FILE_MAX_BYTES);";
const PATCHED_READ = `let inherited = handle.inheritedStdin;
\t\tif (!inherited && !stat.isFile()) {
\t\t\ttry {
\t\t\t\tconst input = nemoclawStdinStat(0);
\t\t\t\tinherited = input.dev === stat.dev && input.ino === stat.ino;
\t\t\t} catch {}
\t\t}
\t\tbuffer = inherited ? await readInheritedAgentMessage(timeout) : await readFileDescriptorBounded(handle.fd, AGENT_MESSAGE_FILE_MAX_BYTES);`;

const ORIGINAL_FILE = "await readAgentMessageFile(messageFile);";
const PATCHED_FILE = "await readAgentMessageFile(messageFile, false, opts.timeout);";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function patchAgentMessageInput(source: string): string {
  const region = source.match(
    /function missingAgentMessageError\(\) \{[\s\S]*?async function resolveAgentMessageOpts\(opts\) \{[\s\S]*?\n\}/u,
  )?.[0];
  if (!region) throw new Error("Missing native OpenClaw agent message parser");
  const restored = region
    .replace(PATCHED_OPEN, ORIGINAL_OPEN)
    .replace(PATCHED_MESSAGE, ORIGINAL_MESSAGE)
    .replace(PATCHED_READ, ORIGINAL_READ)
    .replace(PATCHED_FILE, ORIGINAL_FILE);
  if (digest(restored) !== "6ac2ff76ee85a5a9fd957a920a812325d77979a6ee02255c148a9dc96ca92e32")
    throw new Error("Unrecognized native OpenClaw agent message parser");
  const patched = restored
    .replace(ORIGINAL_OPEN, PATCHED_OPEN)
    .replace(ORIGINAL_MESSAGE, PATCHED_MESSAGE)
    .replace(ORIGINAL_READ, PATCHED_READ)
    .replace(ORIGINAL_FILE, PATCHED_FILE);
  if (source.includes(MARKER)) {
    if (
      region !== patched ||
      source.split(IMPORT).length !== 2 ||
      source.split(MARKER).length !== 2
    )
      throw new Error("Incomplete OpenClaw agent message input patch");
    return source;
  }
  if (source.includes(IMPORT) || region !== restored)
    throw new Error("Incomplete OpenClaw agent message input patch");
  return `${IMPORT}\n${source.replace(region, () => patched)}`;
}

export function patchOpenClawAgentMessageInput(distDir: string, audit = false): void {
  const { version } = JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8"));
  if (["2026.3.11", "2026.4.24"].includes(version)) return;
  if (version !== "2026.9.2") throw new Error(`Unsupported OpenClaw version: ${version}`);
  const targets = fs
    .readdirSync(distDir)
    .filter((name) => /^agent-via-gateway-[\w-]+\.js$/u.test(name));
  if (targets.length !== 1) throw new Error("Expected one native OpenClaw agent message module");
  const target = path.join(distDir, targets[0]!);
  const source = fs.readFileSync(target, "utf8");
  const patched = patchAgentMessageInput(source);
  if (audit) {
    if (patched !== source) throw new Error("OpenClaw agent message input patch is missing");
  } else if (patched !== source) fs.writeFileSync(target, patched);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const audit = args[0] === "--audit";
  const directory = args[audit ? 1 : 0];
  if (!directory || args.length !== (audit ? 2 : 1)) {
    console.error("Usage: patch-openclaw-agent-message-input.mts [--audit] <openclaw-dist-dir>");
    process.exitCode = 2;
  } else {
    try {
      patchOpenClawAgentMessageInput(directory, audit);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
