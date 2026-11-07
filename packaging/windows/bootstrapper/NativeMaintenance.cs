// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Win32;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeMaintenance
{
    private const string ProductUpgradeCode = "{52718EC2-AD6D-4A84-9FBF-3D73C9B11864}";
    private const string BundleUpgradeCode = "{1BA739B8-B632-4A8C-BB02-95058CC3A960}";

    // The operation deadline ended, not the external Windows Installer transaction.
    // Callers must not offer another maintenance action in this installer window.
    internal sealed class RelatedActionPendingException(string message, Exception inner)
        : InvalidOperationException(message, inner);

    internal static void CompleteRelatedAction(int code, Action completed, Action<string> restartRequired)
    {
        if (code is 3010 or 1641)
        {
            restartRequired(RestartMessage(code));
            return;
        }
        if (code != 0) throw new InvalidOperationException("Windows could not complete maintenance of the previous installation.");
        completed();
    }

    internal static int? RestartExitCode(int status, bool restartRequired, bool restartInitiated)
    {
        if (status < 0) return null;
        if (restartInitiated || status == 1641) return 1641;
        return restartRequired || status == 3010 ? 3010 : null;
    }

    internal static string RestartMessage(int code) => code == 1641
        ? "Windows is restarting to finish setup. Close this window and reopen the installer after Windows restarts."
        : "Windows requires a restart to finish setup. Close this window and restart Windows before reopening the installer.";

    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiEnumRelatedProductsW(string upgradeCode, uint reserved, uint index, StringBuilder productCode);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern int MsiQueryProductStateW(string productCode);

    internal static (bool RelatedOnly, bool RemovalAvailable)? InspectInstallation(bool installed,
        Func<bool>? inspectRelated = null, Func<bool>? inspectRemoval = null)
    {
        try
        {
            var relatedOnly = !installed && (inspectRelated ?? HasRelatedInstallation)();
            var removalAvailable = (inspectRemoval ?? SupportsDataRemoval)();
            return (relatedOnly, removalAvailable);
        }
        catch (Exception)
        {
            // An unreadable command contract must not expose maintenance actions.
            return null;
        }
    }

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
        return File.Exists(launcher) && (SupportsFinishedRuntime(root, launcher) || File.Exists(Path.Combine(root, "qualification", "native-remove-data.mts")));
    }

    internal static bool SupportsImmutableInstallation()
    {
        var launcher = NativeSetupOperations.InstalledLauncher();
        var root = Directory.GetParent(Path.GetDirectoryName(launcher)!)!.FullName;
        return File.Exists(launcher) && SupportsFinishedRuntime(root, launcher, requireUpgradeProtocol: true);
    }

    internal static bool SupportsFinishedRuntime(string root, string launcher, bool requireUpgradeProtocol = false)
    {
        var receipt = Path.Combine(root, "immutable-package-inputs.json");
        if (!File.Exists(receipt)) return false;
        // This only selects an installed command contract. The native command
        // still owns lease admission and credential/private-state authorization.
        if ((File.GetAttributes(receipt) & FileAttributes.ReparsePoint) != 0 ||
            (File.GetAttributes(launcher) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("The installed runtime contract is redirected.");
        using var input = new FileStream(receipt, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length is < 1 or > 65536) throw new InvalidDataException("The installed runtime contract exceeds its bound.");
        using var document = JsonDocument.Parse(input, new JsonDocumentOptions { MaxDepth = 8 });
        var value = document.RootElement;
        if (value.GetProperty("schemaVersion").GetInt32() != 1 || value.GetProperty("classification").GetString() != "immutable-package-inputs")
            throw new InvalidDataException("The installed runtime contract is invalid.");
        var native = value.GetProperty("launcher");
        var capabilities = native.GetProperty("capabilities");
        if (capabilities.GetProperty("schemaVersion").GetInt32() != 1 || capabilities.GetProperty("kind").GetString() != "native-runtime-capabilities" ||
            !capabilities.GetProperty("immutableRuntime").GetBoolean() || !capabilities.GetProperty("guardianEnabled").GetBoolean())
            throw new InvalidDataException("The installed runtime does not provide its guarded command contract.");
        using var executable = new FileStream(launcher, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (executable.Length is < 1 or > 32 * 1024 * 1024 ||
            Convert.ToHexString(SHA256.HashData(executable)).ToLowerInvariant() != native.GetProperty("launcherSha256").GetString())
            throw new InvalidDataException("The installed launcher differs from its command contract.");
        // This marker comes from the same-source immutable composition. A version
        // number alone cannot establish the cached bootstrapper's cleanup protocol.
        return !requireUpgradeProtocol || (value.TryGetProperty("hermesBundleUpgradeProtocol", out var protocol)
            && protocol.ValueKind == JsonValueKind.String && protocol.GetString() == "superseded-retirement-v1");
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

    internal static async Task<int?> PrepareHeadlessActionAsync(bool installed, bool uninstall,
        Func<Task> beginPlan, CancellationToken cancellation = default,
        Func<bool>? inspectRelated = null, Func<CancellationToken, Task>? stopInference = null,
        Func<bool, CancellationToken, Task<int>>? runRelated = null)
    {
        cancellation.ThrowIfCancellationRequested();
        var relatedOnly = !installed && (inspectRelated ?? HasRelatedInstallation)();
        await (stopInference ?? (token => StopSharedInferenceAsync(cancellation: token)))(cancellation);
        cancellation.ThrowIfCancellationRequested();
        if (relatedOnly)
            return await (runRelated ?? RunRelatedActionAsync)(uninstall, cancellation);
        await beginPlan();
        return null;
    }

    internal static async Task<int> RunRelatedActionAsync(bool uninstall, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        var path = FindCachedBundle() ?? throw new InvalidOperationException("The registered NemoClaw installer is missing. Open its original installer to continue maintenance.");
        var action = uninstall ? "uninstall" : "repair";
        var start = new ProcessStartInfo { FileName = path, UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(path)! };
        start.ArgumentList.Add("-" + action);
        start.ArgumentList.Add("-quiet"); start.ArgumentList.Add("-norestart");
        cancellation.ThrowIfCancellationRequested();
        using var child = Process.Start(start) ?? throw new InvalidOperationException("The registered installer could not start.");
        return await WaitForRelatedActionAsync(child, path, action, cancellation, TimeSpan.FromMinutes(30));
    }

    internal static async Task<int> WaitForRelatedActionAsync(Process child, string cachedBundle, string action,
        CancellationToken cancellation, TimeSpan deadline)
    {
        if (action is not ("repair" or "uninstall") || string.IsNullOrWhiteSpace(cachedBundle) || deadline <= TimeSpan.Zero)
            throw new ArgumentException("The registered installer wait contract is invalid.");
        using var timeout = new CancellationTokenSource(deadline);
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(cancellation, timeout.Token);
        try
        {
            await child.WaitForExitAsync(bounded.Token);
            // An exit code can precede the Windows process-handle signal.
            await Task.Run(() =>
            {
                while (!child.WaitForExit(0))
                {
                    bounded.Token.ThrowIfCancellationRequested();
                    child.WaitForExit(100);
                }
            });
            return child.ExitCode;
        }
        catch (OperationCanceledException error)
        {
            // Windows Installer owns rollback. Do not kill the external transaction
            // or expose a retry when its completion has not been established.
            var reason = cancellation.IsCancellationRequested ? "was cancelled" : "exceeded its deadline";
            throw new RelatedActionPendingException($"The cached NemoClaw installer {action} action {reason}; Windows Installer completion is unconfirmed. Cached bundle: {cachedBundle}. Close this window. Wait for that action to finish before reopening the installer.", error);
        }
    }

    internal static async Task RemoveAgentDataAsync(IEnumerable<string> selectedAgents, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        if (!SupportsDataRemoval())
            throw new InvalidOperationException("This older preview preserves agent data. Install the current preview before using selective data removal.");
        var agents = selectedAgents.Distinct(StringComparer.Ordinal).ToArray();
        if (agents.Length == 0 || agents.Any(agent => !NativeDesktopIntegration.Agents.Contains(agent, StringComparer.Ordinal)))
            throw new InvalidOperationException("Select the agent data to remove.");
        var launcher = NativeSetupOperations.InstalledLauncher();
        foreach (var agent in agents)
            await RunOwnedHelperAsync(launcher, new[] { "--remove-native-data", "--agent", agent },
                $"Removal of {agent} data did not finish. Some data or credentials may already be removed. Stop its active session, close applications using its files, then retry data removal.", cancellation);
    }

    internal static async Task StopSharedInferenceAsync(Action? reportProgress = null, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        var launcher = NativeSetupOperations.InstalledLauncher();
        var root = Directory.GetParent(Path.GetDirectoryName(launcher)!)!.FullName;
        // Earlier preview launchers interpret unknown options as application
        // launch. Never send them a native inference maintenance command.
        if (!File.Exists(launcher) || (!SupportsFinishedRuntime(root, launcher) && !File.Exists(Path.Combine(root, "qualification", "native-inference-cli.mts")))) return;
        reportProgress?.Invoke();
        await RunOwnedHelperAsync(launcher, new[] { "--native-inference", "stop" },
            "The local-model maintenance check failed. Setup has not started a new installer transaction.", cancellation);
    }

    internal static async Task RunOwnedHelperAsync(string launcher, string[] arguments, string failure, CancellationToken cancellation)
    {
        var start = new ProcessStartInfo { FileName = launcher, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        cancellation.ThrowIfCancellationRequested();
        using var child = Process.Start(start) ?? throw new InvalidOperationException(failure);
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        Exception? operationError = null;
        Exception? cleanupError = null;
        var runtimeUnavailable = false;
        try
        {
            child.StandardInput.Close();
            var diagnostic = ReadRuntimeUnavailableAsync(child.StandardError, timeout.Token);
            await Task.WhenAll(DiscardBoundedAsync(child.StandardOutput, timeout.Token), diagnostic, child.WaitForExitAsync(timeout.Token));
            runtimeUnavailable = child.ExitCode == 2 && await diagnostic;
            if (child.ExitCode != 0) throw new InvalidOperationException(failure);
        }
        catch (Exception error) { operationError = error; }
        finally
        {
            try
            {
                if (!child.WaitForExit(0))
                {
                    child.Kill(entireProcessTree: true);
                    if (!await Task.Run(() => child.WaitForExit(5000)))
                        throw new TimeoutException("The native maintenance helper did not stop within its cleanup deadline.");
                }
            }
            catch (Exception error) { cleanupError = error; }
        }
        if (operationError is not null || cleanupError is not null)
            throw new InvalidOperationException((runtimeUnavailable
                ? "The installed runtime is unavailable (runtime-unavailable). Maintenance cannot continue until the runtime is restored."
                : failure) +
                (operationError is OperationCanceledException ? " The operation timed out." : string.Empty) +
                (cleanupError is not null ? " Helper shutdown could not be confirmed." : string.Empty), operationError ?? cleanupError);
        // Let an already-started data removal or service stop finish safely.
        // Cancellation prevents the next helper or installer transaction.
        cancellation.ThrowIfCancellationRequested();
    }

    private static async Task<bool> ReadRuntimeUnavailableAsync(StreamReader reader, CancellationToken cancellation)
    {
        var buffer = new char[512];
        var diagnostic = new StringBuilder();
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellation)) != 0)
        {
            if (diagnostic.Length + count > 4096)
                throw new InvalidOperationException("The native data owner exceeded its output bound.");
            diagnostic.Append(buffer, 0, count);
            Array.Clear(buffer);
        }
        // Never put arbitrary helper output, paths, or credentials in the UI.
        return diagnostic.ToString().Trim() == "runtime-unavailable";
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
