// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared diagnostic-signal shape used by every per-channel health evaluator
 * (whatsapp-diagnostics.ts, telegram-diagnostics.ts, …) and the channels-status
 * renderer. Kept in one place so a report union across channels uses a single
 * `DiagnosticSignal` type instead of structurally-identical copies.
 */

export type DiagnosticSeverity = "ok" | "warn" | "fail" | "info";

export type DiagnosticSignal = {
  label: string;
  severity: DiagnosticSeverity;
  detail: string;
  hint?: string;
};
