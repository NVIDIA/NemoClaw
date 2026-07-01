// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Test harness helpers for whatsapp-qr-compact.test.ts. The Module._load hook
// (which branches on the resolved request path) lives here so the test body
// stays linear; it reuses the same shape-detect + patch helpers as the runtime.

import {
  isQrcodePackage,
  isQrcodeTerminalPackage,
  patchQrcode,
  patchQrcodeTerminal,
} from "./whatsapp-qr-compact";

/**
 * Build a Module._load wrapper identical to the runtime's: for the given
 * absolute path it returns `patchedModule`, applies the compact patch to any
 * request whose string contains "qrcode", and passes everything else through.
 */
export function makeQrcodeLoadHook(
  absolutePath: string,
  patchedModule: unknown,
): (request: unknown, ...rest: unknown[]) => unknown {
  return function (request: unknown, ..._rest: unknown[]) {
    const loaded = request === absolutePath ? patchedModule : {};
    const isQrcodeRequest = typeof request === "string" && request.indexOf("qrcode") !== -1;
    const patched = isQrcodePackage(loaded)
      ? patchQrcode(loaded)
      : isQrcodeTerminalPackage(loaded)
        ? patchQrcodeTerminal(loaded)
        : loaded;
    return isQrcodeRequest ? patched : loaded;
  };
}
