// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.IO;
using System.Runtime.InteropServices;
using WixToolset.BootstrapperApplicationApi;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        var startupLog = Path.Combine(
            Path.GetTempPath(),
            $"NemoClaw.Bootstrapper.{Environment.ProcessId}.startup.log");
        try
        {
            File.WriteAllText(startupLog, "Managed entrypoint reached." + Environment.NewLine);
            var application = new NemoClawBootstrapperApplication();
            File.AppendAllText(startupLog, "Bootstrapper application constructed." + Environment.NewLine);
            ManagedBootstrapperApplication.Run(application);
            File.Delete(startupLog);
            return 0;
        }
        catch (Exception error)
        {
            File.AppendAllText(startupLog, error.ToString() + Environment.NewLine);
            return Marshal.GetHRForException(error);
        }
    }
}
