// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nativeHermesCompatibility, type NativeRuntimeLaunchLease } from "./native-runtime.mts";
import type { NativeGatewaySession } from "./native-gateway-session.mts";
import { PROVIDER_CONFIGURATION } from "./native-provider-policy.mts";

type ReadOpenedRegularFileOptions = {
  encoding?: BufferEncoding;
  maxBytes?: number;
  rejectLinks?: boolean;
  rejectHardLinks?: boolean;
};
export type BrokerOperation = "models" | "chat-completions";
export type NativeCredentialIdentity = { agent: string; inference: string; endpoint: string };
export type NativeGatewayNetwork =
  | { kind: "deny" }
  | { kind: "personal" }
  | { kind: "supervised" }
  | { kind: "loopback"; ports: readonly number[] };
export type NativeGatewayOptions = { network?: NativeGatewayNetwork; hostConsole?: boolean };

export const NATIVE_NODE_UI_POLICY = Object.freeze([
  "ui:",
  "  allow_graphical_ui: true",
  "  clipboard: none",
  "  allow_input_injection: false",
  "",
]);

function fail(message: string): never {
  throw new Error(`NemoClaw native runtime security boundary failed: ${message}`);
}

function validatedLoopbackPorts(ports: readonly number[]): number[] {
  if (
    !Array.isArray(ports) ||
    !ports.length ||
    Array.from(ports).some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  )
    fail("qualification loopback ports are invalid");
  return [...new Set(ports)];
}

export function nativeQualificationLoopbackConfig(
  probe: unknown,
  ports: readonly number[],
): NativeGatewayNetwork {
  const validated = validatedLoopbackPorts(ports);
  if (!probe || typeof probe !== "object") fail("the MXC qualification probe is invalid");
  const value = probe as { tier?: unknown; needsDaclAugmentation?: unknown };
  if (value.tier === "base-container" && value.needsDaclAugmentation === false)
    return { kind: "loopback", ports: validated };
  if (value.tier === "appcontainer-dacl" && value.needsDaclAugmentation === true)
    return { kind: "deny" };
  fail("the MXC qualification tier is unknown or inconsistent");
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
    typeof identity.inference !== "string" ||
    !Object.hasOwn(PROVIDER_CONFIGURATION, identity.inference)
  )
    fail("the credential identity is invalid");
  // Bind the actual request destination after the same URL normalization used by the broker.
  const destination = resolveBrokerUpstreamUrl(identity.endpoint, "models");
  const provider = PROVIDER_CONFIGURATION[identity.inference];
  if (!provider.loopbackOnly && destination.protocol !== "https:")
    fail("the credential endpoint requires HTTPS");
  const fixedEndpoint = provider.endpoint;
  if (
    fixedEndpoint !== null &&
    destination.href !== resolveBrokerUpstreamUrl(fixedEndpoint, "models").href
  )
    fail("the credential endpoint does not match the selected provider");
  if (provider.loopbackOnly && !["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname))
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
  optional = false,
): Promise<string> {
  if (
    ![
      ...Object.keys(PROVIDER_CONFIGURATION),
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
      const child = spawn(
        launcher,
        [
          optional ? "--credential-read-optional" : "--credential-read",
          provider,
          "--binding",
          binding,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      const terminate = (message: string) => {
        clearTimeout(timer);
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        chunks.forEach((chunk) => chunk.fill(0));
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => terminate("Reading the selected Windows credential timed out."),
        15_000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        bytesRead += chunk.length;
        if (bytesRead > 2048) {
          terminate(
            "Windows Credential Manager does not contain a valid bounded provider credential",
          );
          return;
        }
        chunks.push(chunk);
      });
      child.stdout.once("error", () =>
        terminate("Windows could not read the selected stored key."),
      );
      child.stderr.once("error", () =>
        terminate("Windows could not read the selected stored key."),
      );
      child.stderr.resume();
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Windows could not read the selected stored key."));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        const secret = Buffer.concat(chunks);
        chunks.forEach((chunk) => chunk.fill(0));
        resolve({ code: code ?? 1, bytesRead, secret });
      });
    },
  );
  try {
    if (result.code !== 0 || (!optional && result.bytesRead === 0) || result.bytesRead > 2048)
      fail("Windows Credential Manager does not contain a valid bounded provider credential");
    return result.secret.toString("utf8");
  } finally {
    result.secret.fill(0);
  }
}

export async function deleteCredentialByBinding(
  launcher: string,
  provider: string,
  binding: string,
): Promise<void> {
  if (
    ![
      ...Object.keys(PROVIDER_CONFIGURATION),
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
  options: ReadOpenedRegularFileOptions & { encoding: BufferEncoding },
): string | null;
export function readOpenedRegularFile(
  file: string,
  options?: ReadOpenedRegularFileOptions & { encoding?: undefined },
): Buffer | null;
export function readOpenedRegularFile(
  file: string,
  {
    encoding,
    maxBytes = 2 * 1024 * 1024,
    rejectLinks = false,
    rejectHardLinks = false,
  }: ReadOpenedRegularFileOptions = {},
): Buffer | string | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    fail("the opened file byte limit is invalid");
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
    if (rejectHardLinks && stat.nlink !== 1) fail("the opened file has multiple links");
    if (rejectLinks) {
      const named = fs.lstatSync(file);
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.dev !== stat.dev ||
        named.ino !== stat.ino
      )
        fail("the opened file path is a link or changed identity");
    }
    if (stat.size > maxBytes) fail("the opened relay or diagnostic file exceeds its limit");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      // Read at most one byte beyond the limit, even if the file grows after fstat.
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - bytes + 1));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > maxBytes) fail("the opened relay or diagnostic file exceeds its limit");
      chunks.push(chunk.subarray(0, count));
    }
    const content = Buffer.concat(chunks, bytes);
    return encoding ? content.toString(encoding) : content;
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function writeNativeGatewayConfig(
  installRoot: string,
  runRoot: string,
  hermesRuntime?: NativeRuntimeLaunchLease,
  options: NativeGatewayOptions | (() => Promise<NativeGatewayOptions>) = {},
  gatewaySession?: NativeGatewaySession,
): Promise<string> {
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
  // Validate the installed template before a deferred profile can probe the MXC host.
  if (typeof options === "function") {
    const validated = renderNativeGatewayConfig(template, installation, hermesRuntime);
    gatewaySession?.configuration(validated);
  }
  const selected = typeof options === "function" ? await options() : options;
  const rendered = renderNativeGatewayConfig(template, installation, hermesRuntime, selected);
  const output = path.join(resolvedRunRoot, "mxc-gateway.toml");
  fs.writeFileSync(output, gatewaySession ? gatewaySession.configuration(rendered) : rendered, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  gatewaySession?.preflightConfiguration(output);
  return output;
}

export function renderNativeGatewayConfig(
  template: string,
  installRoot: string,
  hermesRuntime?: NativeRuntimeLaunchLease,
  options: NativeGatewayOptions = {},
): string {
  const profile = nativeGatewayProfile(options);
  const compatibility = hermesRuntime ? nativeHermesCompatibility(hermesRuntime) : null;
  if (
    compatibility &&
    path.win32.normalize(installRoot).toLowerCase() !== compatibility.installation.toLowerCase()
  )
    fail("the Hermes gateway and runtime lease name different installations");
  // JSON uses TOML-compatible basic-string escapes, except for its unescaped DEL character.
  const executable = JSON.stringify(
    compatibility?.executor ?? path.join(installRoot, "mxc", "wxc-exec.exe"),
  ).replace(/\u007f/gu, "\\u007f");
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
      if (
        inMxc &&
        /^\s*(?:pc_network_allow|pc_allow_local_network|pc_host_console|pc_loopback_ports|egress_proxy|egress_proxy_addr|pc_relay_spawner_path|pc_relay_target_port)\s*=/u.test(
          line,
        )
      )
        fail("the gateway template cannot override session-owned settings");
      if (!inMxc || !/^\s*wxc_exec_path\s*=/u.test(line)) return line;
      const setting = /^(\s*wxc_exec_path\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/u.exec(
        line,
      );
      if (!setting) fail("the gateway template executable path must be a single-line TOML string");
      executablePaths += 1;
      return [`${setting[1]}${executable}${setting[2]}`, ...profile].join(
        template.includes("\r\n") ? "\r\n" : "\n",
      );
    })
    .join(template.includes("\r\n") ? "\r\n" : "\n");
  if (sections !== 1 || executablePaths !== 1)
    fail("the gateway template must declare one MXC section and executable path");
  return rendered;
}

function nativeGatewayProfile(options: NativeGatewayOptions): string[] {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "network" && key !== "hostConsole") ||
    options.network === null ||
    (options.hostConsole !== undefined && typeof options.hostConsole !== "boolean")
  )
    fail("the gateway profile is invalid");
  const network = options.network ?? { kind: "deny" };
  if (
    !network ||
    typeof network !== "object" ||
    Array.isArray(network) ||
    !["deny", "personal", "loopback", "supervised"].includes(network.kind) ||
    Object.keys(network).some(
      (key) => key !== "kind" && !(network.kind === "loopback" && key === "ports"),
    )
  )
    fail("the gateway profile network is invalid");
  if (network.kind === "supervised") {
    if (options.hostConsole) fail("the supervised gateway profile cannot grant the host console");
    // Current OpenShell selects its governed proxy; local services use declared
    // per-sandbox pipes. Legacy direct-network fields are not in this schema.
    return ["pc_allow_local_network = false"];
  }
  const ports = network.kind === "loopback" ? validatedLoopbackPorts(network.ports) : [];
  const personal = network.kind === "personal";
  // Each launcher owns a private gateway. Profiles never enter per-sandbox driver_config.
  return [
    `pc_network_allow = ${personal}`,
    `pc_allow_local_network = ${personal}`,
    `pc_host_console = ${options.hostConsole ?? false}`,
    `pc_loopback_ports = ${JSON.stringify(ports)}`,
  ];
}
