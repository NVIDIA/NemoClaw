// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.IO;
using System.Runtime.InteropServices;
using WixToolset.BootstrapperApplicationApi;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class Program
{
    private static int Main(string[] arguments)
    {
        var startupLog = Path.Combine(
            Path.GetTempPath(),
            $"NemoClaw.Bootstrapper.{Environment.ProcessId}.startup.log");
        try
        {
            File.WriteAllText(startupLog, "Managed entrypoint reached." + Environment.NewLine);
            var exitCode = 0;
            if (arguments.Length == 1 && arguments[0] == "--installer")
            {
                exitCode = NativeMaintenance.RunInstalledInstaller();
            }
            else if (arguments.Length == 3 && arguments[0] == "--web-session" && arguments[1] == "--agent")
            {
                exitCode = NativeWebSession.Run(arguments[2]);
            }
            else if (arguments.Length > 0 && arguments[0] == "--onboard")
            {
                if (arguments.Length == 1) exitCode = NativeOnboarding.Run(null);
                else if (arguments.Length == 3 && arguments[1] == "--agent" &&
                    NativeDesktopIntegration.Agents.Contains(arguments[2], StringComparer.Ordinal))
                {
                    exitCode = NativeOnboarding.Run(arguments[2]);
                }
                else exitCode = 2;
            }
            else
            {
                var application = new NemoClawBootstrapperApplication();
                File.AppendAllText(startupLog, "Bootstrapper application constructed." + Environment.NewLine);
                ManagedBootstrapperApplication.Run(application);
            }
            try { File.Delete(startupLog); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return exitCode;
        }
        catch (Exception error)
        {
            try { File.AppendAllText(startupLog, error.ToString() + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return Marshal.GetHRForException(error);
        }
    }
}
