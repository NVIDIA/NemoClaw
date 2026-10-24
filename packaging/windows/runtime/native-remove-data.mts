// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { NATIVE_SERVICES, nativeServiceBinding } from "./native-options.mts";
import { acquireNativeStateRemoval } from "./native-state.mts";
import { localModelIdentityMatches } from "./native-local-models.mts";
import { readNativeConfigurationRecovery } from "./native-configuration-recovery.mts";
import {
  deleteCredentialByBinding,
  nativeCredentialBinding,
  readOpenedRegularFile,
} from "./native-security.mts";

function readRemovalCredential(root: string, directory: string, agent: string) {
  for (const candidate of [root, path.join(root, "agents"), directory]) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error(
        "Agent settings use a redirected path. Restore the ordinary settings directory before removing data.",
      );
  }
  const text = readOpenedRegularFile(path.join(directory, "native-windows.json"), {
    encoding: "utf8",
    maxBytes: 16 * 1024,
  });
  const configuration = text === null ? null : JSON.parse(text);
  let inference: { provider: string; binding: string } | null = null;
  if (configuration !== null) {
    if (
      configuration.schemaVersion !== 1 ||
      configuration.classification !== "nemoclaw-native-windows-agent-configuration" ||
      configuration.agent !== agent ||
      typeof configuration.credentialStored !== "boolean"
    )
      throw new Error("The existing agent settings cannot be safely identified for removal.");
    if (configuration.localModel !== undefined) {
      if (
        configuration.inference !== "local" ||
        configuration.credentialStored ||
        configuration.endpoint !== undefined ||
        !localModelIdentityMatches(configuration.localModel, configuration.model)
      )
        throw new Error(
          "The existing local model settings cannot be safely identified for removal.",
        );
    } else {
      inference = {
        provider: configuration.inference,
        binding: nativeCredentialBinding(configuration),
      };
    }
  }
  const bindings = new Map<string, { provider: string; binding: string }>();
  if (inference) bindings.set(inference.binding, inference);
  for (const identity of readNativeConfigurationRecovery(directory, agent)?.identities ?? []) {
    const binding = nativeCredentialBinding(identity);
    bindings.set(binding, { provider: identity.inference, binding });
  }
  return [...bindings.values()];
}

export async function removeNativeAgentData(
  launcher: string,
  agent: string,
  dependencies: {
    acquireRemoval?: typeof acquireNativeStateRemoval;
    deleteCredential?: typeof deleteCredentialByBinding;
  } = {},
) {
  if (!["openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua"].includes(agent))
    throw new Error("Select a valid agent to remove.");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !path.win32.isAbsolute(localAppData))
    throw new Error("The Windows settings directory is unavailable.");
  const root = path.join(localAppData, "NVIDIA", "NemoClaw");
  const directory = path.join(root, "agents", agent);
  // Reject unidentified settings before the native owner can remove private state.
  readRemovalCredential(root, directory, agent);
  // The native remover refuses active sessions, foreign ownership and every
  // reparse entry before removing data. Its mutex remains held during metadata/key cleanup.
  const owner = await (dependencies.acquireRemoval ?? acquireNativeStateRemoval)(launcher, agent);
  try {
    owner.assertHeld();
    // A save may have completed while native removal was opening its lease.
    // Select the credential from the current settings while that lease is held.
    const inference = readRemovalCredential(root, directory, agent);
    const deleteCredential = dependencies.deleteCredential ?? deleteCredentialByBinding;
    for (const identity of inference)
      await deleteCredential(launcher, identity.provider, identity.binding);
    for (const service of Object.keys(NATIVE_SERVICES))
      await deleteCredential(launcher, service, nativeServiceBinding(agent, service));
    owner.assertHeld();
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      const activePath = path.join(root, "active-agent.txt");
      const active = readOpenedRegularFile(activePath, { encoding: "utf8", maxBytes: 64 });
      if (active?.trim() === agent) fs.rmSync(activePath);
    } catch (error) {
      throw new Error(
        `Removal of ${agent} data is incomplete. Its credentials were removed, but settings cleanup failed. Close applications using its files, then retry data removal.`,
        { cause: error },
      );
    }
  } finally {
    await owner.release();
  }
}
