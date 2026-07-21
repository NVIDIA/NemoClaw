// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type HermesForwardWatcherHost,
  stopHermesForwardWatcherProcess,
  stopHermesSandboxForward,
} from "../../adapters/openshell/hermes-forward-watcher";
import { readHermesForwardWatcherState } from "../../state/hermes-forward-watcher";

export function stopHermesForwardWatchers(
  nemoclawStateDir: string,
  host: HermesForwardWatcherHost,
): boolean {
  const state = readHermesForwardWatcherState(nemoclawStateDir);
  if (!state.readable) {
    host.warn(`Failed to inspect Hermes forward watcher state under ${nemoclawStateDir}.`);
    return false;
  }
  if (state.watchers.length === 0) {
    host.log("No Hermes forward watchers found");
    return true;
  }

  let allStopped = true;
  for (const watcher of state.watchers) {
    if (!stopHermesForwardWatcherProcess(watcher, host)) allStopped = false;
    if (!stopHermesSandboxForward(watcher, host)) allStopped = false;
  }
  return allStopped;
}
