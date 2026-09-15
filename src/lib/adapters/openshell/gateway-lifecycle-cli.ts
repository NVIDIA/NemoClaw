// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../../../nemoclaw/dist/shared/sandbox-name.cjs";
import { withSelectedOpenShellCommandOptions } from "./command-argv";
import { assertNoOpenShellGatewayEndpointOverride } from "./gateway-scope";
import type { ObserveOpenShellGatewayRequest } from "./gateway-observer";
import type {
  OpenShellGatewayLifecycle,
  OpenShellGatewayMutationResult,
} from "./gateway-lifecycle";
import type { OpenShellSandboxError } from "./sandbox-observer";
import {
  classifyCliOpenShellCommandError,
  type CaptureOpenShellCommand,
} from "./sandbox-observer-cli";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";

const messages = {
  authentication: "OpenShell could not authorize the gateway operation.",
  command: "The OpenShell gateway operation failed.",
  schema: "The OpenShell CLI and gateway schemas do not match.",
  timeout: "The OpenShell gateway operation timed out; its result is unknown.",
};
const invalid: OpenShellSandboxError = {
  kind: "command",
  reason: "invalid_request",
  message: "Invalid OpenShell gateway target, endpoint, or timeout.",
};

function isExplicitGatewayRegistrationAbsence(output: string, gatewayLabel: string): boolean {
  const clean = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  const escapedLabel = gatewayLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const namedGateway = `(?:['"]${escapedLabel}['"]|${escapedLabel})`;
  const structuredNotFound =
    `(?:status:\\s*['"]?NotFound['"]?|` + `code:\\s*['"]Some requested entity was not found['"])`;
  const completeDiagnostic = clean
    .trim()
    .replace(/^Error:\s*/iu, "")
    .replace(/^×\s*/u, "");
  if (
    /^gateway not found\.?$/iu.test(completeDiagnostic) ||
    /^No active gateway\.?$/iu.test(completeDiagnostic) ||
    new RegExp(
      `^${structuredNotFound},\\s*message:\\s*['"]gateway\\s+(?:does not exist|not found)['"]\\.?$`,
      "iu",
    ).test(completeDiagnostic)
  ) {
    return true;
  }
  return (
    new RegExp(`^Unknown gateway ['"]${escapedLabel}['"]\\.`, "iu").test(completeDiagnostic) ||
    new RegExp(`^No gateway metadata found for ${namedGateway}\\.?$`, "iu").test(
      completeDiagnostic,
    ) ||
    new RegExp(`^gateway\\s+${namedGateway}\\s+(?:does not exist|not found)\\.?$`, "iu").test(
      completeDiagnostic,
    ) ||
    new RegExp(
      `^${structuredNotFound},\\s*message:\\s*['"]gateway\\s+${escapedLabel}\\s+(?:does not exist|not found)['"]\\.?$`,
      "iu",
    ).test(completeDiagnostic)
  );
}

export function createCliOpenShellGatewayLifecycle(
  capture: CaptureOpenShellCommand,
): OpenShellGatewayLifecycle {
  async function invoke(request: ObserveOpenShellGatewayRequest, args: string[]) {
    const name = request.target.gatewayName;
    if (
      !isValidName(name) ||
      (request.runtimeSelection && request.runtimeSelection.gatewayName !== name) ||
      (request.timeoutMs !== undefined &&
        (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0))
    ) {
      return { result: null, error: invalid };
    }
    let invoked = false;
    try {
      if (!request.runtimeSelection) assertNoOpenShellGatewayEndpointOverride();
      invoked = true;
      const result = await capture(
        args,
        withSelectedOpenShellCommandOptions(
          {
            ignoreError: true,
            includeStderr: true,
            includeStreams: true,
            timeout: request.timeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          } as const,
          request.runtimeSelection,
        ),
      );
      const printedError = /^\s*Error:/im.test(result.output);
      return {
        result,
        error: classifyCliOpenShellCommandError(
          printedError && result.status === 0 ? { ...result, status: 1 } : result,
          messages,
        ),
      };
    } catch {
      return {
        result: invoked ? { status: null, output: "", stdout: "", stderr: "" } : null,
        error: {
          kind: "command",
          reason: invoked ? "failed" : "invalid_request",
          message: messages.command,
        } as OpenShellSandboxError,
      };
    }
  }
  async function mutate(
    request: ObserveOpenShellGatewayRequest,
    operation: "select" | "add" | "remove" | "destroy",
    args: string[],
  ): Promise<OpenShellGatewayMutationResult> {
    const { result, error } = await invoke(request, args);
    if (!error) return { ok: true, state: "completed" };
    if (
      (operation === "select" || operation === "remove" || operation === "destroy") &&
      (error.kind === "command" ||
        (error.kind === "transport" && error.reason === "unreachable")) &&
      isExplicitGatewayRegistrationAbsence(result?.output ?? "", request.target.gatewayName)
    ) {
      const registry = await listGateways(request);
      if (registry.ok && !registry.names.includes(request.target.gatewayName)) {
        if (operation !== "select") return { ok: true, state: "absent" };
        return {
          ok: false,
          error: {
            kind: "command",
            reason: "failed",
            message: "OpenShell cannot select a gateway that is not registered.",
          },
          unsupported: false,
          ambiguous: false,
        };
      }
    }
    // Only the installed CLI's explicit missing verb permits the legacy operation.
    // Authentication, transport and timeout classification takes precedence over matching prose.
    const unsupported =
      operation === "remove" &&
      error.kind === "command" &&
      /^(?:error:\s*)?(?:unrecognized subcommand ['"]remove['"]|unknown command ['"]remove['"])(?:\r?\n|$)/im.test(
        result?.output.trim() ?? "",
      );
    return {
      ok: false,
      error,
      unsupported,
      ambiguous: error.kind === "timeout" || error.kind === "transport" || result?.status === null,
    };
  }
  async function listGateways(
    request: ObserveOpenShellGatewayRequest,
  ): Promise<import("./gateway-lifecycle").OpenShellGatewayRegistryResult> {
    const { result, error } = await invoke(request, ["gateway", "list", "-o", "json"]);
    if (error) return { ok: false, error };
    try {
      const values: unknown = JSON.parse(result?.stdout ?? result?.output ?? "");
      if (
        !Array.isArray(values) ||
        values.some((entry) => !entry || typeof entry !== "object" || !isValidName(entry.name))
      )
        throw new Error("Invalid registry");
      const names = values.map((entry: { name: string }) => entry.name);
      if (new Set(names).size !== names.length) throw new Error("Duplicate registry entry");
      return { ok: true, names };
    } catch {
      return {
        ok: false,
        error: { kind: "schema", message: "OpenShell returned an unrecognized gateway registry." },
      };
    }
  }
  return {
    async supportsLegacyLifecycle(request) {
      const { result, error } = await invoke(request, ["gateway", "--help"]);
      if (error) return false;
      const help = result?.output.replace(/\x1b\[[0-9;]*m/gu, "") ?? "";
      return /\bstart\b/.test(help) && /\bgateway destroy\b/i.test(help);
    },
    selectGateway: (request) =>
      mutate(request, "select", ["gateway", "select", request.target.gatewayName]),
    registerGateway: (request) => {
      let endpoint: URL;
      try {
        endpoint = new URL(request.endpoint);
      } catch {
        return Promise.resolve({ ok: false, error: invalid, unsupported: false, ambiguous: false });
      }
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      ) {
        return Promise.resolve({ ok: false, error: invalid, unsupported: false, ambiguous: false });
      }
      return mutate(request, "add", [
        "gateway",
        "add",
        request.endpoint,
        "--local",
        "--name",
        request.target.gatewayName,
      ]);
    },
    removeGateway: (request) =>
      mutate(request, "remove", ["gateway", "remove", request.target.gatewayName]),
    destroyGateway: (request) =>
      mutate(request, "destroy", ["gateway", "destroy", "-g", request.target.gatewayName]),
    listGateways,
  };
}

function capturedStream(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  throw new Error("Invalid captured OpenShell stream.");
}

/** Adapt the existing buffered CLI runner only inside the transport boundary. */
export function createCliOpenShellGatewayLifecycleFromRunner(
  run: (
    args: string[],
    options?: Record<string, unknown>,
  ) => { status: number | null; stdout?: unknown; stderr?: unknown; error?: Error },
): OpenShellGatewayLifecycle {
  return createCliOpenShellGatewayLifecycle((args, options) => {
    const result = run(args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    });
    const stdout = capturedStream(result.stdout);
    const stderr = capturedStream(result.stderr);
    return {
      status: result.status,
      stdout,
      stderr,
      output: [stdout, stderr].filter(Boolean).join("\n"),
      error: result.error,
    };
  });
}
