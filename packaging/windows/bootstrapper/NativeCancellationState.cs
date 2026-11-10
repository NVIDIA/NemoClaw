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

    internal static string? FailureDetail(int status, bool executionStarted)
    {
        if (status is not (1223 or 1602 or unchecked((int)0x800704c7) or unchecked((int)0x80070642)))
            return null;
        return executionStarted
            ? "Setup was canceled after Windows started making changes. Review the setup log before opening the installer again."
            : "Setup was canceled before Windows started changing application files. Close setup and open the installer again to retry. Approve the Windows permission prompt when it appears.";
    }
}
