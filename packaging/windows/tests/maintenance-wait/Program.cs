// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.Reflection;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class Program
{
    private static Process StartChild()
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("The test executable is unavailable.");
        var start = new ProcessStartInfo { FileName = executable, UseShellExecute = false, CreateNoWindow = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
        start.ArgumentList.Add("--child");
        return Process.Start(start) ?? throw new InvalidOperationException("The non-exiting maintenance fixture did not start.");
    }

    private static async Task AssertBoundedWaitAsync(bool cancel)
    {
        using var child = StartChild();
        using var cancellation = new CancellationTokenSource();
        if (cancel) cancellation.CancelAfter(TimeSpan.FromMilliseconds(100));
        var cached = @"C:\ProgramData\Package Cache\{maintenance-fixture}\NemoClawSetup.exe";
        try
        {
            await NativeMaintenance.WaitForRelatedActionAsync(child, cached, "uninstall", cancellation.Token,
                cancel ? TimeSpan.FromSeconds(10) : TimeSpan.FromMilliseconds(100));
            throw new InvalidOperationException("A non-exiting maintenance action was accepted.");
        }
        catch (InvalidOperationException error)
        {
            var expected = cancel ? "was cancelled" : "exceeded its deadline";
            if (!error.Message.Contains(expected, StringComparison.Ordinal) ||
                !error.Message.Contains("uninstall", StringComparison.Ordinal) ||
                !error.Message.Contains(cached, StringComparison.Ordinal) || child.HasExited)
                throw new InvalidOperationException("The recoverable maintenance result lost its action, cache path, or live-child guarantee.", error);
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync();
            }
        }
    }

    internal static async Task<int> Main(string[] args)
    {
        if (args is ["--child"])
        {
            await Task.Delay(Timeout.InfiniteTimeSpan);
            return 0;
        }
        await AssertBoundedWaitAsync(cancel: true);
        await AssertBoundedWaitAsync(cancel: false);
        Console.WriteLine("2 maintenance wait controls passed; cancellation and deadline leave Windows Installer alive.");
        return 0;
    }
}

internal static class NativeSetupOperations
{
    internal static string InstalledLauncher() => "unused";
}

internal static class NativeOnboarding
{
    internal static int Run(object? _) => 0;
}

internal static class NativeDesktopIntegration
{
    internal static readonly string[] Agents = ["openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua"];
}
