// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { isPrivateIp } from "../../private-networks";
import { isValidProviderName } from "../../../../nemoclaw/dist/shared/sandbox-name.cjs";
import { normalizeProviderBaseUrl } from "../../core/provider-endpoint";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { createManagedProviderAdapter } from "../../adapters/openshell/managed-provider-adapter";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import { captureSanitizedResolvedOpenshell } from "../../adapters/openshell/sanitized-capture";
import {
  observeCreatedOpenShellSandboxId,
  settleCreatedOpenShellSandboxId,
} from "../../adapters/openshell/sandbox-identity";
import {
  readSandboxConfig,
  resolveAgentConfig,
  setOpenClawConfigValues,
} from "../../sandbox/config";
import { readNativeCredentialHandle } from "../../actions/inference-set-provider";
import { boundCustomNativeProfile, customNativeProvider } from "./custom";
import { normalizeNativeProviderAttachment } from "./contract";
import { nativeProviderLifecycle } from "./index";
import {
  ensureNativeProvider,
  ensureNativeProviderAttached,
  verifyNativeProviderAttachment,
  type NativeProviderAttachment,
} from "./lifecycle";

export type BlueprintNativeSelection = Readonly<{
  gatewayName: string;
  sandboxName: string;
  provider: string;
  model: string;
  api: string;
  endpointUrl?: string;
  requiresCredential?: boolean;
}>;

/** Authority belongs to this blueprint run, not the managed sandbox registry. */
export type BlueprintNativeReceipt = BlueprintNativeSelection &
  Readonly<{
    schemaVersion: 1;
    endpointUrl: string;
    api: "openai-completions" | "anthropic-messages";
    createAttemptNonce: string;
    credentialEnv: string | null;
    timeoutSeconds?: number;
    providerAttachment?: NativeProviderAttachment;
    sandboxId?: string;
    configPublished?: true;
  }>;

export type BlueprintNativeCreateInput = BlueprintNativeSelection &
  Readonly<{
    credentialValue: string;
    timeoutSeconds?: number;
    persist: (receipt: BlueprintNativeReceipt) => void;
    createSandbox: (providerName: string, createAttemptNonce: string) => Promise<void>;
    prepareSandboxPolicy: () => Promise<void>;
  }>;

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;

/** Recheck the plugin's existing public, literal-address admission at the host boundary. */
function admitBlueprintSelection(input: BlueprintNativeSelection): {
  endpointUrl: string;
  api: BlueprintNativeReceipt["api"];
} {
  if (
    typeof input.gatewayName !== "string" ||
    typeof input.sandboxName !== "string" ||
    typeof input.provider !== "string" ||
    !NAME.test(input.gatewayName) ||
    !NAME.test(input.sandboxName) ||
    !isValidProviderName(input.provider) ||
    typeof input.model !== "string" ||
    !input.model ||
    input.model.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(input.model) ||
    !["openai-completions", "anthropic-messages"].includes(input.api)
  )
    throw new Error("Invalid blueprint native inference selection.");
  const endpoint = new URL(input.endpointUrl ?? "");
  const address = endpoint.hostname.replace(/^\[|\]$/gu, "");
  if (
    unsafeEndpointUrlViolation(input.endpointUrl ?? "") ||
    /%2f|%5c|%2e/iu.test(input.endpointUrl ?? "") ||
    !isIP(address) ||
    isPrivateIp(address)
  )
    throw new Error("Blueprint native inference requires its admitted public endpoint address.");
  const api = input.api as BlueprintNativeReceipt["api"];
  const endpointUrl = normalizeProviderBaseUrl(
    endpoint.href,
    api === "anthropic-messages" ? "anthropic" : "openai",
  );
  // The existing custom profile owner checks URL syntax, encoded path escapes, and exact IPs.
  customNativeProvider({
    provider:
      api === "anthropic-messages" ? "compatible-anthropic-endpoint" : "compatible-endpoint",
    endpointUrl,
    api,
    credentialEnv: "OPENAI_API_KEY",
    allowedIps: [address],
  });
  return { endpointUrl, api };
}

function blueprintProfile(receipt: BlueprintNativeReceipt) {
  const admitted = admitBlueprintSelection(receipt);
  if (
    receipt.schemaVersion !== 1 ||
    admitted.endpointUrl !== receipt.endpointUrl ||
    !/^[a-f0-9]{62}$/u.test(receipt.createAttemptNonce) ||
    (receipt.credentialEnv !== null && receipt.credentialEnv !== "OPENAI_API_KEY") ||
    (receipt.timeoutSeconds !== undefined &&
      (!Number.isSafeInteger(receipt.timeoutSeconds) || receipt.timeoutSeconds <= 0))
  )
    throw new Error("Invalid blueprint native inference receipt.");
  if (receipt.credentialEnv !== null && new URL(receipt.endpointUrl).protocol !== "https:")
    throw new Error("Blueprint inference endpoints with credentials require HTTPS.");
  const definition = customNativeProvider({
    provider:
      receipt.api === "anthropic-messages"
        ? "compatible-anthropic-endpoint"
        : "compatible-endpoint",
    endpointUrl: receipt.endpointUrl,
    api: receipt.api,
    credentialEnv: "OPENAI_API_KEY",
    allowedIps: [new URL(receipt.endpointUrl).hostname.replace(/^\[|\]$/gu, "")],
  });
  const template = nativeProviderLifecycle(definition).nativeProviderProfilePath();
  const document = YAML.parse(boundCustomNativeProfile(definition, template));
  // The run nonce prevents a same-name provider from masquerading as this operation's provider.
  document.id = `nemoclaw-blueprint-${createHash("sha256")
    .update(
      JSON.stringify({
        endpoint: receipt.endpointUrl,
        api: receipt.api,
        credentialEnv: receipt.credentialEnv,
        nonce: receipt.createAttemptNonce,
      }),
    )
    .digest("hex")
    .slice(0, 32)}-v1`;
  document.credentials =
    receipt.credentialEnv === null
      ? []
      : document.credentials.map((credential: Record<string, unknown>) => ({
          ...credential,
          env_vars: [receipt.credentialEnv],
        }));
  const source = YAML.stringify(document);
  const contract = parseCheckedInProviderProfileContract(source);
  if (!contract) throw new Error("Blueprint native profile could not be validated.");
  return {
    source,
    contract,
    profile: {
      profileId: document.id as string,
      providerName: receipt.provider,
      credentialEnv: receipt.credentialEnv,
      label: "blueprint",
      profilePath: "",
    },
  };
}

function capture(args: string[], options?: Record<string, unknown>): string {
  const result = captureSanitizedResolvedOpenshell(args, {
    ...options,
    ignoreError: true,
    includeStreams: true,
    includeStderr: true,
    timeout: typeof options?.timeout === "number" ? options.timeout : 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error || result.signal)
    throw new Error("Blueprint native sandbox identity could not be inspected.");
  return result.stdout ?? "";
}

const defaultDependencies = {
  adapter: createManagedProviderAdapter,
  capture,
  writeConfig: setOpenClawConfigValues,
  readHandle: readNativeCredentialHandle,
};
type Dependencies = typeof defaultDependencies;

export function requireCreatedSandbox(
  receipt: BlueprintNativeReceipt,
  deps: Dependencies = defaultDependencies,
): void {
  const observed = observeCreatedOpenShellSandboxId(
    { ...receipt, runCaptureOpenshell: deps.capture },
    15_000,
  );
  if (observed.state !== "matched" || observed.sandboxId !== receipt.sandboxId)
    throw new Error("Blueprint sandbox identity changed; no later resource was modified.");
}

const MAX_BLUEPRINT_RECEIPT_BYTES = 1024 * 1024;

function readBlueprintRunPlan(file: string, directory: fs.Stats): unknown | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number")
    throw new Error("Blueprint run receipts require no-follow file reads.");
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_BLUEPRINT_RECEIPT_BYTES) return null;
    const requireSamePath = (): void => {
      const currentDirectory = fs.lstatSync(path.dirname(file));
      const currentFile = fs.lstatSync(file);
      if (
        !currentDirectory.isDirectory() ||
        currentDirectory.dev !== directory.dev ||
        currentDirectory.ino !== directory.ino ||
        !currentFile.isFile() ||
        currentFile.dev !== before.dev ||
        currentFile.ino !== before.ino
      )
        throw new Error("Blueprint run receipt changed while it was read.");
    };
    requireSamePath();
    const contents = Buffer.alloc(MAX_BLUEPRINT_RECEIPT_BYTES + 1);
    let offset = 0;
    while (offset < contents.length) {
      const count = fs.readSync(descriptor, contents, offset, contents.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    requireSamePath();
    if (
      offset > MAX_BLUEPRINT_RECEIPT_BYTES ||
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Blueprint run receipt changed while it was read.");
    try {
      return JSON.parse(contents.subarray(0, offset).toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Recover only this plugin's nonsecret run receipts; live identities remain authoritative. */
export function findBlueprintNativeReceipt(
  requested: BlueprintNativeSelection,
): BlueprintNativeReceipt | null {
  const runs = path.join(os.homedir(), ".nemoclaw/state/runs");
  if (!fs.existsSync(runs)) return null;
  const matches = new Map<string, BlueprintNativeReceipt>();
  for (const name of fs.readdirSync(runs)) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(name)) continue;
    const directory = path.join(runs, name);
    const directoryMetadata = fs.lstatSync(directory);
    if (!directoryMetadata.isDirectory()) continue;
    const file = path.join(directory, "plan.json");
    const plan = readBlueprintRunPlan(file, directoryMetadata);
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) continue;
    const receipt = (plan as Record<string, unknown>).native_inference as
      | BlueprintNativeReceipt
      | undefined;
    if (
      receipt?.gatewayName !== requested.gatewayName ||
      receipt?.sandboxName !== requested.sandboxName
    )
      continue;
    blueprintProfile(receipt);
    if (!receipt.providerAttachment || !receipt.sandboxId || receipt.configPublished !== true)
      throw new Error(
        "An incomplete blueprint run owns this sandbox selection. Preserve its receipt for recovery.",
      );
    matches.set(JSON.stringify(receipt), receipt);
  }
  if (matches.size > 1)
    throw new Error("Conflicting blueprint native inference receipts require recovery.");
  return matches.values().next().value ?? null;
}

/** Reuse requires completed configuration publication and current resource authority. */
export async function observeBlueprintCreatedInference(
  requested: BlueprintNativeSelection,
  receipt: BlueprintNativeReceipt,
  deps: Dependencies = defaultDependencies,
): Promise<string> {
  if (receipt.configPublished !== true)
    throw new Error(
      "Blueprint native configuration publication is incomplete. Preserve its receipt for recovery.",
    );
  return verifyBlueprintCreatedInference(requested, receipt, deps);
}

/** Verify the generated profile and both immutable resource identities without mutations. */
async function verifyBlueprintCreatedInference(
  requested: BlueprintNativeSelection,
  receipt: BlueprintNativeReceipt,
  deps: Dependencies = defaultDependencies,
): Promise<string> {
  const admitted = admitBlueprintSelection({
    ...requested,
    endpointUrl: requested.endpointUrl ?? receipt.endpointUrl,
  });
  if (
    requested.gatewayName !== receipt.gatewayName ||
    requested.sandboxName !== receipt.sandboxName ||
    requested.provider !== receipt.provider ||
    requested.model !== receipt.model ||
    admitted.api !== receipt.api ||
    admitted.endpointUrl !== receipt.endpointUrl ||
    !receipt.providerAttachment ||
    !receipt.sandboxId ||
    (requested.requiresCredential === true && receipt.credentialEnv === null)
  )
    throw new Error("Blueprint native receipt does not match the requested inference selection.");
  const { profile, contract } = blueprintProfile(receipt);
  const expected = normalizeNativeProviderAttachment(receipt.providerAttachment, profile);
  if (!expected) throw new Error("Invalid blueprint native provider receipt.");
  const adapter = deps.adapter();
  const target = { kind: "named", gatewayName: receipt.gatewayName } as const;
  requireCreatedSandbox(receipt, deps);
  const inspected = await adapter.inspectProviderProfile({
    target,
    profileType: profile.profileId,
    expectedProfile: contract,
  });
  if (!inspected.ok) throw new Error("Blueprint native provider profile changed.");
  await verifyNativeProviderAttachment({
    profile,
    adapter,
    target,
    sandboxName: receipt.sandboxName,
    expected,
    requireUnexpiredCredential: true,
  });
  requireCreatedSandbox(receipt, deps);
  return JSON.stringify({
    gatewayName: receipt.gatewayName,
    sandboxName: receipt.sandboxName,
    provider: receipt.provider,
    model: receipt.model,
    endpointUrl: receipt.endpointUrl,
    api: receipt.api,
    createAttemptNonce: receipt.createAttemptNonce,
    sandboxId: receipt.sandboxId,
    providerAttachment: expected,
    credentialEnv: receipt.credentialEnv,
    timeoutSeconds: receipt.timeoutSeconds,
  });
}

/** Create only new resources, recording ownership before each later effect. */
export async function createBlueprintNativeInference(
  input: BlueprintNativeCreateInput,
  deps: Dependencies = defaultDependencies,
): Promise<{ identity: string; observe: () => Promise<string> }> {
  const admitted = admitBlueprintSelection(input);
  let receipt: BlueprintNativeReceipt = {
    gatewayName: input.gatewayName,
    sandboxName: input.sandboxName,
    provider: input.provider,
    model: input.model,
    ...admitted,
    schemaVersion: 1,
    createAttemptNonce: randomBytes(31).toString("hex"),
    credentialEnv: input.credentialValue ? "OPENAI_API_KEY" : null,
    ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
  };
  const { profile, source } = blueprintProfile(receipt);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-profile-"));
  try {
    const profilePath = path.join(directory, "profile.yaml");
    fs.writeFileSync(profilePath, source, { mode: 0o600 });
    input.persist(receipt);
    await input.createSandbox(receipt.provider, receipt.createAttemptNonce);
    const sandboxId = settleCreatedOpenShellSandboxId({
      ...receipt,
      runCaptureOpenshell: deps.capture,
      sleep: (ms) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      },
    });
    receipt = { ...receipt, sandboxId };
    input.persist(receipt);
    await input.prepareSandboxPolicy();
    requireCreatedSandbox(receipt, deps);
    const providerAttachment = await ensureNativeProvider({
      profile: { ...profile, profilePath },
      adapter: deps.adapter(),
      target: { kind: "named", gatewayName: receipt.gatewayName },
      credentialValue: input.credentialValue || null,
    });
    receipt = { ...receipt, providerAttachment };
    input.persist(receipt);
    requireCreatedSandbox(receipt, deps);
    await ensureNativeProviderAttached({
      profile,
      adapter: deps.adapter(),
      target: { kind: "named", gatewayName: receipt.gatewayName },
      sandboxName: receipt.sandboxName,
      expected: providerAttachment,
    });
    const verify = () => verifyBlueprintCreatedInference(input, receipt, deps);
    await verify();
    let apiKey = "unused";
    if (receipt.credentialEnv) {
      apiKey = await deps.readHandle(receipt.sandboxName, receipt.gatewayName, {
        script:
          'if [ -z "${OPENAI_API_KEY:-}" ]; then printf "%s\\n" NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING >&2; exit 75; fi; printf "%s" "$OPENAI_API_KEY"',
        pattern: /^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_OPENAI_API_KEY$/u,
        providerLabel: "blueprint",
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
    }
    await verify();
    // Awaiting verification yields before this synchronous configuration write.
    requireCreatedSandbox(receipt, deps);
    deps.writeConfig(
      receipt.sandboxName,
      [
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: receipt.endpointUrl,
            api: receipt.api,
            apiKey,
            ...(receipt.credentialEnv === null ? { authHeader: false } : {}),
            ...(receipt.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: receipt.timeoutSeconds }),
            models: [{ id: receipt.model, name: receipt.model }],
          },
        },
        { dotpath: "agents.defaults.model.primary", value: `inference/${receipt.model}` },
      ],
      receipt.gatewayName,
    );
    const identity = await verify();
    receipt = { ...receipt, configPublished: true };
    input.persist(receipt);
    return { identity, observe: () => observeBlueprintCreatedInference(input, receipt, deps) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Update only the selected OpenClaw provider timeout after independent authority checks. */
export async function reconcileBlueprintNativeTimeout(
  requested: BlueprintNativeSelection & Readonly<{ timeoutSeconds: number }>,
  observe: () => Promise<string>,
  revalidate: () => void,
  deps = {
    readConfig: readSandboxConfig,
    configTarget: resolveAgentConfig,
    writeConfig: setOpenClawConfigValues,
  },
): Promise<void> {
  if (!Number.isSafeInteger(requested.timeoutSeconds) || requested.timeoutSeconds <= 0)
    throw new Error("Invalid blueprint inference timeout.");
  const identity = await observe();
  const target = deps.configTarget(requested.sandboxName);
  if (target.agentName !== "openclaw") throw new Error("Blueprint inference requires OpenClaw.");
  const config = deps.readConfig(requested.sandboxName, target, requested.gatewayName) as {
    agents?: { defaults?: { model?: { primary?: unknown } } };
    models?: { providers?: Record<string, unknown> };
  };
  const primary = config?.agents?.defaults?.model?.primary;
  if (typeof primary !== "string")
    throw new Error("Native inference model configuration is missing.");
  const separator = primary.indexOf("/");
  const providerKey = primary.slice(0, separator);
  const configured = config?.models?.providers?.[providerKey];
  if (
    separator <= 0 ||
    !/^[a-zA-Z0-9_-]+$/u.test(providerKey) ||
    primary.slice(separator + 1) !== requested.model ||
    !configured ||
    typeof configured !== "object" ||
    Array.isArray(configured) ||
    (configured as Record<string, unknown>).api !== requested.api ||
    (requested.endpointUrl &&
      (typeof (configured as Record<string, unknown>).baseUrl !== "string" ||
        normalizeProviderBaseUrl(
          (configured as Record<string, unknown>).baseUrl as string,
          requested.api === "anthropic-messages" ? "anthropic" : "openai",
        ) !==
          normalizeProviderBaseUrl(
            requested.endpointUrl,
            requested.api === "anthropic-messages" ? "anthropic" : "openai",
          )))
  )
    throw new Error("Native inference configuration does not match the blueprint selection.");
  if (identity !== (await observe()))
    throw new Error("Native inference identity changed before timeout update.");
  if ((configured as Record<string, unknown>).timeoutSeconds !== requested.timeoutSeconds) {
    revalidate();
    deps.writeConfig(
      requested.sandboxName,
      [
        {
          dotpath: `models.providers.${providerKey}.timeoutSeconds`,
          value: requested.timeoutSeconds,
        },
      ],
      requested.gatewayName,
    );
  }
  if (identity !== (await observe()))
    throw new Error("Native inference identity changed during timeout update.");
}
