// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactFullWithUrls } from "../security/redact";

/** Fully redact credential-shaped content from a diagnostic string. */
export function redactDiagnosticText(text: string): string {
  return redactFullWithUrls(text);
}
