// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import BackupAllCommand from "./maintenance/backup-all";
import ChannelsAddCommand from "./sandbox/channels/add";
import ChannelsListCommand from "./sandbox/channels/list";
import ChannelsRemoveCommand from "./sandbox/channels/remove";
import ChannelsStartCommand from "./sandbox/channels/start";
import ChannelsStopCommand from "./sandbox/channels/stop";
import ConnectCliCommand from "./sandbox/connect";
import CredentialsCommand from "./credentials";
import CredentialsListCommand from "./credentials/list";
import CredentialsResetCommand from "./credentials/reset";
import DebugCliCommand from "./debug";
import DeprecatedStartCommand from "./deprecated/start";
import DeprecatedStopCommand from "./deprecated/stop";
import DeployCliCommand from "./deploy";
import DestroyCliCommand from "./sandbox/destroy";
import GarbageCollectImagesCommand from "./maintenance/gc";
import GatewayTokenCliCommand from "./gateway-token";
import ListCommand from "./list";
import OnboardCliCommand from "./onboard";
import PolicyAddCommand from "./sandbox/policy/add";
import PolicyListCommand from "./sandbox/policy/list";
import PolicyRemoveCommand from "./sandbox/policy/remove";
import RecoverCliCommand from "../recover-cli-command";
import RebuildCliCommand from "./sandbox/rebuild";
import RootHelpCommand from "./root/help";
import SandboxConfigGetCommand from "./sandbox/config/get";
import SandboxConfigSetCommand from "../sandbox-config-set-cli-command";
import SandboxDoctorCliCommand from "./sandbox/doctor";
import SandboxLogsCommand from "./sandbox/logs";
import SandboxStatusCommand from "./sandbox/status";
import SetupCliCommand from "./setup";
import SetupSparkCliCommand from "./setup-spark";
import ShareCommand from "./sandbox/share";
import ShareMountCommand from "./sandbox/share/mount";
import ShareStatusCommand from "./sandbox/share/status";
import ShareUnmountCommand from "./sandbox/share/unmount";
import ShieldsDownCommand from "./sandbox/shields/down";
import ShieldsStatusCommand from "./sandbox/shields/status";
import ShieldsUpCommand from "./sandbox/shields/up";
import SkillCliCommand from "./sandbox/skill";
import SkillInstallCliCommand from "./sandbox/skill/install";
import SnapshotCommand from "./sandbox/snapshot";
import SnapshotCreateCommand from "./sandbox/snapshot/create";
import SnapshotListCommand from "./sandbox/snapshot/list";
import SnapshotRestoreCommand from "./sandbox/snapshot/restore";
import StatusCommand from "./status";
import TunnelStartCommand from "./tunnel/start";
import TunnelStopCommand from "./tunnel/stop";
import UninstallCliCommand from "./uninstall";
import UpgradeSandboxesCommand from "./maintenance/upgrade-sandboxes";
import VersionCommand from "./root/version";

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
  "sandbox:channels:list": ChannelsListCommand,
  "sandbox:channels:remove": ChannelsRemoveCommand,
  "sandbox:channels:start": ChannelsStartCommand,
  "sandbox:channels:stop": ChannelsStopCommand,
  "sandbox:config:get": SandboxConfigGetCommand,
  "sandbox:config:set": SandboxConfigSetCommand,
  "sandbox:connect": ConnectCliCommand,
  "sandbox:destroy": DestroyCliCommand,
  "sandbox:doctor": SandboxDoctorCliCommand,
  "sandbox:gateway:token": GatewayTokenCliCommand,
  "sandbox:logs": SandboxLogsCommand,
  "sandbox:policy:add": PolicyAddCommand,
  "sandbox:policy:list": PolicyListCommand,
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
  "tunnel:start": TunnelStartCommand,
  "tunnel:stop": TunnelStopCommand,
  gc: GarbageCollectImagesCommand,
  uninstall: UninstallCliCommand,
  "upgrade-sandboxes": UpgradeSandboxesCommand,
};
