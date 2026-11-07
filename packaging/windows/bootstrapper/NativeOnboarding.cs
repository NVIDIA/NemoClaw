// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Threading;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeOnboarding
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string? className, string windowName);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    internal static int Run(string? initialAgent)
    {
        using var instance = new Mutex(true, "Local\\NVIDIA.NemoClaw.NativeOnboarding", out var ownsInstance);
        var existing = FindWindow(null, "NemoClaw Setup");
        if (!ownsInstance || existing != IntPtr.Zero)
        {
            if (existing != IntPtr.Zero) { ShowWindow(existing, 9); SetForegroundWindow(existing); }
            if (ownsInstance) instance.ReleaseMutex();
            return 0;
        }
        var result = 1223;
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var window = new MainWindow();
                CancellationTokenSource? modelCancellation = null;
                window.ModelSetupCancelRequested += (_, _) => modelCancellation?.Cancel();
                async Task FinishConfigurationAsync()
                {
                    using var cancellation = new CancellationTokenSource();
                    modelCancellation = cancellation;
                    try
                    {
                        var configuration = window.Configuration ?? throw new InvalidOperationException("Agent configuration is missing.");
                        using var password = window.CopyCredential();
                        using var serviceCredentials = window.CopyServiceCredentials();
                        await NativeSetupOperations.SaveAsync(configuration, password, serviceCredentials, window.ShowModelProgress, cancellation.Token, window.ShowConfigurationUnconfirmed);
                        result = 0;
                        window.ShowConfiguredSuccess();
                        if (configuration.LaunchAfterSetup && !window.ConfigurationWindowClosed)
                        {
                            try { NativeSetupOperations.Launch(configuration.Agent); window.MarkLaunched(); }
                            catch (Exception) { window.ShowRecoverableError("Your settings are saved, but the agent could not open. Try Launch again."); }
                        }
                    }
                    catch (OperationCanceledException)
                    {
                        result = 1223;
                        window.ShowConfigurationFailure("Model setup was cancelled. You can choose hosted inference or prepare the local model later.");
                    }
                    catch (Exception error)
                    {
                        result = 1;
                        window.ShowConfigurationFailure(NativeExpressSetup.FailureDetail(error));
                    }
                    finally { modelCancellation = null; window.CompleteConfigurationObservation(); }
                }
                window.ConfigureRequested += async (_, _) =>
                {
                    if (!window.TryBeginConfiguration()) return;
                    await window.ObserveConfigurationAsync(FinishConfigurationAsync());
                };
                window.LaunchRequested += (_, _) =>
                {
                    try { NativeSetupOperations.Launch(window.SelectedAgent); window.MarkLaunched(); }
                    catch (Exception) { window.ShowRecoverableError("Your settings are saved, but the agent could not open. Try Launch again."); }
                };
                window.Closed += (_, _) => Dispatcher.CurrentDispatcher.InvokeShutdown();
                window.Show();
                window.ShowNativeOnboarding(initialAgent);
                Dispatcher.Run();
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        try { thread.Start(); thread.Join(); }
        finally { instance.ReleaseMutex(); }
        return failure is null ? result : Marshal.GetHRForException(failure);
    }
}
