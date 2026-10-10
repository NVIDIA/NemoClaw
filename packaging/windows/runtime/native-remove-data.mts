// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { NATIVE_SERVICES, nativeServiceBinding } from "./native-options.mts";
import { acquireNativeStateRemoval } from "./native-state.mts";
import {
  deleteCredentialByBinding,
  nativeCredentialBinding,
  readOpenedRegularFile,
} from "./native-security.mts";

export async function removeNativeAgentData(launcher: string, agent: string) {
  if (!["openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua"].includes(agent))
    throw new Error("Select a valid agent to remove.");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !path.win32.isAbsolute(localAppData))
    throw new Error("The Windows settings directory is unavailable.");
  const root = path.join(localAppData, "NVIDIA", "NemoClaw");
  const directory = path.join(root, "agents", agent);
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
    inference = {
      provider: configuration.inference,
      binding: nativeCredentialBinding(configuration),
    };
  }
  // The native remover refuses active sessions, foreign ownership and every
  // reparse entry before removing data. Its mutex remains held during metadata/key cleanup.
  const owner = await acquireNativeStateRemoval(launcher, agent);
  try {
    owner.assertHeld();
    if (inference) await deleteCredentialByBinding(launcher, inference.provider, inference.binding);
    for (const service of Object.keys(NATIVE_SERVICES))
      await deleteCredentialByBinding(launcher, service, nativeServiceBinding(agent, service));
    owner.assertHeld();
    fs.rmSync(directory, { recursive: true, force: true });
    const activePath = path.join(root, "active-agent.txt");
    const active = readOpenedRegularFile(activePath, { encoding: "utf8", maxBytes: 64 });
    if (active?.trim() === agent) fs.rmSync(activePath);
  } finally {
    await owner.release();
  }
}
