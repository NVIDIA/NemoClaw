// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using WixToolset.BootstrapperApplicationApi;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        ManagedBootstrapperApplication.Run(new NemoClawBootstrapperApplication());
        return 0;
    }
}
