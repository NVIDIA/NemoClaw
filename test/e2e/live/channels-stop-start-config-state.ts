// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The live probe emits only these booleans. The settings fields exclude
// `enabled`, so artifacts do not contain credential-bearing configuration.
export interface OpenClawChannelConfigState {
  channelPresent: boolean;
  channelEnabled: boolean;
  channelDisabled: boolean;
  channelHasSettings: boolean;
  pluginPresent: boolean;
  pluginEnabled: boolean;
  pluginDisabled: boolean;
  pluginHasSettings: boolean;
}

export function openClawChannelIsActive(state: OpenClawChannelConfigState): boolean {
  return (
    state.channelPresent &&
    state.channelEnabled &&
    !state.channelDisabled &&
    state.pluginPresent &&
    state.pluginEnabled &&
    !state.pluginDisabled
  );
}

export function openClawChannelIsInert(state: OpenClawChannelConfigState): boolean {
  const channelIsInert =
    !state.channelPresent || (state.channelDisabled && !state.channelHasSettings);
  const pluginIsInert = !state.pluginPresent || (state.pluginDisabled && !state.pluginHasSettings);

  return !state.channelEnabled && !state.pluginEnabled && channelIsInert && pluginIsInert;
}
