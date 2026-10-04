// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep sandbox-only consumers behind one boundary so the canonical validation
// implementation does not become a high-fan-in dependency.
export {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
  NAME_VALID_PATTERN,
} from "./name-validation";
