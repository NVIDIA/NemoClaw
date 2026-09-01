// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { rebasePolicyDocumentOntoConcurrentEdit } from "../../../src/lib/policy/index.ts";
import { parseOpenShellPolicy, parseSandboxPolicyMetadata } from "../../../src/lib/policy/merge.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { policyDocumentWithEndpointCredentialBinding } from "../fixtures/policy-credential-binding.ts";

const POLICY_BINDING_RECONCILE_ATTEMPTS = 5;

type PolicyCredentialBindingOptions = {
  host: Pick<HostCliClient, "command" | "openshellCommandPath">;
  sandboxName: string;
  providerName: string;
  endpointHost: string;
  endpointPort: string | number;
  protocol: "rest" | "websocket";
  env: NodeJS.ProcessEnv;
  redactionValues: string[];
  artifactName: string;
};

function policyDocumentsMatch(left: string, right: string): boolean {
  return isDeepStrictEqual(parseOpenShellPolicy(left).policy, parseOpenShellPolicy(right).policy);
}

async function runOpenShell(
  options: PolicyCredentialBindingOptions,
  args: string[],
  phase: string,
): Promise<string> {
  const result = await options.host.command(options.host.openshellCommandPath, args, {
    artifactName: `${options.artifactName}-${phase}`,
    cwd: REPO_ROOT,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 120_000,
  });
  assertExitZero(result, `${options.artifactName}-${phase}`);
  return result.stdout;
}

async function readActivePolicyVersion(
  options: PolicyCredentialBindingOptions,
  phase: string,
): Promise<number> {
  const metadata = await runOpenShell(
    options,
    ["policy", "get", "--full", "--output", "json", options.sandboxName],
    phase,
  );
  return parseSandboxPolicyMetadata(metadata, options.sandboxName).policyIdentity.activeVersion;
}

async function readBasePolicy(
  options: PolicyCredentialBindingOptions,
  phase: string,
): Promise<string> {
  const raw = await runOpenShell(options, ["policy", "get", "--base", options.sandboxName], phase);
  return parseOpenShellPolicy(raw).yamlBody;
}

async function readBasePolicyRevision(
  options: PolicyCredentialBindingOptions,
  revision: number,
  phase: string,
): Promise<string> {
  const raw = await runOpenShell(
    options,
    ["policy", "get", "--rev", String(revision), "--base", options.sandboxName],
    phase,
  );
  return parseOpenShellPolicy(raw).yamlBody;
}

export async function applyPolicyCredentialBinding(
  options: PolicyCredentialBindingOptions,
): Promise<void> {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-policy-binding-"));
  const policyFile = path.join(tempDirectory, "policy.yaml");

  try {
    let contextVersion = await readActivePolicyVersion(options, "initial-metadata");
    let contextDocument = await readBasePolicy(options, "initial-policy");
    let requestedDocument = policyDocumentWithEndpointCredentialBinding(
      contextDocument,
      options.providerName,
      options.endpointHost,
      Number(options.endpointPort),
      options.protocol,
    );
    let recoveryFailure: Error | null = null;

    for (let attempt = 1; attempt <= POLICY_BINDING_RECONCILE_ATTEMPTS; attempt += 1) {
      const currentDocument = await readBasePolicy(options, `attempt-${attempt}-preflight`);
      if (!policyDocumentsMatch(currentDocument, contextDocument)) {
        throw new Error(
          "sandbox base policy changed while preparing the credential binding; refusing to apply a stale policy",
        );
      }

      fs.writeFileSync(policyFile, requestedDocument, { encoding: "utf8", mode: 0o600 });
      await runOpenShell(
        options,
        ["policy", "set", "--policy", policyFile, "--wait", options.sandboxName],
        `attempt-${attempt}-set`,
      );

      const observedVersion = await readActivePolicyVersion(
        options,
        `attempt-${attempt}-readback-metadata`,
      );
      const observedDocument = await readBasePolicy(options, `attempt-${attempt}-readback-policy`);
      const requestedIsCurrent = policyDocumentsMatch(observedDocument, requestedDocument);
      const concurrentRevision = observedVersion > contextVersion + 1;

      if (!concurrentRevision) {
        if (!requestedIsCurrent) {
          throw new Error("applied policy did not match the requested credential binding");
        }
        if (recoveryFailure) throw recoveryFailure;
        return;
      }

      const externalDocument = requestedIsCurrent
        ? await readBasePolicyRevision(
            options,
            observedVersion - 1,
            `attempt-${attempt}-concurrent-revision`,
          )
        : observedDocument;
      const rebased = rebasePolicyDocumentOntoConcurrentEdit(
        contextDocument,
        requestedDocument,
        externalDocument,
      );
      contextVersion = observedVersion;
      contextDocument = observedDocument;
      if (rebased.conflicts.length > 0) {
        recoveryFailure ??= new Error(
          "sandbox policy changed in the credential-binding fields; restored the external policy and refused the conflicting binding",
        );
        requestedDocument = externalDocument;
      } else {
        requestedDocument = rebased.document;
      }
    }

    throw new Error(
      "sandbox policy kept changing while reconciling the credential binding; refusing the update",
    );
  } finally {
    fs.rmSync(tempDirectory, { force: true, recursive: true });
  }
}
