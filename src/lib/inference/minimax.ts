// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MINIMAX_PROVIDER_KEY = "minimax";
export const MINIMAX_PROVIDER_NAME = "minimax-api";
export const MINIMAX_CREDENTIAL_ENV = "MINIMAX_API_KEY";
export const MINIMAX_ENDPOINT_URL = "https://api.minimax.io/v1";
export const MINIMAX_HELP_URL = "https://platform.minimax.io/docs/api-reference/api-overview";
export const MINIMAX_DEFAULT_MODEL = "MiniMax-M3";
export const MINIMAX_MODEL_OPTIONS = [MINIMAX_DEFAULT_MODEL, "MiniMax-M2.7"] as const;

const MINIMAX_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "minimax-m3": 1_000_000,
  "minimax-m2.7": 204_800,
};

export function getMiniMaxContextWindow(model: string): number | null {
  return MINIMAX_CONTEXT_WINDOWS[model.trim().toLowerCase()] ?? null;
}

export function isMiniMaxImageInputModel(model: string | null | undefined): boolean {
  return model?.trim().toLowerCase() === MINIMAX_DEFAULT_MODEL.toLowerCase();
}
