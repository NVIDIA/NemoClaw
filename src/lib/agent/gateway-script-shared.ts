// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../runner";
import { buildGatewayGuardRecoveryLines } from "./runtime-recovery-preload";

export function buildNoFollowLogSetupCommand(
  path: string,
  logOwnerUser?: string,
  ownerMode = "0o644",
): string {
  const displayPath = path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const prepareLog = [
    "import errno, os, pwd, stat, sys",
    "path = sys.argv[1]",
    "owner = sys.argv[2] if len(sys.argv) > 2 else ''",
    `owner_mode = ${ownerMode}`,
    "fallback_mode = 0o600",
    "flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)",
    "try:",
    "    fd = os.open(path, flags, 0o644)",
    "except OSError as exc:",
    "    if exc.errno == errno.ELOOP:",
    `        print('[gateway-recovery] ERROR: refusing to prepare symlinked ${displayPath}', file=sys.stderr)`,
    "        sys.exit(1)",
    "    if exc.errno == errno.ENXIO:",
    `        print('[gateway-recovery] ERROR: ${displayPath} is not a regular file', file=sys.stderr)`,
    "        sys.exit(1)",
    "    if exc.errno in (errno.EACCES, errno.EPERM):",
    `        print('[gateway-recovery] ERROR: ${displayPath} is not writable by recovery user', file=sys.stderr)`,
    "        sys.exit(0)",
    `    print(f'[gateway-recovery] ERROR: cannot prepare ${displayPath}: {exc}', file=sys.stderr)`,
    "    sys.exit(1)",
    "try:",
    "    if not stat.S_ISREG(os.fstat(fd).st_mode):",
    `        print('[gateway-recovery] ERROR: ${displayPath} is not a regular file', file=sys.stderr)`,
    "        sys.exit(1)",
    "    if owner and os.geteuid() == 0:",
    "        try:",
    "            pw = pwd.getpwnam(owner)",
    "        except KeyError:",
    "            os.fchmod(fd, fallback_mode)",
    "        else:",
    "            os.fchown(fd, pw.pw_uid, pw.pw_gid)",
    "            os.fchmod(fd, owner_mode)",
    "    else:",
    "        os.fchmod(fd, fallback_mode)",
    "finally:",
    "    os.close(fd)",
  ].join("\n");
  return [
    "python3",
    "-c",
    shellQuote(prepareLog),
    path,
    ...(logOwnerUser ? [shellQuote(logOwnerUser)] : []),
  ].join(" ");
}

export function buildGatewayLogSetup(includeAutoPairLog = false, logOwnerUser?: string): string[] {
  const lines = [`${buildNoFollowLogSetupCommand("/tmp/gateway.log", logOwnerUser)} || exit 1;`];
  if (includeAutoPairLog) {
    lines.push(
      `${buildNoFollowLogSetupCommand("/tmp/auto-pair.log", "sandbox", "0o600")} || exit 1;`,
    );
  }
  return lines;
}

export function buildGatewayLogSelection(): string {
  return '_GATEWAY_LOG=/tmp/gateway.log; if ! : >> "$_GATEWAY_LOG" 2>/dev/null; then _GATEWAY_LOG=/tmp/gateway-recovery.log; : >> "$_GATEWAY_LOG" 2>/dev/null || true; fi;';
}

export function gatewayGuardRefusalCommand(): string {
  return '[ "$_GUARDS_MISSING" = "1" ] && { _E="[gateway-recovery] ERROR: NODE_OPTIONS missing safety-net preload or ciao preload after trusted recovery - refusing unguarded gateway relaunch (#2478/#2701)"; echo "$_E" >&2; echo "$_E" >> "$_GATEWAY_LOG"; exit 1; };';
}

export function gatewayLaunchCommand(command: string, runAsUser?: string): string {
  const logSelection = buildGatewayLogSelection();
  const userLaunch = `nohup ${command} >> "$_GATEWAY_LOG" 2>&1 &`;
  if (!runAsUser) {
    return `${logSelection} ${userLaunch}`;
  }
  return `${logSelection} if [ "$(id -u)" = "0" ] && command -v gosu >/dev/null 2>&1 && id ${shellQuote(runAsUser)} >/dev/null 2>&1; then nohup gosu ${shellQuote(runAsUser)} ${command} >> "$_GATEWAY_LOG" 2>&1 & else ${userLaunch} fi;`;
}

export { buildGatewayGuardRecoveryLines };
