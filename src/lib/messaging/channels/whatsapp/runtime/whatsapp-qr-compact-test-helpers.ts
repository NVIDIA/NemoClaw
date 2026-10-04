// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Test harness helpers for whatsapp-qr-compact.test.ts. The Module._load hook
// keeps the test body linear; the routing decision itself reuses the runtime's
// exported resolvePatchedModule so the test exercises real production logic
// rather than a re-implemented copy.

import { resolvePatchedModule } from "./whatsapp-qr-compact";

/**
 * Build a Module._load wrapper identical to the runtime's: for the given
 * absolute path it returns `patchedModule`, otherwise a bare object, then
 * delegates to the runtime's resolvePatchedModule so patching happens only for
 * qrcode-shaped requests and never leaks onto passthrough modules.
 */
export function makeQrcodeLoadHook(
  absolutePath: string,
  patchedModule: unknown,
): (request: unknown, ...rest: unknown[]) => unknown {
  return function (request: unknown, ..._rest: unknown[]) {
    const loaded = request === absolutePath ? patchedModule : {};
    return resolvePatchedModule(request, loaded);
  };
}
