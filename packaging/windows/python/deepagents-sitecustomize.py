# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Windows compatibility loaded only by the staged Deep Agents Python runtime."""

import os
from pathlib import Path


if os.name == "nt":

    def _preserve_inherited_windows_dacl(*_args: object, **_kwargs: object) -> None:
        """Keep the MXC-approved inherited DACL instead of applying a POSIX mode."""

    Path.chmod = _preserve_inherited_windows_dacl  # type: ignore[method-assign]
