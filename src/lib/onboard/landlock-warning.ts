// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function parseKernelMajorMinor(value: string): { major: number; minor: number } | null {
  const parts = value.split(".");
  const major = parseInt(parts[0] ?? "", 10);
  const minor = parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return null;
  return { major, minor };
}

function warnIfUnsupported(kernel: string, label: string, warn: (message: string) => void): void {
  const parsed = parseKernelMajorMinor(kernel);
  if (!parsed || parsed.major > 5 || (parsed.major === 5 && parsed.minor >= 13)) return;
  warn(`  ⚠ Landlock: ${label} ${kernel} does not support Landlock (requires ≥5.13).`);
  warn("    Sandbox filesystem restrictions will silently degrade (best_effort mode).");
}

export function warnIfLandlockUnsupported({
  platform = process.platform,
  dockerInfoFormat,
  runCapture,
  warn = console.warn,
}: {
  platform?: NodeJS.Platform;
  dockerInfoFormat: (format: string, options?: { ignoreError?: boolean }) => string;
  runCapture: (args: string[], options?: { ignoreError?: boolean }) => string;
  warn?: (message: string) => void;
}): void {
  try {
    if (platform === "darwin") {
      const vmKernel = dockerInfoFormat("{{.KernelVersion}}", { ignoreError: true }).trim();
      if (vmKernel) warnIfUnsupported(vmKernel, "Docker VM kernel", warn);
    } else if (platform === "linux") {
      const uname = runCapture(["uname", "-r"], { ignoreError: true }).trim();
      if (uname) warnIfUnsupported(uname, "Kernel", warn);
    }
  } catch {
    /* best effort warning */
  }
}
