// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function normalizeReasoningFlag(value: string | null | undefined): "true" | "false" | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y") {
    return "true";
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "n") {
    return "false";
  }
  return null;
}

export async function configureCompatibleEndpointReasoning(
  storedValue?: string | null,
): Promise<"true" | "false"> {
  const configured = normalizeReasoningFlag(storedValue ?? process.env.NEMOCLAW_REASONING);
  process.env.NEMOCLAW_REASONING = configured ?? "false";
  return process.env.NEMOCLAW_REASONING as "true" | "false";
}

export function clearCompatibleEndpointReasoning(): null {
  delete process.env.NEMOCLAW_REASONING;
  return null;
}
