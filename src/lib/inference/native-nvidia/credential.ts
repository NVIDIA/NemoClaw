// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Read only the opaque value OpenShell issues to this process. Reject raw keys,
// canonical aliases and malformed values before either a request or host read.
export const NATIVE_NVIDIA_CREDENTIAL_GUARD = [
  'case "${NVIDIA_INFERENCE_API_KEY-}" in ""|*[!a-zA-Z0-9_:]*) exit 78 ;; esac',
  `printf '%s\\n' "$NVIDIA_INFERENCE_API_KEY" | grep -Eq '^openshell:resolve:env:(v[0-9]{1,20}|s[a-f0-9]{64})_NVIDIA_INFERENCE_API_KEY$' || exit 78`,
].join("; ");

export const NATIVE_NVIDIA_AUTH_HEADER_ARG = '-H "Authorization: Bearer $NVIDIA_INFERENCE_API_KEY"';
