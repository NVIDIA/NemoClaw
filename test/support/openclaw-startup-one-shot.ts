// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function oneShotStartupBranch(source: string, rootMode: boolean): string {
  const start = source.indexOf(rootMode ? "# ── Root path" : "# ── Non-root fallback");
  const edge = rootMode
    ? source.indexOf('echo "[gateway] NEMOCLAW_ENTRYPOINT_MODE=root"', start)
    : source.indexOf("  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then", start);
  const end = source.indexOf(
    rootMode ? "\nprepare_auto_pair_log" : "\n  configure_messaging_channels",
    edge,
  );
  if (start < 0 || edge < start || end <= edge) {
    throw new Error("One-shot entrypoint branch not found");
  }
  // Keep the real admission, release, and command execution boundaries. These
  // unrelated setup operations need no host or credential effects in the fixture.
  const stubs = [
    "configure_messaging_channels",
    "setup_auth_profile_as_sandbox",
    "prepare_gateway_token_for_current_command",
    "export_gateway_token",
    "write_messaging_runtime_setup_plan",
    "write_runtime_shell_env",
    "apply_messaging_runtime_env_aliases",
    "install_messaging_runtime_preloads",
    "verify_messaging_runtime_secret_scans",
    "_nemoclaw_capture_epoch_realtime",
  ].map((name) => `${name}() { :; }`);
  return [
    ...stubs,
    "refresh_openclaw_provider_placeholders() { export NEMOCLAW_TEST_PLACEHOLDER=refreshed; }",
    source.slice(edge, end),
  ].join("\n");
}
