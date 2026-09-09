// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Win32;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeMaintenance
{
    private const string ProductUpgradeCode = "{52718EC2-AD6D-4A84-9FBF-3D73C9B11864}";
    private const string BundleUpgradeCode = "{1BA739B8-B632-4A8C-BB02-95058CC3A960}";

    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiEnumRelatedProductsW(string upgradeCode, uint reserved, uint index, StringBuilder productCode);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern int MsiQueryProductStateW(string productCode);

    internal static bool HasRelatedInstallation()
    {
        for (uint index = 0; index < 32; index++)
        {
            var code = new StringBuilder(39);
            var status = MsiEnumRelatedProductsW(ProductUpgradeCode, 0, index, code);
            if (status == 259) return false;
            if (status != 0) throw new InvalidOperationException("Windows could not inspect related NemoClaw installations.");
            if (MsiQueryProductStateW(code.ToString()) == 5) return true;
        }
        throw new InvalidOperationException("The related NemoClaw installation list exceeds its bound.");
    }

    internal static bool SupportsDataRemoval()
    {
        var launcher = NativeSetupOperations.InstalledLauncher();
        var root = Directory.GetParent(Path.GetDirectoryName(launcher)!)!.FullName;
        return File.Exists(launcher) && File.Exists(Path.Combine(root, "qualification", "native-remove-data.mts"));
    }

    internal static int RunInstalledInstaller()
    {
        if (!HasRelatedInstallation()) return NativeOnboarding.Run(null);
        var path = FindCachedBundle() ?? throw new InvalidOperationException("Windows cannot locate the registered NemoClaw installer. Open the original NemoClaw installer to repair or uninstall this installation.");
        // The registered Burn copy runs outside Program Files, so uninstall does
        // not attempt to delete the executable that is controlling the change.
        using var child = Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true,
            WorkingDirectory = Path.GetDirectoryName(path)! });
        return child is null ? 1 : 0;
    }

    private static string? FindCachedBundle()
    {
        var matches = new List<(Version Version, string Path)>();
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            using var uninstall = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
            if (uninstall is null) continue;
            var names = uninstall.GetSubKeyNames();
            if (names.Length > 16384) throw new InvalidOperationException("The installed-application registry exceeds its bound.");
            foreach (var name in names)
            {
                if (!Guid.TryParse(name, out _)) continue;
                using var entry = uninstall.OpenSubKey(name);
                var codes = entry?.GetValue("BundleUpgradeCode") switch { string[] values => values, string value => new[] { value }, _ => Array.Empty<string>() };
                if (!codes.Any(value => string.Equals(value, BundleUpgradeCode, StringComparison.OrdinalIgnoreCase))) continue;
                if (entry?.GetValue("BundleCachePath") is not string path || !Version.TryParse(entry.GetValue("DisplayVersion") as string, out var version)) continue;
                var cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Package Cache");
                var full = Path.GetFullPath(path);
                if (!full.StartsWith(cache + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(Path.GetExtension(full), ".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) continue;
                for (var item = full; !string.Equals(item, cache, StringComparison.OrdinalIgnoreCase); item = Path.GetDirectoryName(item)!)
                    if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("The registered installer cache contains a redirected filesystem entry.");
                if ((File.GetAttributes(cache) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("The registered installer cache is redirected.");
                matches.Add((version, full));
            }
        }
        return matches.OrderByDescending(value => value.Version).Select(value => value.Path).FirstOrDefault();
    }

    internal static async Task<int> RunRelatedActionAsync(bool uninstall)
    {
        var path = FindCachedBundle() ?? throw new InvalidOperationException("The registered NemoClaw installer is missing. Open its original installer to continue maintenance.");
        var start = new ProcessStartInfo { FileName = path, UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(path)! };
        start.ArgumentList.Add(uninstall ? "-uninstall" : "-repair");
        start.ArgumentList.Add("-quiet"); start.ArgumentList.Add("-norestart");
        using var child = Process.Start(start) ?? throw new InvalidOperationException("The registered installer could not start.");
        // Windows Installer owns rollback; never kill a live maintenance operation.
        await child.WaitForExitAsync();
        return child.ExitCode;
    }

    internal static async Task RemoveAgentDataAsync(IEnumerable<string> selectedAgents)
    {
        if (!SupportsDataRemoval())
            throw new InvalidOperationException("This older preview preserves agent data. Install the current preview before using selective data removal.");
        var agents = selectedAgents.Distinct(StringComparer.Ordinal).ToArray();
        if (agents.Length == 0 || agents.Any(agent => !NativeDesktopIntegration.Agents.Contains(agent, StringComparer.Ordinal)))
            throw new InvalidOperationException("Select the agent data to remove.");
        var launcher = NativeSetupOperations.InstalledLauncher();
        foreach (var agent in agents)
            await RunOwnedHelperAsync(launcher, new[] { "--remove-native-data", "--agent", agent },
                "The selected agent data could not be removed. Stop its active session before trying again.");
    }

    internal static async Task StopSharedInferenceAsync(Action? reportProgress = null)
    {
        var launcher = NativeSetupOperations.InstalledLauncher();
        var root = Directory.GetParent(Path.GetDirectoryName(launcher)!)!.FullName;
        // Earlier preview launchers interpret unknown options as application
        // launch. Never send them a native inference maintenance command.
        if (!File.Exists(launcher) || !File.Exists(Path.Combine(root, "qualification", "native-inference-cli.mts"))) return;
        reportProgress?.Invoke();
        await RunOwnedHelperAsync(launcher, new[] { "--native-inference", "stop" },
            "The shared local model could not stop safely. Close its active sessions before continuing maintenance.");
    }

    private static async Task RunOwnedHelperAsync(string launcher, string[] arguments, string failure)
    {
        var start = new ProcessStartInfo { FileName = launcher, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var child = Process.Start(start) ?? throw new InvalidOperationException(failure);
        child.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        try
        {
            await Task.WhenAll(DiscardBoundedAsync(child.StandardOutput, timeout.Token), DiscardBoundedAsync(child.StandardError, timeout.Token), child.WaitForExitAsync(timeout.Token));
            if (child.ExitCode != 0) throw new InvalidOperationException(failure);
        }
        finally
        {
            if (!child.HasExited) { child.Kill(entireProcessTree: true); using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await child.WaitForExitAsync(cleanup.Token); }
        }
    }

    private static async Task DiscardBoundedAsync(StreamReader reader, CancellationToken cancellation)
    {
        var buffer = new char[512];
        var total = 0;
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellation)) != 0)
        {
            total += count;
            Array.Clear(buffer);
            if (total > 4096) throw new InvalidOperationException("The native data owner exceeded its output bound.");
        }
    }
}
