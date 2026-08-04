// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const HERMES_WHATSAPP_SESSION_PATH = "/sandbox/.hermes/platforms/whatsapp/session";

function isHermesWhatsappBridge(scriptPath: string | undefined): boolean {
  if (!scriptPath) return false;
  return (
    path.basename(scriptPath) === "bridge.js" &&
    path.basename(path.dirname(scriptPath)) === "whatsapp-bridge"
  );
}

export function normalizeHermesWhatsappSessionArgv(argv: string[]): boolean {
  if (!isHermesWhatsappBridge(argv[1])) return false;

  const sessionIndexes = argv.reduce<number[]>((indexes, value, index) => {
    if (value === "--session") indexes.push(index);
    return indexes;
  }, []);
  if (sessionIndexes.length !== 1 || !argv[sessionIndexes[0] + 1]) {
    throw new Error(
      "Hermes WhatsApp bridge did not provide exactly one session path; refusing split session state",
    );
  }

  // Both Hermes homes always supply --session. Force the manifest-owned durable
  // location so dashboard pairing and gateway delivery cannot split state.
  argv[sessionIndexes[0] + 1] = HERMES_WHATSAPP_SESSION_PATH;
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
