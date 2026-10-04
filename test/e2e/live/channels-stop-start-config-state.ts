// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The live probe emits only these booleans. The settings fields exclude
// `enabled`, so artifacts do not contain credential-bearing configuration.
export interface OpenClawChannelConfigState {
  channelPresent: boolean;
  channelActivationUsesAccounts: boolean;
  channelEnabled: boolean;
  channelDisabled: boolean;
  channelHasEnabledAccount: boolean;
  channelHasSettings: boolean;
  pluginPresent: boolean;
  pluginEnabled: boolean;
  pluginDisabled: boolean;
  pluginHasSettings: boolean;
}

export function openClawChannelIsActive(state: OpenClawChannelConfigState): boolean {
  const channelIsEnabled = state.channelActivationUsesAccounts
    ? state.channelHasEnabledAccount
    : state.channelEnabled;
  return (
    state.channelPresent &&
    channelIsEnabled &&
    !state.channelDisabled &&
    state.pluginPresent &&
    state.pluginEnabled &&
    !state.pluginDisabled
  );
}

export function openClawChannelIsInert(state: OpenClawChannelConfigState): boolean {
  const channelIsInert =
    !state.channelPresent || (state.channelDisabled && !state.channelHasSettings);

  return !state.channelEnabled && !state.channelHasEnabledAccount && channelIsInert;
}

export function openClawChannelStateProbeScript(
  channel: string,
  configPath = "/sandbox/.openclaw/openclaw.json",
): string {
  const key = channel === "wechat" ? "openclaw-weixin" : channel === "teams" ? "msteams" : channel;
  return `
import json
key = ${JSON.stringify(key)}
channel_uses_accounts = ${channel === "wechat" ? "True" : "False"}
cfg = json.load(open(${JSON.stringify(configPath)}))
channels = cfg.get('channels', {})
plugins = cfg.get('plugins', {}).get('entries', {})
channel_present = key in channels
plugin_present = key in plugins
channel = channels.get(key)
plugin = plugins.get(key)
channel_obj = channel if isinstance(channel, dict) else None
plugin_obj = plugin if isinstance(plugin, dict) else None
accounts = channel_obj.get('accounts') if channel_obj is not None else None
account_values = accounts.values() if isinstance(accounts, dict) else []
print(json.dumps({
  'channelPresent': channel_present,
  'channelActivationUsesAccounts': channel_uses_accounts,
  'channelEnabled': channel_obj is not None and channel_obj.get('enabled') is True,
  'channelDisabled': channel_obj is not None and channel_obj.get('enabled') is False,
  'channelHasEnabledAccount': any(isinstance(account, dict) and account.get('enabled') is True for account in account_values),
  'channelHasSettings': channel_present and (channel_obj is None or any(field != 'enabled' for field in channel_obj)),
  'pluginPresent': plugin_present,
  'pluginEnabled': plugin_obj is not None and plugin_obj.get('enabled') is True,
  'pluginDisabled': plugin_obj is not None and plugin_obj.get('enabled') is False,
  'pluginHasSettings': plugin_present and (plugin_obj is None or any(field != 'enabled' for field in plugin_obj)),
}, separators=(',', ':')))
`.trim();
}

export function openClawWechatAccountStateProbeScript(
  accountRoot = "/sandbox/.openclaw/openclaw-weixin",
): string {
  return `
import json
import os
root = ${JSON.stringify(accountRoot)}
print(json.dumps({
  'accountDirectoryPresent': os.path.lexists(os.path.join(root, 'accounts')),
  'accountRegistryPresent': os.path.lexists(os.path.join(root, 'accounts.json')),
  'accountRootPresent': os.path.lexists(root),
}, separators=(',', ':')))
`.trim();
}
