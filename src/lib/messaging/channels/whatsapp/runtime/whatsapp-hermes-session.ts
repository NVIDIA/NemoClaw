// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HERMES_WHATSAPP_SESSION_PATH = "/sandbox/.hermes/platforms/whatsapp/session";
const HERMES_DASHBOARD_WHATSAPP_BRIDGE_PATH =
  "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js";

function isHermesWhatsappBridge(scriptPath: string | undefined): boolean {
  return scriptPath === HERMES_DASHBOARD_WHATSAPP_BRIDGE_PATH;
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

  // The dashboard runs with an isolated HERMES_HOME, but its paired credentials must be
  // available to the gateway under the primary Hermes home. Keep upstream CLI and gateway
  // bridge arguments unchanged because Hermes already provides legacy-path compatibility.
  argv[sessionIndex + 1] = HERMES_WHATSAPP_SESSION_PATH;
  return true;
}

export function applyHermesWhatsappSessionPatch(
  argv: string[],
  setUmask: (mode: number) => unknown = (mode) => process.umask(mode),
): boolean {
  if (!normalizeHermesWhatsappSessionArgv(argv)) return false;
  // The dashboard and gateway run as separate users in the shared sandbox group.
  // Keep dashboard-paired credentials group-readable without granting world access.
  setUmask(0o007);
  return true;
}

applyHermesWhatsappSessionPatch(process.argv);
