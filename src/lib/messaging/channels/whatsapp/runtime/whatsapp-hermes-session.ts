// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const HERMES_WHATSAPP_SESSION_PATH = "/sandbox/.hermes/platforms/whatsapp/session";
export const HERMES_MANAGED_ENV_PATH = "/sandbox/.hermes/.env";
const HERMES_WHATSAPP_BRIDGE_PATHS = new Set([
  "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
  "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js",
  "/opt/hermes/scripts/whatsapp-bridge/bridge.js",
]);
const HERMES_WHATSAPP_PAIRING_BRIDGE_PATHS = [
  "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
  "/opt/hermes/scripts/whatsapp-bridge/bridge.js",
] as const;

function isHermesWhatsappBridge(scriptPath: string | undefined): boolean {
  return scriptPath !== undefined && HERMES_WHATSAPP_BRIDGE_PATHS.has(scriptPath);
}

export function normalizeHermesWhatsappSessionArgv(argv: string[]): boolean {
  if (!isHermesWhatsappBridge(argv[1])) return false;

  const sessionIndexes = argv.reduce<number[]>((indexes, value, index) => {
    if (value === "--session") indexes.push(index);
    return indexes;
  }, []);
  const sessionIndex = sessionIndexes.length === 1 ? sessionIndexes[0] : undefined;
  const sessionValue = sessionIndex === undefined ? undefined : argv[sessionIndex + 1];
  if (sessionIndex === undefined || !sessionValue || sessionValue.startsWith("-")) {
    throw new Error(
      "Hermes WhatsApp bridge did not provide exactly one session path; refusing split session state",
    );
  }

  // Hermes currently launches its dashboard and gateway bridge from different homes with
  // independent --session values. Both command-construction sites belong to the upstream
  // Hermes distribution installed into the image rather than NemoClaw's manifest renderer,
  // so the rendered manifest session_path cannot change those arguments here. The channel
  // runtime preload is the shared boundary where both launchers can be reconciled. Keep the
  // two owned paths and this regression together, and remove the preload once both upstream
  // launchers honor one manifest-owned session path.
  argv[sessionIndex + 1] = HERMES_WHATSAPP_SESSION_PATH;
  return true;
}

export function applyHermesWhatsappSessionPatch(
  argv: string[],
  setUmask: (mode: number) => unknown = (mode) => process.umask(mode),
): boolean {
  if (!normalizeHermesWhatsappSessionArgv(argv)) return false;
  // The dashboard and gateway run as separate users in the shared sandbox
  // group. Keep pairing state read-write for that group without granting world access.
  setUmask(0o007);
  return true;
}

export interface HermesWhatsappPairingDependencies {
  readonly envPath?: string;
  readonly sessionPath?: string;
  readonly bridgePaths?: readonly string[];
  readonly nodePath?: string;
  readonly spawn?: typeof spawnSync;
  readonly setUmask?: (mode: number) => unknown;
  readonly write?: (message: string) => void;
}

function readManagedWhatsappEnvironment(envPath: string): NodeJS.ProcessEnv {
  const file = lstatSync(envPath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error("Hermes managed environment is not a regular file");
  }
  const selected: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key !== "WHATSAPP_MODE" && key !== "WHATSAPP_ALLOWED_USERS") continue;
    let value = rawValue ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    selected[key] = value;
  }
  if (selected.WHATSAPP_MODE !== "bot" && selected.WHATSAPP_MODE !== "self-chat") {
    throw new Error("Hermes managed WhatsApp mode is missing or invalid");
  }
  return selected;
}

function requireRegularPath(path: string, description: string): void {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error(`${description} is not a regular file`);
  }
}

export function runHermesWhatsappPairing(
  dependencies: HermesWhatsappPairingDependencies = {},
): number {
  const envPath = dependencies.envPath ?? HERMES_MANAGED_ENV_PATH;
  const sessionPath = dependencies.sessionPath ?? HERMES_WHATSAPP_SESSION_PATH;
  const bridgePaths = dependencies.bridgePaths ?? HERMES_WHATSAPP_PAIRING_BRIDGE_PATHS;
  const bridgePath = bridgePaths.find((candidate) => existsSync(candidate));
  if (!bridgePath) {
    throw new Error("Hermes WhatsApp bridge is unavailable");
  }
  requireRegularPath(bridgePath, "Hermes WhatsApp bridge");
  if (existsSync(sessionPath)) {
    const session = lstatSync(sessionPath);
    if (!session.isDirectory() || session.isSymbolicLink()) {
      throw new Error("Hermes WhatsApp session path is not a directory");
    }
  } else {
    mkdirSync(sessionPath, { recursive: true, mode: 0o770 });
  }

  const whatsappEnvironment = readManagedWhatsappEnvironment(envPath);
  const write = dependencies.write ?? ((message) => process.stdout.write(message));
  write("\n⚕ WhatsApp Setup\n==================================================\n\n");
  write("NemoClaw manages the WhatsApp mode and sender allowlist from the host.\n");
  write(`Session: ${sessionPath}\n\n`);
  write("Open WhatsApp on the phone, then use Settings → Linked Devices → Link a Device.\n\n");

  (dependencies.setUmask ?? ((mode) => process.umask(mode)))(0o007);
  const result = (dependencies.spawn ?? spawnSync)(
    dependencies.nodePath ?? process.execPath,
    [bridgePath, "--pair-only", "--session", sessionPath],
    {
      cwd: dirname(bridgePath),
      env: { ...process.env, ...whatsappEnvironment },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

applyHermesWhatsappSessionPatch(process.argv);

if (require.main === module) {
  try {
    process.exitCode = runHermesWhatsappPairing();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`Hermes WhatsApp pairing failed: ${message}\n`);
    process.exitCode = 1;
  }
}
