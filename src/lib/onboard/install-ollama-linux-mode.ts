// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PORT } from "../core/ports";

const { runCapture, runCaptureEx }: typeof import("../runner") = require("../runner");

export type InstallOllamaLinuxMode = "system" | "user-local";

export type InstallOllamaLinuxModeOptions = {
  /** Returns true when onboard is running headless. */
  isNonInteractive: () => boolean;
  /** Test seam: override the auto-detected install mode. */
  modeOverride?: InstallOllamaLinuxMode;
  /** Test seam: override the `sudo -n true` probe result. */
  canSudoNonInteractive?: () => boolean;
  /** Test seam: override `process.getuid()`. */
  getEuid?: () => number | undefined;
  /** Test seam: override stdin TTY detection. */
  isTty?: () => boolean;
  /** Test seam: override `runCapture`. */
  runCaptureImpl?: typeof runCapture;
  /** Test seam: override `runCaptureEx`. */
  runCaptureExImpl?: typeof runCaptureEx;
  /** Test seam: redirect error output. */
  errorLog?: (message: string) => void;
  /** When true the running daemon is the upgrade target. */
  isUpgrade?: boolean;
};

const INSTALL_MODE_ENV = "NEMOCLAW_OLLAMA_INSTALL_MODE";

/**
 * Resolve the install mode.
 *
 * Order of precedence (highest first):
 *  1. The `NEMOCLAW_OLLAMA_INSTALL_MODE` env var when set to `user` or
 *     `system`. Any other value is rejected.
 *  2. Running as root (`euid === 0`) → `system` (no sudo required).
 *  3. Passwordless sudo available (`sudo -n true` returns 0) → `system`.
 *  4. Non-interactive context (either the `NEMOCLAW_NON_INTERACTIVE=1` flag
 *     or no TTY attached to stdin) → `user-local`. This is the path that
 *     fixes #4114: a headless run that cannot prompt for a sudo password
 *     falls back to a sudo-free user-local install instead of crashing
 *     mid-install.
 *  5. Interactive shell → `system` (sudo can prompt the user for a password).
 */
export function decideInstallOllamaLinuxMode(
  opts: InstallOllamaLinuxModeOptions,
): InstallOllamaLinuxMode {
  if (opts.modeOverride) return opts.modeOverride;
  const explicit = String(process.env[INSTALL_MODE_ENV] || "").trim().toLowerCase();
  if (opts.isUpgrade && explicit === "user") rejectUserLocalUpgrade(opts);
  if (explicit === "user") return "user-local";

  const getEuid = opts.getEuid ?? (() => process.getuid?.());
  const isTty = opts.isTty ?? (() => Boolean(process.stdin.isTTY));
  if (shouldRejectHeadlessSystemUpgrade(opts, getEuid, isTty)) {
    rejectHeadlessSystemUpgrade(opts);
  }
  if (explicit === "system") return "system";
  if (explicit) rejectUnknownMode(explicit, opts);
  if (getEuid() === 0) return "system";
  if (canRunSudoNonInteractive(opts)) return "system";
  if (opts.isUpgrade) return "system";
  if (opts.isNonInteractive() || !isTty()) return "user-local";
  return "system";
}

export function hostCommandExists(
  name: string,
  opts: Pick<InstallOllamaLinuxModeOptions, "runCaptureImpl">,
): boolean {
  const runCaptureImpl = opts.runCaptureImpl ?? runCapture;
  return !!runCaptureImpl(["sh", "-c", 'command -v "$1"', "--", name], {
    ignoreError: true,
  });
}

function canRunSudoNonInteractive(opts: InstallOllamaLinuxModeOptions): boolean {
  if (opts.canSudoNonInteractive) return opts.canSudoNonInteractive();
  const runCaptureExImpl = opts.runCaptureExImpl ?? runCaptureEx;
  if (!hostCommandExists("sudo", opts)) return false;
  const result = runCaptureExImpl(["sudo", "-n", "true"], { timeout: 2_000 });
  return result.exitCode === 0;
}

function shouldRejectHeadlessSystemUpgrade(
  opts: InstallOllamaLinuxModeOptions,
  getEuid: () => number | undefined,
  isTty: () => boolean,
): boolean {
  return (
    !!opts.isUpgrade
    && getEuid() !== 0
    && !canRunSudoNonInteractive(opts)
    && (opts.isNonInteractive() || !isTty())
  );
}

function rejectUserLocalUpgrade(opts: InstallOllamaLinuxModeOptions): never {
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  errorLog(
    `  ${INSTALL_MODE_ENV}=user is incompatible with the Ollama upgrade path:`,
  );
  errorLog(
    `  user-local install cannot replace the system daemon that owns :${OLLAMA_PORT}.`,
  );
  errorLog(
    `  Unset ${INSTALL_MODE_ENV} (or set it to 'system') and rerun, or upgrade Ollama manually.`,
  );
  process.exit(1);
}

function rejectHeadlessSystemUpgrade(opts: InstallOllamaLinuxModeOptions): never {
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  errorLog(
    "  Upgrading the system Ollama requires sudo, which is not available in this non-interactive run.",
  );
  errorLog(
    "  Run interactively, configure passwordless sudo, or upgrade manually: curl -fsSL https://ollama.com/install.sh | sh",
  );
  process.exit(1);
}

function rejectUnknownMode(explicit: string, opts: InstallOllamaLinuxModeOptions): never {
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  errorLog(
    `  Unsupported ${INSTALL_MODE_ENV} value: ${explicit}. Use 'system', 'user', or leave it unset.`,
  );
  process.exit(1);
}
