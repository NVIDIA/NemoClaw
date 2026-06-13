// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway recovery preload repair logic. The generated shell restores the two
// critical Node preload guards from the packaged image copies before recovery
// relaunches a gateway.

export const GATEWAY_PRELOAD_GUARDS: ReadonlyArray<{
  tmpPath: string;
  sourcePath: string;
}> = [
  {
    tmpPath: "/tmp/nemoclaw-sandbox-safety-net.js",
    sourcePath: "/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js",
  },
  {
    tmpPath: "/tmp/nemoclaw-ciao-network-guard.js",
    sourcePath: "/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js",
  },
];

/**
 * Build shell lines that restore and validate the required recovery preloads.
 *
 * The recovery script must not source /tmp/nemoclaw-proxy-env.sh before these
 * lines. This helper inspects any existing env file only for diagnostics, then
 * stages trusted preloads, writes a fresh generated recovery source, and sources
 * only that generated result. A trusted root-owned proxy env keeps its startup
 * contract intact; unsafe or incomplete files are regenerated from trusted
 * preloads.
 */
export function buildGatewayGuardRecoveryLines(): string[] {
  const emitRecoveredProxyEnvRequires = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath }) => `_nemoclaw_emit_recovery_node_require "$preserve_file" ${tmpPath};`,
  );
  const stageCalls = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath, sourcePath }) =>
      `_nemoclaw_stage_recovery_preload ${tmpPath} ${sourcePath} || _NEMOCLAW_CRITICAL_GUARDS_READY=0;`,
  );
  const appendCalls = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath }) =>
      `if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" = "1" ]; then _nemoclaw_append_node_require ${tmpPath}; fi;`,
  );
  const proxyEnvRewriteChecks = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath }) =>
      `_nemoclaw_proxy_env_file_has_require /tmp/nemoclaw-proxy-env.sh ${tmpPath} || _PROXY_ENV_REWRITE_NEEDED=1;`,
  );
  const guardChecks = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath }) => `_nemoclaw_node_options_has_require ${tmpPath} || _GUARDS_MISSING=1;`,
  );

  const helpers = [
    "_nemoclaw_recovery_log() {",
    'local _msg="$1";',
    'echo "$_msg" >&2;',
    'if [ -n "${_GATEWAY_LOG:-}" ]; then echo "$_msg" >> "$_GATEWAY_LOG" 2>/dev/null || true; fi;',
    "};",
    "_nemoclaw_node_options_has_require() {",
    'local wanted="$1"; local token prev;',
    "prev=;",
    "for token in ${NODE_OPTIONS:-}; do",
    'if [ "$prev" = "--require" ] && [ "$token" = "$wanted" ]; then return 0; fi;',
    'if [ "$token" = "--require=$wanted" ]; then return 0; fi;',
    'prev="$token";',
    "done;",
    "return 1;",
    "};",
    "_nemoclaw_mode_group_or_other_writable() {",
    'local perms="$1";',
    'case "$perms" in ""|*[!0-7]*) return 0 ;; esac;',
    'while [ "${#perms}" -lt 3 ]; do perms="0$perms"; done;',
    'case "$perms" in *[2367]?|*[2367]) return 0 ;; *) return 1 ;; esac;',
    "};",
    "_nemoclaw_append_node_require() {",
    'local wanted="$1";',
    'if ! _nemoclaw_node_options_has_require "$wanted"; then export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $wanted"; fi;',
    "};",
    "_nemoclaw_proxy_env_file_has_require() {",
    'local env_file="$1"; local wanted="$2";',
    '[ -r "$env_file" ] || return 1;',
    'grep -F -- "--require $wanted" "$env_file" >/dev/null 2>&1 && return 0;',
    'grep -F -- "--require=$wanted" "$env_file" >/dev/null 2>&1 && return 0;',
    "return 1;",
    "};",
    "_nemoclaw_emit_recovery_node_require() {",
    'local preserve_file="$1"; local wanted="$2";',
    'if [ -n "$preserve_file" ] && _nemoclaw_proxy_env_file_has_require "$preserve_file" "$wanted"; then return 0; fi;',
    'printf \'%s\\n\' "export NODE_OPTIONS=\\"\\${NODE_OPTIONS:+\\$NODE_OPTIONS }--require $wanted\\"";',
    "};",
    "_nemoclaw_validate_recovery_preload() {",
    'local file="$1"; local perms owner _msg;',
    'if [ -L "$file" ]; then _msg="[gateway-recovery] ERROR: $file is a symlink - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ ! -f "$file" ]; then _msg="[gateway-recovery] ERROR: $file is not a regular file - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'perms="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file" 2>/dev/null || echo unknown)";',
    'if [ "$perms" != "444" ]; then _msg="[gateway-recovery] ERROR: $file has unsafe mode=$perms (expected 444) - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ "$(id -u)" -eq 0 ]; then',
    'owner="$(stat -c %u "$file" 2>/dev/null || stat -f %u "$file" 2>/dev/null || echo unknown)";',
    'if [ "$owner" != "0" ]; then _msg="[gateway-recovery] ERROR: $file owner_uid=$owner (expected 0) - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    "fi;",
    "return 0;",
    "};",
    "_nemoclaw_validate_trusted_preload_source() {",
    'local src="$1"; local perms owner _msg;',
    'if [ ! -r "$src" ] || [ -L "$src" ] || [ ! -f "$src" ]; then _msg="[gateway-recovery] ERROR: trusted preload source $src unavailable - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'perms="$(stat -c %a "$src" 2>/dev/null || stat -f %Lp "$src" 2>/dev/null || echo unknown)";',
    'if _nemoclaw_mode_group_or_other_writable "$perms"; then _msg="[gateway-recovery] ERROR: trusted preload source $src has unsafe mode=$perms (group/other writable) - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ "$(id -u)" -eq 0 ]; then',
    'owner="$(stat -c %u "$src" 2>/dev/null || stat -f %u "$src" 2>/dev/null || echo unknown)";',
    'if [ "$owner" != "0" ]; then _msg="[gateway-recovery] ERROR: trusted preload source $src owner_uid=$owner (expected 0) - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    "fi;",
    "return 0;",
    "};",
    "_nemoclaw_validate_recovery_proxy_env() {",
    'local env_file="$1"; local perms owner _msg;',
    'if [ -L "$env_file" ]; then _msg="[gateway-recovery] WARNING: $env_file is a symlink - rebuilding from packaged preloads"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ ! -f "$env_file" ]; then return 1; fi;',
    'perms="$(stat -c %a "$env_file" 2>/dev/null || stat -f %Lp "$env_file" 2>/dev/null || echo unknown)";',
    'if [ "$perms" != "444" ]; then _msg="[gateway-recovery] WARNING: $env_file has unsafe mode=$perms (expected 444) - rebuilding from packaged preloads"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ "$(id -u)" -eq 0 ]; then',
    'owner="$(stat -c %u "$env_file" 2>/dev/null || stat -f %u "$env_file" 2>/dev/null || echo unknown)";',
    'if [ "$owner" != "0" ]; then _msg="[gateway-recovery] WARNING: $env_file owner_uid=$owner (expected 0) - rebuilding from packaged preloads"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    "fi;",
    "return 0;",
    "};",
    "_nemoclaw_stage_recovery_preload() {",
    'local tmp="$1"; local src="$2"; local dir base stage _msg;',
    '_nemoclaw_validate_trusted_preload_source "$src" || return 1;',
    'dir="$(dirname "$tmp")"; base="$(basename "$tmp")";',
    'stage="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || { _msg="[gateway-recovery] ERROR: failed to stage $tmp"; _nemoclaw_recovery_log "$_msg"; return 1; };',
    'if ! cp "$src" "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to copy $src into recovery stage"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ "$(id -u)" -eq 0 ] && ! chown root:root "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to chown recovery stage for $tmp"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if ! chmod 444 "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to chmod recovery stage for $tmp"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if ! mv -f "$stage" "$tmp"; then rm -f "$stage"; if _nemoclaw_validate_recovery_preload "$tmp"; then return 0; fi; _msg="[gateway-recovery] ERROR: failed to install recovery preload $tmp"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    '_nemoclaw_validate_recovery_preload "$tmp";',
    "};",
    "_nemoclaw_write_generated_proxy_env() {",
    'local env_file="$1"; local preserve_file="${2:-}"; local stage _msg;',
    'stage="$(mktemp /tmp/.nemoclaw-proxy-env.sh.tmp.XXXXXX)" || { _msg="[gateway-recovery] ERROR: failed to stage recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; };',
    "{",
    "printf '%s\\n' '# Generated by NemoClaw gateway recovery; do not edit.';",
    'if [ -n "$preserve_file" ]; then cat "$preserve_file"; fi;',
    ...emitRecoveredProxyEnvRequires,
    '} > "$stage" || { rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to write recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; };',
    'if [ "$(id -u)" -eq 0 ] && ! chown root:root "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to chown recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if ! chmod 444 "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to chmod recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ -d "$env_file" ]; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: $env_file is a directory - refusing recovered proxy-env install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if ! mv -f "$stage" "$env_file"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to install recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    '_nemoclaw_validate_recovery_proxy_env "$env_file";',
    "};",
  ].join(" ");

  return [
    helpers,
    "_PE_MISSING=0; _PROXY_ENV_REWRITE_NEEDED=0; _PROXY_ENV_PRESERVE_FILE=;",
    "if _nemoclaw_validate_recovery_proxy_env /tmp/nemoclaw-proxy-env.sh; then :; else _PE_MISSING=1; _PROXY_ENV_REWRITE_NEEDED=1; fi;",
    'if [ "${_PE_MISSING:-0}" = "0" ]; then if [ "$(id -u)" = "0" ]; then _PROXY_ENV_PRESERVE_FILE=/tmp/nemoclaw-proxy-env.sh; else _PE_MISSING=1; _PROXY_ENV_REWRITE_NEEDED=1; fi; fi;',
    ...proxyEnvRewriteChecks,
    "_NEMOCLAW_CRITICAL_GUARDS_READY=1;",
    ...stageCalls,
    'if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" = "1" ] && [ "${_PE_MISSING:-0}" = "1" ]; then',
    '_W="[gateway-recovery] WARNING: /tmp/nemoclaw-proxy-env.sh missing or unsafe - restoring library guards from packaged preloads (#2478/#2701)"; _nemoclaw_recovery_log "$_W";',
    "fi;",
    'if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" = "1" ] && [ "${_PE_MISSING:-0}" = "0" ] && [ "${_PROXY_ENV_REWRITE_NEEDED:-0}" = "1" ]; then',
    '_W="[gateway-recovery] WARNING: /tmp/nemoclaw-proxy-env.sh incomplete - rewriting library guards from packaged preloads (#2478/#2701)"; _nemoclaw_recovery_log "$_W";',
    "fi;",
    'if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" = "1" ]; then',
    'if [ "${_PE_MISSING:-0}" = "1" ] || [ "${_PROXY_ENV_REWRITE_NEEDED:-0}" = "1" ]; then _nemoclaw_write_generated_proxy_env /tmp/nemoclaw-proxy-env.sh "$_PROXY_ENV_PRESERVE_FILE" || _NEMOCLAW_CRITICAL_GUARDS_READY=0; _NEMOCLAW_RECOVERY_SOURCE_ENV=/tmp/nemoclaw-proxy-env.sh;',
    'else _NEMOCLAW_RECOVERY_SOURCE_ENV=/tmp/nemoclaw-recovered-proxy-env.sh; _nemoclaw_write_generated_proxy_env "$_NEMOCLAW_RECOVERY_SOURCE_ENV" "$_PROXY_ENV_PRESERVE_FILE" || _NEMOCLAW_CRITICAL_GUARDS_READY=0; fi;',
    "fi;",
    'if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" = "1" ]; then . "$_NEMOCLAW_RECOVERY_SOURCE_ENV"; _PE_MISSING=0; fi;',
    ...appendCalls,
    "_GUARDS_MISSING=0;",
    'if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" != "1" ]; then _GUARDS_MISSING=1; fi;',
    ...guardChecks,
  ];
}
