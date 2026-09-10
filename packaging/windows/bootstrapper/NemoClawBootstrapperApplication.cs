// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using WixToolset.BootstrapperApplicationApi;

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed class NemoClawBootstrapperApplication : BootstrapperApplication
{
    private const int UserCancelled = 1223;
    private IBootstrapperCommand? command;
    private MainWindow? window;
    private Window? ownerWindow;
    private Dispatcher? engineDispatcher;
    private Dispatcher? dispatcher;
    private Exception? dispatcherFailure;
    private bool installed;
    private bool relatedOnly;
    private bool preparingMaintenance;
    private bool replacedPreviousPreview;
    private bool cancelRequested;
    private LaunchAction plannedAction = LaunchAction.Unknown;
    private int result;
    private CancellationTokenSource? modelSetupCancellation;

    private IEngine Engine => this.engine;

    protected override void OnCreate(CreateEventArgs args)
    {
        base.OnCreate(args);
        this.command = args.Command;
    }

    protected override void Run()
    {
        this.engineDispatcher = Dispatcher.CurrentDispatcher;
        this.SubscribeToEngine();
        using var dispatcherReady = new ManualResetEventSlim();
        var dispatcherThread = new Thread(() => this.RunDispatcher(dispatcherReady))
        {
            IsBackground = false,
            Name = "NemoClaw setup UI",
        };
        dispatcherThread.SetApartmentState(ApartmentState.STA);
        dispatcherThread.Start();
        dispatcherReady.Wait();
        if (this.dispatcherFailure is not null)
        {
            this.Engine.Quit(this.NormalizeExitCode(Marshal.GetHRForException(this.dispatcherFailure)));
            throw new InvalidOperationException("The NemoClaw setup UI could not initialize.", this.dispatcherFailure);
        }

        this.Engine.Log(LogLevel.Standard, "NemoClaw native Windows bootstrapper started.");
        this.Engine.Detect();
        Dispatcher.Run();
        dispatcherThread.Join();
        if (this.dispatcherFailure is not null)
        {
            this.Engine.Quit(this.NormalizeExitCode(Marshal.GetHRForException(this.dispatcherFailure)));
            throw new InvalidOperationException("The NemoClaw setup UI failed.", this.dispatcherFailure);
        }
        this.Engine.Quit(this.NormalizeExitCode(this.result));
    }

    private void RunDispatcher(ManualResetEventSlim ready)
    {
        try
        {
            this.dispatcher = Dispatcher.CurrentDispatcher;

            if (this.command?.Display is Display.Full or Display.Passive)
            {
                this.window = new MainWindow();
                this.ownerWindow = this.window;
                this.window.InstallRequested += (_, _) => this.BeginPlan(LaunchAction.Install);
                this.window.RepairRequested += (_, _) => _ = this.BeginMaintenanceAsync(LaunchAction.Repair);
                this.window.UninstallRequested += (_, _) => _ = this.BeginMaintenanceAsync(LaunchAction.Uninstall);
                this.window.ReplacePreviewRequested += (_, _) => _ = this.ReplacePreviousPreviewAsync();
                this.window.CancelRequested += (_, _) => this.cancelRequested = true;
                this.window.OpenLogRequested += (_, _) => this.OpenBundleLog();
                this.window.ConfigureRequested += (_, _) => _ = this.ConfigureInstalledAgentAsync();
                this.window.LaunchRequested += (_, _) => this.LaunchNemoClaw();
                this.window.ModelSetupCancelRequested += (_, _) => this.modelSetupCancellation?.Cancel();
                this.window.Closed += (_, _) =>
                {
                    this.dispatcher.InvokeShutdown();
                    this.engineDispatcher?.BeginInvokeShutdown(DispatcherPriority.Normal);
                };
                this.window.Show();
            }
            else
            {
                this.ownerWindow = new Window
                {
                    Height = 0,
                    Opacity = 0,
                    ShowActivated = false,
                    ShowInTaskbar = false,
                    Width = 0,
                    WindowStyle = WindowStyle.None,
                };
                _ = new WindowInteropHelper(this.ownerWindow).EnsureHandle();
            }

            ready.Set();
            Dispatcher.Run();
        }
        catch (Exception error)
        {
            this.dispatcherFailure = error;
            ready.Set();
            this.engineDispatcher?.BeginInvokeShutdown(DispatcherPriority.Normal);
        }
    }

    private void SubscribeToEngine()
    {
        this.DetectPackageComplete += this.OnDetectPackageComplete;
        this.DetectComplete += this.OnDetectComplete;
        this.PlanComplete += this.OnPlanComplete;
        this.ApplyBegin += (_, _) => this.Ui(() => this.window?.ShowProgress("Preparing your changes", "Windows is preparing the selected changes to NemoClaw on this PC."));
        this.CacheAcquireProgress += (_, args) =>
        {
            args.Cancel = this.cancelRequested;
            this.Ui(() => this.window?.ShowProgress("Checking installer files", "Verifying the packaged files before installation."));
        };
        this.CacheContainerOrPayloadVerifyProgress += (_, args) =>
        {
            args.Cancel = this.cancelRequested;
            this.Ui(() => this.window?.ShowProgress("Checking installer files", "Verifying the packaged files before installation."));
        };
        this.ExecutePackageBegin += this.OnExecutePackageBegin;
        this.ExecuteProgress += (_, args) =>
        {
            args.Cancel = this.cancelRequested;
        };
        this.Progress += (_, args) =>
        {
            args.Cancel = this.cancelRequested;
            this.Ui(() => this.window?.SetInstallerProgress(args.OverallPercentage));
        };
        this.Error += this.OnError;
        this.ApplyComplete += this.OnApplyComplete;
    }

    private void OnDetectPackageComplete(object? sender, DetectPackageCompleteEventArgs args)
    {
        if (string.Equals(args.PackageId, "NemoClawArm64Msi", StringComparison.Ordinal))
        {
            this.installed = args.State == PackageState.Present;
        }
    }

    private void OnDetectComplete(object? sender, DetectCompleteEventArgs args)
    {
        if (args.Status < 0)
        {
            this.result = args.Status;
            this.Ui(() => this.window?.ShowFailure("Windows could not inspect the current NemoClaw installation.", this.BundleLogPath()));
            this.StopDispatchersForHeadless();
            return;
        }

        if (this.command?.Display == Display.Full)
        {
            try { this.relatedOnly = !this.installed && NativeMaintenance.HasRelatedInstallation(); }
            catch (Exception) {
                this.Ui(() => this.window?.ShowFailure("Windows could not inspect the previous NemoClaw installation.", this.BundleLogPath()));
                return;
            }
            var removalAvailable = NativeMaintenance.SupportsDataRemoval();
            this.Ui(() => {
                this.window?.SetDataRemovalAvailable(removalAvailable);
                this.window?.SetMaintenanceContext(this.relatedOnly);
                this.window?.ShowReady(this.installed || this.relatedOnly);
            });
            if (this.command?.Action == LaunchAction.Uninstall && !this.replacedPreviousPreview)
            {
                this.Ui(() => this.window?.ShowMaintenance());
            }
            return;
        }

        var requested = this.command?.Action ?? LaunchAction.Install;
        if (requested == LaunchAction.Unknown)
        {
            requested = this.installed ? LaunchAction.Repair : LaunchAction.Install;
        }
        if (requested is LaunchAction.Repair or LaunchAction.Uninstall) _ = this.PrepareHeadlessMaintenanceAsync(requested);
        else this.BeginPlan(requested);
    }

    private void BeginPlan(LaunchAction action)
    {
        if (this.plannedAction != LaunchAction.Unknown)
        {
            return;
        }

        this.plannedAction = action;
        this.Ui(() => this.window?.ShowProgress("Preparing your installation", "Checking the files and changes needed on this PC."));
        this.Engine.Plan(action);
    }

    private async Task BeginMaintenanceAsync(LaunchAction action)
    {
        if (this.preparingMaintenance || this.plannedAction != LaunchAction.Unknown) return;
        this.preparingMaintenance = true;
        try
        {
            if (action == LaunchAction.Uninstall)
            {
                if (this.window?.RequiresRemovalSelection == true)
                    throw new InvalidOperationException("Choose the agent data to remove, or leave the data-removal option unchecked.");
                var agents = this.window?.SelectedRemovalAgents ?? Array.Empty<string>();
                if (agents.Length > 0)
                {
                    this.window?.ShowProgress("Removing selected agent data", "Checking that each selected session has stopped before removing its data and saved keys.");
                    await NativeMaintenance.RemoveAgentDataAsync(agents);
                }
            }
            await NativeMaintenance.StopSharedInferenceAsync(() => this.window?.ShowProgress("Stopping the shared local model", "Closing the owned inference service before Windows updates its application files. Downloaded model files are being kept."));
            if (this.relatedOnly)
            {
                this.window?.ShowProgress("Maintaining your installation", "Windows is updating the previous registered NemoClaw installation.");
                var code = await NativeMaintenance.RunRelatedActionAsync(action == LaunchAction.Uninstall);
                if (code is not (0 or 3010)) throw new InvalidOperationException("Windows could not complete maintenance of the previous installation.");
                this.result = code;
                this.plannedAction = action;
                if (action == LaunchAction.Uninstall) NativeDesktopIntegration.RemoveOwned(NativeSetupOperations.InstalledLauncher());
                this.window?.ShowSuccess(action);
            }
            else this.BeginPlan(action);
        }
        catch (Exception error)
        {
            this.result = 1;
            this.window?.ShowMaintenance();
            this.window?.ShowRecoverableError(error.Message);
        }
        finally { this.preparingMaintenance = false; }
    }

    private async Task ReplacePreviousPreviewAsync()
    {
        if (!this.relatedOnly || this.preparingMaintenance || this.plannedAction != LaunchAction.Unknown) return;
        this.preparingMaintenance = true;
        try
        {
            await NativeMaintenance.StopSharedInferenceAsync(() => this.window?.ShowProgress("Stopping the shared local model", "Closing the owned inference service before replacing the application. Downloaded model files are being kept."));
            this.window?.ShowProgress("Removing the previous preview", "Windows is removing the registered application. Your agent data and saved keys are being kept.");
            // Only the registered old Burn package receives its supported quiet
            // uninstall command. New native helper flags never reach its launcher.
            var code = await NativeMaintenance.RunRelatedActionAsync(uninstall: true);
            if (code == 3010)
            {
                this.result = code;
                this.window?.ShowFailure("The previous preview was removed. Restart Windows, then open this installer to complete installation.", this.BundleLogPath());
                return;
            }
            if (code != 0) throw new InvalidOperationException("Windows could not remove the previous preview. Your agent data and keys were kept.");
            NativeDesktopIntegration.RemoveOwned(NativeSetupOperations.InstalledLauncher());
            this.installed = false;
            this.relatedOnly = false;
            this.replacedPreviousPreview = true;
            this.result = 0;
            this.preparingMaintenance = false;
            // Re-enter the normal native choice/configuration flow in this same
            // window only after Windows reports the previous product removed.
            this.Engine.Detect();
        }
        catch (Exception error)
        {
            this.result = 1;
            this.window?.ShowMaintenance();
            this.window?.ShowRecoverableError(error.Message);
        }
        finally { this.preparingMaintenance = false; }
    }

    private async Task PrepareHeadlessMaintenanceAsync(LaunchAction action)
    {
        try
        {
            await NativeMaintenance.StopSharedInferenceAsync();
            this.BeginPlan(action);
        }
        catch (Exception)
        {
            this.result = 1;
            this.Engine.Log(LogLevel.Error, "The owned native inference service could not stop; Windows maintenance was not started.");
            this.StopDispatchersForHeadless();
        }
    }

    private void OnPlanComplete(object? sender, PlanCompleteEventArgs args)
    {
        if (args.Status < 0)
        {
            this.result = args.Status;
            this.Ui(() => this.window?.ShowFailure("Windows could not plan the requested NemoClaw change.", this.BundleLogPath()));
            this.StopDispatchersForHeadless();
            return;
        }

        var owner = this.UiValue(
            () => this.ownerWindow is null ? IntPtr.Zero : new WindowInteropHelper(this.ownerWindow).EnsureHandle(),
            IntPtr.Zero);
        this.Engine.Apply(owner);
    }

    private void OnExecutePackageBegin(object? sender, ExecutePackageBeginEventArgs args)
    {
        var (title, detail) = args.PackageId switch
        {
            "MxcSystemDrivePreparation" => ("Preparing native isolation", "Windows is preparing protected access for the native agent runtimes."),
            "MxcNullDevicePreparation" => ("Preparing required Windows features", "Windows is configuring the local isolation support used by NemoClaw."),
            "NemoClawArm64Msi" when this.plannedAction == LaunchAction.Uninstall => ("Removing NemoClaw", "Windows is removing the installed application and agent runtimes."),
            "NemoClawArm64Msi" when this.plannedAction == LaunchAction.Repair => ("Repairing NemoClaw", "Windows is restoring the installed application and native agent runtimes."),
            "NemoClawArm64Msi" => ("Installing NemoClaw", "Windows is installing the application and native agent runtimes. Large runtimes can take several minutes."),
            _ => ("Installing required components", "Windows is processing the next component in the installation."),
        };
        args.Cancel = this.cancelRequested;
        this.Ui(() => this.window?.ShowProgress(title, detail));
    }

    private void OnError(object? sender, WixToolset.BootstrapperApplicationApi.ErrorEventArgs args)
    {
        this.Engine.Log(LogLevel.Error, $"NemoClaw setup error {args.ErrorCode}: {args.ErrorMessage}");
        this.Ui(() => this.window?.ShowRecoverableError(args.ErrorMessage));
        args.Result = this.cancelRequested ? Result.Cancel : args.Recommendation;
    }

    private void OnApplyComplete(object? sender, ApplyCompleteEventArgs args)
    {
        this.result = args.Status;
        if (args.Status >= 0)
        {
            if (this.plannedAction is LaunchAction.Install or LaunchAction.Repair)
            {
                try { NativeDesktopIntegration.Repair(NativeSetupOperations.InstalledLauncher()); }
                catch (Exception) { this.Engine.Log(LogLevel.Error, "The installed application is available, but desktop shortcuts could not be refreshed safely."); }
            }
            if (this.plannedAction == LaunchAction.Uninstall)
            {
                try { NativeDesktopIntegration.RemoveOwned(NativeSetupOperations.InstalledLauncher()); }
                catch (Exception) { this.Engine.Log(LogLevel.Error, "NemoClaw was removed, but a desktop shortcut could not be removed safely."); }
            }
            if (this.command?.Display == Display.Full && this.plannedAction == LaunchAction.Install && !this.cancelRequested)
            {
                this.Ui(() => _ = this.ConfigureInstalledAgentAsync());
            }
            else this.Ui(() => this.window?.ShowSuccess(this.plannedAction));
        }
        else
        {
            this.Ui(() => this.window?.ShowFailure("Setup rolled back because Windows could not complete the requested change.", this.BundleLogPath()));
        }

        if (this.command?.Display != Display.Full)
        {
            this.StopDispatchersForHeadless();
        }
    }

    private async Task ConfigureInstalledAgentAsync()
    {
        using var cancellation = new CancellationTokenSource();
        this.modelSetupCancellation = cancellation;
        try
        {
            var configuration = this.window?.Configuration ?? throw new InvalidOperationException("Agent configuration is missing.");
            this.window!.ShowConfiguring();
            using var password = this.window.CopyCredential();
            using var serviceCredentials = this.window.CopyServiceCredentials();
            await NativeSetupOperations.SaveAsync(configuration, password, serviceCredentials, this.window.ShowModelProgress, cancellation.Token);
            this.result = 0;
            this.cancelRequested = false;
            this.window.ShowConfiguredSuccess();
        }
        catch (OperationCanceledException)
        {
            this.result = UserCancelled;
            this.window?.ShowConfigurationFailure("Model setup was cancelled. NemoClaw is installed; you can choose hosted inference or prepare the local model later.");
        }
        catch (Exception error)
        {
            this.result = 1;
            this.Engine.Log(LogLevel.Error, "Native agent configuration could not be saved. The installed application remains available.");
            this.window?.ShowConfigurationFailure(NativeExpressSetup.FailureDetail(error));
        }
        finally { this.modelSetupCancellation = null; }
    }

    private void LaunchNemoClaw()
    {
        try
        {
            var selectedAgent = this.UiValue(() => this.window?.SelectedAgent ?? "openclaw", "openclaw");
            NativeSetupOperations.Launch(selectedAgent);
            this.Ui(() => this.window?.MarkLaunched());
        }
        catch (Exception error)
        {
            this.Engine.Log(LogLevel.Error, $"NemoClaw first launch failed: {error.Message}");
            this.Ui(() => this.window?.ShowRecoverableError("Your settings are saved, but the agent could not open. Try Launch again, or use the Start menu."));
        }
    }

    private string BundleLogPath()
    {
        try
        {
            return this.Engine.ContainsVariable("WixBundleLog") ? this.Engine.GetVariableString("WixBundleLog") : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private void OpenBundleLog()
    {
        var log = this.BundleLogPath();
        if (!string.IsNullOrWhiteSpace(log) && File.Exists(log))
        {
            Process.Start(new ProcessStartInfo { FileName = log, UseShellExecute = true })?.Dispose();
        }
    }

    private void Ui(Action action)
    {
        if (this.dispatcher is null)
        {
            return;
        }
        _ = this.dispatcher.BeginInvoke(action);
    }

    private T UiValue<T>(Func<T> action, T fallback)
    {
        if (this.dispatcher is null)
        {
            return fallback;
        }
        return this.dispatcher.CheckAccess() ? action() : this.dispatcher.Invoke(action);
    }

    private void StopDispatchersForHeadless()
    {
        if (this.command?.Display == Display.Full)
        {
            return;
        }
        this.Ui(() =>
        {
            if (this.window is null)
            {
                this.ownerWindow?.Close();
                this.dispatcher?.InvokeShutdown();
            }
            else
            {
                this.window.Close();
            }
        });
        this.engineDispatcher?.BeginInvokeShutdown(DispatcherPriority.Normal);
    }

    private int NormalizeExitCode(int code)
    {
        if (this.cancelRequested && code == 0)
        {
            return UserCancelled;
        }
        return (code & unchecked((int)0xFFFF0000)) == unchecked((int)0x80070000) ? code & 0xFFFF : code;
    }
}
