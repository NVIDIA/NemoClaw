// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { INFERENCE_CURL_DIAGNOSTIC_SCRIPT } from "./curl-policy-denial.ts";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { inspectInferenceProviderProfile } from "../../../src/lib/adapters/openshell/provider-profile.ts";
import { createExtraGatewayProvider } from "./gateway-providers.ts";
import type { HostCliClient } from "./clients/host.ts";
import { resultText } from "./clients/command.ts";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import { normalizeNativeLocalProviderAttachment } from "../../../src/lib/inference/native-local/contract.ts";
import { recordedNativeProviderAttachment } from "../../../src/lib/inference/native-provider/recorded-selection.ts";
import { buildSandboxInferenceChatCommand } from "./inference-adapter.ts";
import { parseCliOpenShellProviderMetadata } from "../../../src/lib/adapters/openshell/provider-metadata-cli.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";

/** Read the published selection again after a failed backup or successful recreation. */
export function registeredCompatibleChatCommand(
  sandboxName: string,
  model: string,
  payload: string,
): [string, ...string[]] {
  const entry = getSandbox(sandboxName);
  const local = normalizeNativeLocalProviderAttachment(entry?.nativeLocalProviderAttachment);
  const hosted = entry && recordedNativeProviderAttachment(entry);
  if (
    entry?.provider !== "compatible-endpoint" ||
    entry.model !== model ||
    (entry.nativeLocalProviderAttachment !== undefined && !local) ||
    Boolean(local && hosted) ||
    (local &&
      (local.sandboxName !== sandboxName ||
        local.gatewayName !== entry.gatewayName ||
        local.provider !== entry.provider ||
        local.agent !== (entry.agent === "deepagents" ? undefined : entry.agent) ||
        (local.api ?? "openai-completions") !== "openai-completions")) ||
    (hosted &&
      (hosted.custom?.api !== "openai-completions" ||
        hosted.custom.credentialEnv !== "COMPATIBLE_API_KEY")) ||
    (!local && !hosted)
  )
    throw new Error("The registered compatible inference selection does not match this probe");
  return buildSandboxInferenceChatCommand(
    payload,
    entry.provider,
    (local ?? hosted)!.endpointUrl,
    60,
  );
}

/** Keep HTTP responses and native connect denials visible without outgoing headers. */
export function registeredCompatibleResponseCommand(
  sandboxName: string,
  model: string,
  payload: string,
  followRedirect: boolean,
): [string, ...string[]] {
  const command = registeredCompatibleChatCommand(sandboxName, model, payload);
  command[2] = command[2].replace(
    "exec curl -fsS",
    `${INFERENCE_CURL_DIAGNOSTIC_SCRIPT}; curl -sS --include${followRedirect ? " --location --post302 --max-redirs 3" : ""}`,
  );
  return command;
}

/** Bind the sibling snapshot to the real provider revision and attachment. */
export async function readRegisteredLocalRoute(
  sandbox: SandboxClient,
  sandboxName: string,
  artifactName: string,
) {
  const entry = getSandbox(sandboxName);
  const receipt = normalizeNativeLocalProviderAttachment(entry?.nativeLocalProviderAttachment);
  if (
    !receipt ||
    receipt.sandboxName !== sandboxName ||
    receipt.gatewayName !== entry?.gatewayName ||
    receipt.provider !== entry.provider ||
    receipt.agent !== (entry.agent === "deepagents" ? undefined : entry.agent)
  )
    throw new Error("The sibling has no matching native local inference receipt");
  const options = { env: buildAvailabilityProbeEnv(), timeoutMs: 30_000 };
  const provider = await sandbox.openshell(
    ["provider", "get", "-g", receipt.gatewayName, receipt.providerName],
    { ...options, artifactName: `${artifactName}-provider` },
  );
  const attachment = await sandbox.openshell(
    ["sandbox", "provider", "list", "-g", receipt.gatewayName, sandboxName],
    { ...options, artifactName: `${artifactName}-attachment` },
  );
  const metadata =
    provider.exitCode === 0 ? parseCliOpenShellProviderMetadata(provider.stdout) : null;
  const ok =
    metadata?.name === receipt.providerName &&
    metadata.type === receipt.profileId &&
    metadata.revision?.id === receipt.providerId &&
    metadata.configKeys.length === 0 &&
    metadata.credentialKeys.length === 1 &&
    metadata.credentialKeys[0] === receipt.credentialEnv &&
    attachment.exitCode === 0 &&
    attachment.stdout.split(/\s+/u).includes(receipt.providerName);
  return {
    exitCode: ok ? 0 : 1,
    stdout: JSON.stringify({ provider: entry!.provider, model: entry!.model, receipt }),
    stderr: ok ? "" : "Sibling native provider identity or attachment mismatch",
  };
}

export const OPERATOR_SWITCH_API_KEY = "openclaw-operator-switch-synthetic-credential";
export const OPERATOR_SWITCH_PROVIDER = "e2e-operator-inference";
export const OPERATOR_SWITCH_CREDENTIAL_ENV = "NEMOCLAW_E2E_OPERATOR_TOKEN";

/** The fixture owns only the provider IDs it creates in its private test gateway. */
export function operatorInferenceSwitchFixture(
  host: HostCliClient,
  options: {
    home: string;
    env: NodeJS.ProcessEnv;
    endpointUrl: string;
    credentialValue: string;
    sandboxName: string;
    model: string;
  },
) {
  const endpoint = new URL(options.endpointUrl);
  if (!isIPv4(endpoint.hostname))
    throw new Error("Operator fixture requires the observed IPv4 host");
  const profileId = `e2e-operator-${randomUUID()}`;
  const profilePath = path.join(options.home, `${profileId}.json`);
  const profile = {
    id: profileId,
    display_name: "E2E operator inference",
    description: "Synthetic switch fixture",
    category: "inference",
    credentials: [
      {
        name: "api_key",
        env_vars: [OPERATOR_SWITCH_CREDENTIAL_ENV],
        required: true,
        auth_style: "bearer",
        header_name: "authorization",
        query_param: "",
      },
    ],
    endpoints: [
      {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        protocol: "rest",
        enforcement: "enforce",
        allowed_ips: [`${endpoint.hostname}/32`],
        rules: [
          { allow: { method: "GET", path: `${endpoint.pathname}/models` } },
          { allow: { method: "POST", path: `${endpoint.pathname}/chat/completions` } },
        ],
      },
    ],
    binaries: [
      "/usr/bin/python3",
      "/usr/bin/python3.13",
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/usr/local/bin/curl",
      "/usr/bin/curl",
    ],
    inference_capable: true,
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile), { flag: "wx", mode: 0o600 });
  const env = { ...options.env, [OPERATOR_SWITCH_CREDENTIAL_ENV]: options.credentialValue };
  let ownedId: string | undefined;
  let originalDigest: string | undefined;
  const run = (args: string[], artifactName: string) =>
    host.command(host.openshellCommandPath, [...args, "-g", "nemoclaw"], {
      artifactName,
      env: options.env,
      timeoutMs: 60_000,
      redactionValues: [options.credentialValue],
    });
  const inspect = async () => {
    const result = await run(
      ["provider", "get", OPERATOR_SWITCH_PROVIDER],
      "operator-provider-identity",
    );
    const provider =
      result.exitCode === 0 ? parseCliOpenShellProviderMetadata(result.stdout) : null;
    if (
      provider?.name !== OPERATOR_SWITCH_PROVIDER ||
      provider.type !== profileId ||
      !provider.revision
    )
      throw new Error("Operator fixture provider identity is unavailable");
    return provider;
  };
  const create = async () => {
    const absent = await run(
      ["provider", "get", OPERATOR_SWITCH_PROVIDER],
      "operator-provider-absence",
    );
    if (
      absent.exitCode === 0 ||
      !/provider not found|requested entity was not found/iu.test(resultText(absent))
    )
      throw new Error("Operator fixture provider absence is unproven");
    await createExtraGatewayProvider(host, OPERATOR_SWITCH_PROVIDER, {
      artifactName: "operator-provider-create",
      env,
      profilePath,
      credentialEnv: OPERATOR_SWITCH_CREDENTIAL_ENV,
    });
    ownedId = (await inspect()).revision!.id;
    const exported = await run(
      ["provider", "profile", "export", profileId, "--output", "json"],
      "operator-original-profile",
    );
    if (exported.exitCode !== 0) throw new Error("Operator profile export failed");
    originalDigest ??= inspectInferenceProviderProfile(exported.stdout)?.digest;
    if (!originalDigest) throw new Error("Operator profile has no inference projection");
    return ownedId;
  };
  const remove = async (detach: boolean) => {
    if (!ownedId || (await inspect()).revision!.id !== ownedId)
      throw new Error("Refusing to delete an unowned operator provider identity");
    if (detach) {
      const result = await run(
        ["sandbox", "provider", "detach", options.sandboxName, OPERATOR_SWITCH_PROVIDER],
        "operator-provider-detach",
      );
      if (result.exitCode !== 0) throw new Error("Could not detach the fixture-owned provider");
    }
    const result = await run(
      ["provider", "delete", OPERATOR_SWITCH_PROVIDER],
      "operator-provider-delete",
    );
    if (result.exitCode !== 0) throw new Error("Could not delete the fixture-owned provider");
    ownedId = undefined;
  };
  return {
    ...options,
    create,
    async replace() {
      await remove(true);
      return create();
    },
    async cleanup() {
      if (!ownedId) return;
      const attached = await run(
        ["sandbox", "provider", "list", options.sandboxName],
        "operator-cleanup-attachments",
      );
      if (
        attached.exitCode !== 0 &&
        !/sandbox.*not found|requested entity was not found/iu.test(resultText(attached))
      )
        throw new Error("Operator cleanup sandbox identity is unavailable");
      await remove(
        attached.exitCode === 0 && attached.stdout.split(/\s+/u).includes(OPERATOR_SWITCH_PROVIDER),
      );
    },
    async evidence() {
      const registry = JSON.parse(
        fs.readFileSync(path.join(options.home, ".nemoclaw", "sandboxes.json"), "utf8"),
      );
      const selected = registry.sandboxes?.[options.sandboxName];
      const provider = await inspect();
      const exported = await run(
        ["provider", "profile", "export", profileId, "--output", "json"],
        "operator-profile-readback",
      );
      const attachments = await run(
        ["sandbox", "provider", "list", options.sandboxName],
        "operator-attachment-readback",
      );
      return {
        selected,
        provider,
        profileDigest:
          exported.exitCode === 0
            ? inspectInferenceProviderProfile(exported.stdout)?.digest
            : undefined,
        attachmentExitCode: attachments.exitCode,
        attached: attachments.stdout.split(/\s+/u).includes(OPERATOR_SWITCH_PROVIDER),
      };
    },
    expected(providerId: string) {
      const profileDigest = originalDigest;
      return {
        selected: {
          provider: OPERATOR_SWITCH_PROVIDER,
          model: options.model,
          registeredInferenceProviderAttachment: {
            schemaVersion: 1,
            gatewayName: "nemoclaw",
            sandboxName: options.sandboxName,
            providerName: OPERATOR_SWITCH_PROVIDER,
            providerId,
            profileId,
            profileDigest,
            endpointUrl: options.endpointUrl,
            inferenceApi: "openai-completions",
            credentialEnv: OPERATOR_SWITCH_CREDENTIAL_ENV,
            attachedBySelection: true,
          },
        },
        provider: {
          name: OPERATOR_SWITCH_PROVIDER,
          type: profileId,
          revision: { id: providerId },
          credentialKeys: [OPERATOR_SWITCH_CREDENTIAL_ENV],
          configKeys: [],
        },
        profileDigest,
        attachmentExitCode: 0,
        attached: true,
      };
    },
  };
}
