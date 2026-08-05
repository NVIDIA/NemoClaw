// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HERMES_WHATSAPP_SESSION_PATH = "/sandbox/.hermes/platforms/whatsapp/session";
const HERMES_WHATSAPP_BRIDGE_PATHS = new Set([
  "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
  "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js",
]);

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
  // independent --session values. The channel runtime preload is the shared boundary where
  // both launchers can be reconciled; the rendered manifest session_path does not control
  // those launcher arguments. Keep the two owned paths and this regression together, and
  // remove the preload once both upstream launchers honor one manifest-owned session path.
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

applyHermesWhatsappSessionPatch(process.argv);
