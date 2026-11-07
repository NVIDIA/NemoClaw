// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runNativeTurnEntry } from "./run-installed-native-turn.mts";
import { runNativeTerminalTurnEntry } from "./run-installed-native-pi.mts";
import { runNativeNemoCuaEntry } from "./run-installed-native-nemocua.mts";
import { runNativeConsoleEntry } from "./run-installed-native-console-agent.mts";
import { runNativeWebEntry } from "./run-installed-native-web-ui.mts";
import { runNativeHermesUiEntry } from "./run-installed-native-hermes-ui.mts";
import { runNativeInferenceEntry } from "./native-inference-cli.mts";

const entries = {
  turn: runNativeTurnEntry,
  "terminal-turn": runNativeTerminalTurnEntry,
  nemocua: runNativeNemoCuaEntry,
  console: runNativeConsoleEntry,
  web: runNativeWebEntry,
  "hermes-dashboard": runNativeHermesUiEntry,
  inference: runNativeInferenceEntry,
} as const;

export async function dispatchNativeEntry(mode: string | undefined, args: string[]) {
  if (!mode || !Object.hasOwn(entries, mode))
    throw new Error("The installed application mode is invalid.");
  // Exactly one dispatcher consumes the mode. Existing entry argument contracts
  // retain argv[0]/argv[1] and see only their own original arguments afterward.
  process.argv = [...process.argv.slice(0, 2), ...args];
  await entries[mode as keyof typeof entries]();
}

export const nativeEntryModes = Object.freeze(Object.keys(entries));
