// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { OLLAMA_PORT } from "../core/ports";
import { sleepSeconds } from "../core/wait";
import { cleanupTempDir, secureTempFile } from "./temp-files";

const { runCapture, runShell, shellQuote }: typeof import("../runner") = require("../runner");
const {
  findReachableOllamaHost,
  resetOllamaHostCache,
}: typeof import("../inference/local") = require("../inference/local");
const { isWsl }: typeof import("../platform") = require("../platform");

const OLLAMA_SYSTEMD_OVERRIDE_PATH = "/etc/systemd/system/ollama.service.d/override.conf";
const NON_INTERACTIVE_SUDO_MODE_ENV = "NEMOCLAW_NON_INTERACTIVE_SUDO_MODE";

export type OllamaLoopbackSystemdOverrideState = "not-applicable" | "ready" | "failed";

type OllamaLoopbackSystemdOverrideOptions = {
  isNonInteractive?: () => boolean;
};

function isEnvNonInteractive(): boolean {
  return process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

function getSudoPrefix(isNonInteractive: boolean): "sudo" | "sudo -n" {
  const rawMode = String(process.env[NON_INTERACTIVE_SUDO_MODE_ENV] || "")
    .trim()
    .toLowerCase();
  if (rawMode && rawMode !== "prompt") {
    console.error(
      `  Unsupported ${NON_INTERACTIVE_SUDO_MODE_ENV} value: ${rawMode}. Use 'prompt' or leave it unset.`,
    );
    process.exit(1);
  }
  if (isNonInteractive) return rawMode === "prompt" ? "sudo" : "sudo -n";
  return process.stdin.isTTY ? "sudo" : "sudo -n";
}

export function ensureOllamaLoopbackSystemdOverride(
  options: OllamaLoopbackSystemdOverrideOptions = {},
): OllamaLoopbackSystemdOverrideState {
  if (process.platform !== "linux" || isWsl()) return "not-applicable";

  const hasOllamaSystemdUnit = !!runCapture(
    [
      "sh",
      "-c",
      "command -v systemctl >/dev/null && [ -d /run/systemd/system ] && systemctl list-unit-files ollama.service --no-legend 2>/dev/null | head -n1",
    ],
    { ignoreError: true },
  ).trim();
  if (!hasOllamaSystemdUnit) return "not-applicable";

  console.log("  Configuring Ollama systemd loopback override...");
  console.log(
    `  Applying an Ollama systemd override (OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}). ` +
      "The next steps use sudo to write the drop-in, reload systemd, and restart the service; " +
      "you may be prompted for your password.",
  );
  const sudoPrefix = getSudoPrefix((options.isNonInteractive ?? isEnvNonInteractive)());
  const existingDropInResult = runShell(
    [
      `if [ -r ${shellQuote(OLLAMA_SYSTEMD_OVERRIDE_PATH)} ]; then`,
      `  cat ${shellQuote(OLLAMA_SYSTEMD_OVERRIDE_PATH)}`,
      `elif [ -e ${shellQuote(OLLAMA_SYSTEMD_OVERRIDE_PATH)} ]; then`,
      `  ${sudoPrefix} cat ${shellQuote(OLLAMA_SYSTEMD_OVERRIDE_PATH)}`,
      "fi",
    ].join("\n"),
    { ignoreError: true, suppressOutput: true, timeout: 30_000 },
  );
  if (existingDropInResult.error || existingDropInResult.status !== 0) {
    console.error("  Failed to inspect existing Ollama systemd override.");
    if (sudoPrefix === "sudo -n") {
      console.error(
        `  Non-interactive sudo could not read the existing drop-in. Set ${NON_INTERACTIVE_SUDO_MODE_ENV}=prompt to allow a sudo password prompt when a terminal is available.`,
      );
    }
    console.error("  Refusing to continue because preserving existing Ollama settings is required.");
    process.exit(1);
  }
  const existingDropIn = String(existingDropInResult.stdout || "");
  const dropInBody = mergeOllamaLoopbackSystemdOverride(existingDropIn);
  const tmpDropIn = secureTempFile("nemoclaw-ollama-override", ".conf");
  let overrideFailed = false;
  try {
    fs.writeFileSync(tmpDropIn, dropInBody, { mode: 0o644 });
    const overrideResult = runShell(
      [
        "set -e",
        `pre_state=$(${sudoPrefix} systemctl show ollama --property=ActiveEnterTimestampMonotonic --property=MainPID --value 2>/dev/null | tr '\\n' ' ')`,
        `${sudoPrefix} install -D -m 0644 ${shellQuote(tmpDropIn)} ${shellQuote(OLLAMA_SYSTEMD_OVERRIDE_PATH)}`,
        `${sudoPrefix} systemctl daemon-reload`,
        `${sudoPrefix} systemctl --no-block restart ollama`,
        "for _ in $(seq 1 30); do",
        `  current_state=$(${sudoPrefix} systemctl show ollama --property=ActiveEnterTimestampMonotonic --property=MainPID --value 2>/dev/null | tr '\\n' ' ')`,
        `  if [ "$current_state" != "$pre_state" ] && ${sudoPrefix} systemctl is-active --quiet ollama; then exit 0; fi`,
        "  sleep 1",
        "done",
        "exit 1",
      ].join("\n"),
      { ignoreError: true, timeout: 45_000 },
    );
    if (overrideResult.error || overrideResult.status !== 0) {
      overrideFailed = true;
    }
  } finally {
    cleanupTempDir(tmpDropIn, "nemoclaw-ollama-override");
  }
  if (overrideFailed) {
    console.error("  Failed to apply Ollama systemd loopback override.");
    console.error("  Refusing to continue with a potentially non-loopback Ollama bind.");
    process.exit(1);
  }

  // The restart may briefly drop Ollama. Clear the cached successful probe so
  // the readiness loop checks the daemon that systemd just restarted.
  resetOllamaHostCache();
  for (let i = 0; i < 10; i++) {
    if (findReachableOllamaHost()) return "ready";
    sleepSeconds(1);
  }
  return "failed";
}

function mergeOllamaLoopbackSystemdOverride(existingDropIn: string): string {
  const desiredLine = `Environment="OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}"`;
  const lines = existingDropIn.trimEnd().length > 0 ? existingDropIn.trimEnd().split(/\r?\n/) : [];
  const serviceStart = lines.findIndex((line) => /^\s*\[Service\]\s*(?:[#;].*)?$/.test(line));
  if (serviceStart === -1) {
    return [...lines, ...(lines.length > 0 ? [""] : []), "[Service]", desiredLine].join("\n") + "\n";
  }

  let serviceEnd = lines.length;
  for (let i = serviceStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*(?:[#;].*)?$/.test(lines[i])) {
      serviceEnd = i;
      break;
    }
  }

  const hostLines = lines
    .slice(serviceStart + 1, serviceEnd)
    .filter((line) => !/^\s*[#;]/.test(line) && /\bOLLAMA_HOST=/.test(line));
  if (hostLines.at(-1)?.trim() === desiredLine) {
    return lines.join("\n") + "\n";
  }

  lines.splice(serviceEnd, 0, desiredLine);
  return lines.join("\n") + "\n";
}
