#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Checks that all given files contain the required SPDX license headers.
# Usage: check-spdx-headers.sh file1 file2 ...

set -euo pipefail

COPYRIGHT="SPDX-FileCopyrightText: Copyright (c)"
LICENSE="SPDX-License-Identifier: Apache-2.0"

failed=0
for file in "$@"; do
  file_head="$(head -n 5 -- "$file")"
  if ! grep -Fq "$COPYRIGHT" <<<"$file_head"; then
    echo "Missing SPDX-FileCopyrightText: $file"
    failed=1
  fi
  if ! grep -Fq "$LICENSE" <<<"$file_head"; then
    echo "Missing SPDX-License-Identifier: $file"
    failed=1
  fi
done

exit $failed
