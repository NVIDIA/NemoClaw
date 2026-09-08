// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const N1X_WSL_PRODUCT_NAME_MAX_BYTES = 256;
const N1X_WSL_PRODUCT_PROBE_TIMEOUT_MS = 10_000;
const N1X_WSL_PRODUCT_PATTERN = /(?:^|\s)RTX Spark N1X(?:$|\s)/i;

export interface N1xWslProductOptions {
  isWsl?: boolean;
  runCaptureImpl?: (
    command: readonly string[],
    options?: { ignoreError?: boolean; timeout?: number },
  ) => string;
}

export function isN1xWslProductName(value: string): boolean {
  return N1X_WSL_PRODUCT_PATTERN.test(value.trim());
}

export function collectN1xWslProduct(options: N1xWslProductOptions): boolean | undefined {
  if (!options.isWsl || !options.runCaptureImpl) return undefined;
  try {
    const raw = options.runCaptureImpl(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystem).Model",
      ],
      { ignoreError: true, timeout: N1X_WSL_PRODUCT_PROBE_TIMEOUT_MS },
    );
    const normalized = String(raw ?? "")
      .replace(/\r/g, "")
      .trim();
    if (
      !normalized ||
      normalized.includes("\0") ||
      normalized.includes("\n") ||
      Buffer.byteLength(normalized, "utf8") > N1X_WSL_PRODUCT_NAME_MAX_BYTES
    ) {
      return undefined;
    }
    return isN1xWslProductName(normalized);
  } catch {
    return undefined;
  }
}
