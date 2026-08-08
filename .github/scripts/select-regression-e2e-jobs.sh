#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

normalized="$(printf '%s' "${JOBS:-}" | tr -d '[:space:]')"
case ",${normalized}," in
  ,, | *,whatsapp-qr-compact-e2e,*)
    selected=true
    ;;
  *)
    selected=false
    ;;
esac
printf 'whatsapp_qr_compact=%s\n' "$selected" >>"${GITHUB_OUTPUT:?}"
