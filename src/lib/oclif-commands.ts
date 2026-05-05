// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ChannelsAddCommand,
  ChannelsRemoveCommand,
  ChannelsStartCommand,
  ChannelsStopCommand,
} from "./channels-mutate-cli-commands";
import {
  CredentialsCommand,
  CredentialsListCommand,
  CredentialsResetCommand,
} from "./credentials-cli-command";
import ConnectCliCommand from "./connect-cli-command";
import DebugCliCommand from "./debug-cli-command";
import DeployCliCommand from "./deploy-cli-command";
import DestroyCliCommand from "./destroy-cli-command";
import { RootHelpCommand, VersionCommand } from "./help-version-cli-commands";
import GatewayTokenCliCommand from "./gateway-token-cli-command";
import ListCommand from "./list-command";
import {
  OnboardCliCommand,
  SetupCliCommand,
  SetupSparkCliCommand,
} from "./onboard-cli-commands";
import {
  BackupAllCommand,
  GarbageCollectImagesCommand,
  UpgradeSandboxesCommand,
} from "./maintenance-cli-commands";
import { PolicyAddCommand, PolicyRemoveCommand } from "./policy-mutate-cli-commands";
import RebuildCliCommand from "./rebuild-cli-command";
import RecoverCliCommand from "./recover-cli-command";
import SandboxConfigSetCommand from "./sandbox-config-set-cli-command";
import SandboxDoctorCliCommand from "./sandbox-doctor-cli-command";
import {
  SandboxChannelsListCommand,
  SandboxConfigGetCommand,
  SandboxPolicyListCommand,
  SandboxStatusCommand,
} from "./sandbox-inspection-cli-command";
import SandboxLogsCommand from "./sandbox-logs-cli-command";
import {
  ShieldsDownCommand,
  ShieldsStatusCommand,
  ShieldsUpCommand,
} from "./shields-cli-commands";
import ShareCommand, {
  ShareMountCommand,
  ShareStatusCommand,
  ShareUnmountCommand,
} from "./share-command";
import SkillInstallCliCommand, { SkillCliCommand } from "./skill-install-cli-command";
import {
  SnapshotCommand,
  SnapshotCreateCommand,
  SnapshotListCommand,
  SnapshotRestoreCommand,
} from "./snapshot-cli-commands";
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
  deploy: DeployCliCommand,
  list: ListCommand,
  onboard: OnboardCliCommand,
  "root:help": RootHelpCommand,
  "root:version": VersionCommand,
  "sandbox:channels:add": ChannelsAddCommand,
  "sandbox:channels:list": SandboxChannelsListCommand,
  "sandbox:channels:remove": ChannelsRemoveCommand,
  "sandbox:channels:start": ChannelsStartCommand,
  "sandbox:channels:stop": ChannelsStopCommand,
  "sandbox:config:get": SandboxConfigGetCommand,
  "sandbox:config:set": SandboxConfigSetCommand,
  "sandbox:connect": ConnectCliCommand,
  "sandbox:destroy": DestroyCliCommand,
  "sandbox:doctor": SandboxDoctorCliCommand,
  "sandbox:logs": SandboxLogsCommand,
  "sandbox:policy:add": PolicyAddCommand,
  "sandbox:policy:list": SandboxPolicyListCommand,
  "sandbox:policy:remove": PolicyRemoveCommand,
  "sandbox:rebuild": RebuildCliCommand,
  "sandbox:recover": RecoverCliCommand,
  "sandbox:share": ShareCommand,
  "sandbox:share:mount": ShareMountCommand,
  "sandbox:share:status": ShareStatusCommand,
  "sandbox:share:unmount": ShareUnmountCommand,
  "sandbox:shields:down": ShieldsDownCommand,
  "sandbox:shields:status": ShieldsStatusCommand,
  "sandbox:shields:up": ShieldsUpCommand,
  "sandbox:skill": SkillCliCommand,
  "sandbox:skill:install": SkillInstallCliCommand,
  "sandbox:snapshot": SnapshotCommand,
  "sandbox:snapshot:create": SnapshotCreateCommand,
  "sandbox:snapshot:list": SnapshotListCommand,
  "sandbox:snapshot:restore": SnapshotRestoreCommand,
  "sandbox:status": SandboxStatusCommand,
  setup: SetupCliCommand,
  "setup-spark": SetupSparkCliCommand,
  status: StatusCommand,
  start: DeprecatedStartCommand,
  stop: DeprecatedStopCommand,
  "sandbox:gateway:token": GatewayTokenCliCommand,
  "tunnel:start": TunnelStartCommand,
  "tunnel:stop": TunnelStopCommand,
  gc: GarbageCollectImagesCommand,
  uninstall: UninstallCliCommand,
  "upgrade-sandboxes": UpgradeSandboxesCommand,
};
