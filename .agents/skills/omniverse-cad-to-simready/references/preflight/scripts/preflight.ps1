# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = if ($env:PYTHON) { $env:PYTHON } else { "py" }

if ($Python -eq "py") {
    & py -3.12 (Join-Path $ScriptDir "preflight.py") @args
} else {
    & $Python (Join-Path $ScriptDir "preflight.py") @args
}
exit $LASTEXITCODE
