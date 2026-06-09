// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import nodePath from "node:path";

import { OLLAMA_PORT } from "../core/ports";
import { sleepSeconds } from "../core/wait";
import { MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW } from "../inference/ollama-runtime-context";
import { cleanupTempDir, secureTempFile } from "./temp-files";

const { runCapture, runShell, shellQuote }: typeof import("../runner") = require("../runner");
const {
  findReachableOllamaHost,
  resetOllamaHostCache,
}: typeof import("../inference/local") = require("../inference/local");
const { detectNvidiaPlatform }: typeof import("../inference/nim") = require("../inference/nim");

const OLLAMA_SYSTEMD_OVERRIDE_PATH = "/etc/systemd/system/ollama.service.d/override.conf";
const NON_INTERACTIVE_SUDO_MODE_ENV = "NEMOCLAW_NON_INTERACTIVE_SUDO_MODE";

export type OllamaLoopbackSystemdOverrideState = "not-applicable" | "ready" | "failed";

type OllamaLoopbackSystemdOverrideOptions = {
  isNonInteractive?: () => boolean;
  enableService?: boolean;
  detectNvidiaPlatformImpl?: () => string;
  hasOllamaCudaV13LibraryImpl?: () => boolean;
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

function hasOllamaCudaV13Library(): boolean {
  const ollamaPath = runCapture(["sh", "-c", "command -v ollama"], { ignoreError: true }).trim();
  const candidates = [
    "/usr/local/lib/ollama/cuda_v13",
    "/usr/lib/ollama/cuda_v13",
    "/lib/ollama/cuda_v13",
  ];
  if (ollamaPath) {
    try {
      const realPath = fs.realpathSync(ollamaPath);
      candidates.unshift(
        nodePath.join(nodePath.dirname(realPath), "..", "lib", "ollama", "cuda_v13"),
      );
    } catch {
      candidates.unshift(
        nodePath.join(nodePath.dirname(ollamaPath), "..", "lib", "ollama", "cuda_v13"),
      );
    }
  }
  return candidates.some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function resolveOllamaLibraryOverride(
  options: OllamaLoopbackSystemdOverrideOptions,
): string | null {
  const platform = (options.detectNvidiaPlatformImpl ?? detectNvidiaPlatform)();
  if (platform !== "spark") return null;
  const hasCudaV13 = (options.hasOllamaCudaV13LibraryImpl ?? hasOllamaCudaV13Library)();
  return hasCudaV13 ? "cuda_v13" : null;
}

export function ensureOllamaLoopbackSystemdOverride(
  options: OllamaLoopbackSystemdOverrideOptions = {},
): OllamaLoopbackSystemdOverrideState {
  // Linux-only check kept; WSL distros that run systemd (default on Win11 22H2+)
  // also need the loopback override repaired. The auth proxy in front of Ollama
  // now handles bridge-network reachability for both native-Docker-in-WSL and
  // non-WSL Linux, so loopback binding is the right policy everywhere. See
  // issues #3342 (re-onboard repair) and #3695 (WSL native Docker).
  if (process.platform !== "linux") return "not-applicable";

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
    console.error(
      "  Refusing to continue because preserving existing Ollama settings is required.",
    );
    process.exit(1);
  }
  const existingDropIn = String(existingDropInResult.stdout || "");
  const libraryOverride = resolveOllamaLibraryOverride(options);
  if (libraryOverride) {
    console.log(`  Configuring Ollama ${libraryOverride} backend override for DGX Spark...`);
  }
  const dropInBody = mergeOllamaLoopbackSystemdOverride(existingDropIn, {
    libraryOverride,
  });
  const tmpDropIn = secureTempFile("nemoclaw-ollama-override", ".conf");
  let overrideFailed = false;
  try {
    fs.writeFileSync(tmpDropIn, dropInBody, { mode: 0o644 });
    const overrideCommands = [
      "set -e",
      `pre_state=$(${sudoPrefix} systemctl show ollama --property=ActiveEnterTimestampMonotonic --property=MainPID --value 2>/dev/null | tr '\\n' ' ')`,
      `${sudoPrefix} install -D -m 0644 ${shellQuote(tmpDropIn)} ${shellQuote(OLLAMA_SYSTEMD_OVERRIDE_PATH)}`,
      `${sudoPrefix} systemctl daemon-reload`,
    ];
    if (options.enableService) {
      overrideCommands.push(`${sudoPrefix} systemctl enable ollama`);
    }
    overrideCommands.push(
      `${sudoPrefix} systemctl --no-block restart ollama`,
      "for _ in $(seq 1 30); do",
      `  current_state=$(${sudoPrefix} systemctl show ollama --property=ActiveEnterTimestampMonotonic --property=MainPID --value 2>/dev/null | tr '\\n' ' ')`,
      `  if [ "$current_state" != "$pre_state" ] && ${sudoPrefix} systemctl is-active --quiet ollama; then exit 0; fi`,
      "  sleep 1",
      "done",
      "exit 1",
    );
    const overrideResult = runShell(overrideCommands.join("\n"), {
      ignoreError: true,
      timeout: 45_000,
    });
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

export function ensureManagedOllamaLoopbackSystemdOverride(
  options: Omit<OllamaLoopbackSystemdOverrideOptions, "enableService"> = {},
): OllamaLoopbackSystemdOverrideState {
  return ensureOllamaLoopbackSystemdOverride({ ...options, enableService: true });
}

function splitSystemdEnvironmentTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      current += ch + value[i + 1];
      i += 1;
      continue;
    }
    if ((ch === '"' || ch === "'") && (quote === null || quote === ch)) {
      quote = quote === ch ? null : ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch) && quote === null) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function systemdEnvironmentTokenName(token: string): string | null {
  const unquoted = token.replace(/^(["'])(.*)\1$/, "$2");
  const match = unquoted.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  return match ? match[1] : null;
}

function rewriteEnvironmentLineWithoutManagedAssignments(
  line: string,
  managedNames: ReadonlySet<string>,
): string[] {
  if (/^\s*[#;]/.test(line)) return [line];
  const match = line.match(/^(\s*Environment\s*=\s*)(.*)$/);
  if (!match) return [line];
  const tokens = splitSystemdEnvironmentTokens(match[2]);
  const kept = tokens.filter((token) => {
    const name = systemdEnvironmentTokenName(token);
    return !name || !managedNames.has(name);
  });
  if (kept.length === tokens.length) return [line];
  return kept.length > 0 ? [`${match[1]}${kept.join(" ")}`] : [];
}

export function mergeOllamaLoopbackSystemdOverride(
  existingDropIn: string,
  options: { libraryOverride?: string | null } = {},
): string {
  const desiredLine = `Environment="OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}"`;
  const desiredContextLine = `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`;
  const desiredLibraryLine = options.libraryOverride
    ? `Environment="OLLAMA_LLM_LIBRARY=${options.libraryOverride}"`
    : null;
  const lines = existingDropIn.trimEnd().length > 0 ? existingDropIn.trimEnd().split(/\r?\n/) : [];
  const serviceStart = lines.findIndex((line) => /^\s*\[Service\]\s*(?:[#;].*)?$/.test(line));
  if (serviceStart === -1) {
    return (
      [
        ...lines,
        ...(lines.length > 0 ? [""] : []),
        "[Service]",
        desiredLine,
        desiredContextLine,
        ...(desiredLibraryLine ? [desiredLibraryLine] : []),
      ].join("\n") + "\n"
    );
  }

  let serviceEnd = lines.length;
  for (let i = serviceStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*(?:[#;].*)?$/.test(lines[i])) {
      serviceEnd = i;
      break;
    }
  }

  // Strip NemoClaw-managed assignments inside [Service] before re-appending.
  // Preserve unrelated variables that share the same systemd Environment= line
  // so operator-supplied daemon settings such as OLLAMA_ORIGINS survive repair.
  const serviceBody = lines.slice(serviceStart + 1, serviceEnd);
  const managedNames = new Set(["OLLAMA_HOST", "OLLAMA_CONTEXT_LENGTH"]);
  if (desiredLibraryLine) managedNames.add("OLLAMA_LLM_LIBRARY");
  const parseContextValue = (line: string): number | null => {
    const m = line.match(/\bOLLAMA_CONTEXT_LENGTH=("?)(\d+)\1/);
    return m ? parseInt(m[2], 10) : null;
  };
  const existingHigherContext = serviceBody
    .filter((line) => !/^\s*[#;]/.test(line) && /\bOLLAMA_CONTEXT_LENGTH=/.test(line))
    .map(parseContextValue)
    .filter((v): v is number => v !== null && v > MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW)
    .sort((a, b) => b - a)[0];
  const contextLine = existingHigherContext
    ? `Environment="OLLAMA_CONTEXT_LENGTH=${existingHigherContext}"`
    : desiredContextLine;
  const filteredBody = serviceBody.flatMap((line) =>
    rewriteEnvironmentLineWithoutManagedAssignments(line, managedNames),
  );
  const rebuilt = [
    ...lines.slice(0, serviceStart + 1),
    ...filteredBody,
    desiredLine,
    contextLine,
    ...(desiredLibraryLine ? [desiredLibraryLine] : []),
    ...lines.slice(serviceEnd),
  ];
  return rebuilt.join("\n") + "\n";
}
