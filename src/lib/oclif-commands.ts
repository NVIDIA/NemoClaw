// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CredentialsCommand,
  CredentialsListCommand,
  CredentialsResetCommand,
} from "./credentials-cli-command";
import DebugCliCommand from "./debug-cli-command";
import GatewayTokenCliCommand from "./gateway-token-cli-command";
import ListCommand from "./list-command";
import {
  BackupAllCommand,
  GarbageCollectImagesCommand,
  UpgradeSandboxesCommand,
} from "./maintenance-cli-commands";
import {
  SandboxChannelsListCommand,
  SandboxConfigGetCommand,
  SandboxPolicyListCommand,
  SandboxStatusCommand,
} from "./sandbox-inspection-cli-command";
import SandboxLogsCommand from "./sandbox-logs-cli-command";
import ShareCommand from "./share-command";
import SkillInstallCliCommand from "./skill-install-cli-command";
import StatusCommand from "./status-command";
import {
  DeprecatedStartCommand,
  DeprecatedStopCommand,
  TunnelStartCommand,
  TunnelStopCommand,
} from "./tunnel-commands";
import UninstallCliCommand from "./uninstall-cli-command";

export default {
  "backup-all": BackupAllCommand,
  credentials: CredentialsCommand,
  "credentials:list": CredentialsListCommand,
  "credentials:reset": CredentialsResetCommand,
  debug: DebugCliCommand,
  list: ListCommand,
  "sandbox:channels:list": SandboxChannelsListCommand,
  "sandbox:config:get": SandboxConfigGetCommand,
  "sandbox:logs": SandboxLogsCommand,
  "sandbox:policy-list": SandboxPolicyListCommand,
  "sandbox:skill:install": SkillInstallCliCommand,
  "sandbox:status": SandboxStatusCommand,
  share: ShareCommand,
  status: StatusCommand,
  start: DeprecatedStartCommand,
  stop: DeprecatedStopCommand,
  "sandbox:gateway-token": GatewayTokenCliCommand,
  "tunnel:start": TunnelStartCommand,
  "tunnel:stop": TunnelStopCommand,
  gc: GarbageCollectImagesCommand,
  uninstall: UninstallCliCommand,
  "upgrade-sandboxes": UpgradeSandboxesCommand,
};
