// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential, normalizeCredentialValue } from "../credentials/store";

export function getMessagingToken(envKey: string | undefined): string | null {
  if (!envKey) return null;
  return getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;
}
