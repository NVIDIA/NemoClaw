// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type NativeMessage = { role: "system" | "user" | "assistant"; content: string };
type ReadOpenedRegularFileOptions = { encoding?: BufferEncoding; maxBytes?: number };
export type BrokerOperation = "models" | "chat-completions";
export type NativeCredentialIdentity = { agent: string; inference: string; endpoint: string };

function fail(message: string): never {
  throw new Error(`NemoClaw native runtime security boundary failed: ${message}`);
}

export function brokerOperationForRequest(
  method: string | undefined,
  requestTarget: string | undefined,
): BrokerOperation | null {
  if (method === "GET" && requestTarget === "/v1/models") return "models";
  if (method === "POST" && requestTarget === "/v1/chat/completions") return "chat-completions";
  return null;
}

export function resolveBrokerUpstreamUrl(endpointValue: string, operation: BrokerOperation): URL {
  if (typeof endpointValue !== "string") fail("the provider endpoint is invalid");
  const endpoint = new URL(`${endpointValue.replace(/\/$/u, "")}/`);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    fail("the provider endpoint violates the native preview boundary");
  const relativeTarget =
    operation === "models"
      ? "models"
      : operation === "chat-completions"
        ? "chat/completions"
        : fail("the broker operation is not allowlisted");
  const upstream = new URL(relativeTarget, endpoint);
  if (upstream.origin !== endpoint.origin)
    fail("the broker request target changed the configured provider origin");
  return upstream;
}

export function nativeCredentialBinding(identity: NativeCredentialIdentity): string {
  if (
    !identity ||
    !["openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua"].includes(
      identity.agent,
    ) ||
    !["nvidia", "openrouter", "compatible", "local"].includes(identity.inference)
  )
    fail("the credential identity is invalid");
  // Bind the actual request destination after the same URL normalization used by the broker.
  const destination = resolveBrokerUpstreamUrl(identity.endpoint, "models");
  if (identity.inference !== "local" && destination.protocol !== "https:")
    fail("the credential endpoint requires HTTPS");
  const fixedEndpoint =
    identity.inference === "nvidia"
      ? "https://integrate.api.nvidia.com/v1"
      : identity.inference === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : null;
  if (
    fixedEndpoint !== null &&
    destination.href !== resolveBrokerUpstreamUrl(fixedEndpoint, "models").href
  )
    fail("the credential endpoint does not match the selected provider");
  if (
    identity.inference === "local" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname)
  )
    fail("the local credential endpoint is not loopback");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "nemoclaw-native-credential-v1",
        identity.agent,
        identity.inference,
        destination.href,
      ]),
    )
    .digest("hex");
}

export async function readWindowsCredential(
  launcher: string,
  identity: NativeCredentialIdentity,
  required: boolean,
): Promise<string> {
  const binding = nativeCredentialBinding(identity);
  if (!required) return "";
  return await readCredentialByBinding(launcher, identity.inference, binding);
}

export async function readCredentialByBinding(
  launcher: string,
  provider: string,
  binding: string,
): Promise<string> {
  if (
    ![
      "nvidia",
      "openrouter",
      "compatible",
      "local",
      "brave",
      "tavily",
      "telegram",
      "discord",
      "slack-bot",
      "slack-app",
    ].includes(provider) ||
    !/^[0-9a-f]{64}$/u.test(binding)
  )
    fail("the stored credential identity is invalid");
  const result = await new Promise<{ code: number; bytesRead: number; secret: Buffer }>(
    (resolve, reject) => {
      const child = spawn(launcher, ["--credential-read", provider, "--binding", binding], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        bytesRead += chunk.length;
        if (bytesRead <= 2048) chunks.push(chunk);
      });
      child.stderr.resume();
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({ code: code ?? 1, bytesRead, secret: Buffer.concat(chunks) }),
      );
    },
  );
  if (result.code !== 0 || result.bytesRead === 0 || result.bytesRead > 2048)
    fail("Windows Credential Manager does not contain a valid bounded provider credential");
  return result.secret.toString("utf8");
}

export async function deleteCredentialByBinding(
  launcher: string,
  provider: string,
  binding: string,
): Promise<void> {
  if (
    ![
      "nvidia",
      "openrouter",
      "compatible",
      "local",
      "brave",
      "tavily",
      "telegram",
      "discord",
      "slack-bot",
      "slack-app",
    ].includes(provider) ||
    !/^[0-9a-f]{64}$/u.test(binding)
  )
    fail("the stored credential identity is invalid");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher, ["--credential-delete", provider, "--binding", binding], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let outputBytes = 0;
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Windows could not remove the selected stored key."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || outputBytes !== 0)
        reject(new Error("Windows could not remove the selected stored key."));
      else resolve();
    });
  });
}

export function readOpenedRegularFile(
  file: string,
  options: { encoding: BufferEncoding; maxBytes?: number },
): string | null;
export function readOpenedRegularFile(
  file: string,
  options?: { encoding?: undefined; maxBytes?: number },
): Buffer | null;
export function readOpenedRegularFile(
  file: string,
  { encoding, maxBytes = 2 * 1024 * 1024 }: ReadOpenedRegularFileOptions = {},
): Buffer | string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "r");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail("the opened relay or diagnostic path is not a regular file");
    if (stat.size > maxBytes) fail("the opened relay or diagnostic file exceeds its limit");
    return encoding ? fs.readFileSync(descriptor, encoding) : fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeNativeGatewayConfig(installRoot: string, runRoot: string): string {
  const installation = path.resolve(installRoot);
  if (Buffer.from(installation, "utf8").toString("utf8") !== installation)
    fail("the installation path contains invalid Unicode");
  const resolvedInstallation = fs.realpathSync(installation);
  const resolvedRunRoot = fs.realpathSync(runRoot);
  const relative = path.relative(resolvedInstallation, resolvedRunRoot);
  if (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
    fail("the gateway configuration must be outside the installed payload");
  const template = readOpenedRegularFile(path.join(installation, "config", "mxc-gateway.toml"), {
    encoding: "utf8",
    maxBytes: 64 * 1024,
  });
  if (template === null) fail("the installed gateway configuration template is missing");
  // JSON uses TOML-compatible basic-string escapes, except for its unescaped DEL character.
  const executable = JSON.stringify(path.join(installation, "mxc", "wxc-exec.exe")).replace(
    /\u007f/gu,
    "\\u007f",
  );
  let inMxc = false;
  let sections = 0;
  let executablePaths = 0;
  const rendered = template
    .split(/\r?\n/u)
    .map((line) => {
      if (/^\s*\[/u.test(line)) {
        inMxc = /^\s*\[\s*openshell\.drivers\.mxc\s*\]\s*(?:#.*)?$/u.test(line);
        if (inMxc) sections += 1;
      }
      if (!inMxc || !/^\s*wxc_exec_path\s*=/u.test(line)) return line;
      const setting = /^(\s*wxc_exec_path\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/u.exec(
        line,
      );
      if (!setting) fail("the gateway template executable path must be a single-line TOML string");
      executablePaths += 1;
      return `${setting[1]}${executable}${setting[2]}`;
    })
    .join(template.includes("\r\n") ? "\r\n" : "\n");
  if (sections !== 1 || executablePaths !== 1)
    fail("the gateway template must declare one MXC section and executable path");
  const output = path.join(resolvedRunRoot, "mxc-gateway.toml");
  fs.writeFileSync(output, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return output;
}

export function validatedChatMessages(body: unknown): NativeMessage[] {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    fail("the model request body is invalid");
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length > 64)
    fail("the model request message list is invalid");
  let totalBytes = 0;
  return messages.map((message: unknown) => {
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      !["system", "user", "assistant"].includes((message as { role?: unknown }).role as string) ||
      typeof (message as { content?: unknown }).content !== "string"
    )
      fail("the model request contains an invalid message");
    const validated = message as NativeMessage;
    totalBytes += Buffer.byteLength(validated.content, "utf8");
    if (validated.content.length > 64 * 1024 || totalBytes > 1024 * 1024)
      fail("the model request message content exceeds its limit");
    return { role: validated.role, content: validated.content };
  });
}
