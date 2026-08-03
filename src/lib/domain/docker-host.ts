// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

// A DOCKER_HOST value onboarding can use. Unset means Docker's default socket,
// which is supported; a set value must be an absolute `unix://` socket that can
// be written to the gateway environment file. TCP and SSH endpoints and
// relative paths are unsupported, so onboarding cannot use them even when they
// are reachable.
//
// The raw value is checked for null bytes and line breaks before trimming, so a
// trailing `\n` cannot be trimmed away and then accepted; the socket path is
// checked for the single quote it would be wrapped in when written to the
// gateway environment file.
export function isSupportedGatewayDockerHost(value: string | undefined): boolean {
  const raw = String(value ?? "");
  if (/[\0\r\n]/.test(raw)) return false;
  const candidate = raw.trim();
  if (!candidate) return true;
  const prefix = "unix://";
  if (!candidate.startsWith(prefix)) return false;
  const socketPath = candidate.slice(prefix.length);
  return path.isAbsolute(socketPath) && !socketPath.includes("'");
}
