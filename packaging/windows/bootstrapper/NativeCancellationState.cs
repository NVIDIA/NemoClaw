// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed class NativeCancellationState
{
    internal bool IsRequested { get; private set; }

    internal void Request(CancellationTokenSource? active = null)
    {
        this.IsRequested = true;
        active?.Cancel();
    }

    internal void ResetForRetry() => this.IsRequested = false;
}
