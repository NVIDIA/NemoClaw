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
    private readonly NativeHermesUpgrade upgradeDetection = new();
    private readonly NativeRuntimeAvailability runtimeAvailability = NativeRuntimeAvailability.Load();
    private bool upgrading;
    private bool retiringSupersededBundle;
    private readonly NativeCancellationState cancellation = new();
    private bool executingPackage;
    private string? executingPackageId;
    private readonly string preparationAttempt = Guid.NewGuid().ToString("N");
    private NativePreparationFailure? preparationFailure;
    private string? preparationTier;
    private readonly NativePresentationUpdates stepProgressUpdates = new();
    private readonly NativePresentationUpdates overallProgressUpdates = new();
    private LaunchAction plannedAction = LaunchAction.Unknown;
    private int result;
    private CancellationTokenSource? modelSetupCancellation;
    private CancellationTokenSource? maintenanceCancellation;

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
        this.Engine.SetVariableString("NemoClawPreparationAttempt", this.preparationAttempt, false);
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
                this.window = new MainWindow(() => this.cancellation.IsRequested);
                this.ownerWindow = this.window;
                this.window.InstallRequested += (_, _) => _ = this.upgrading
                    ? this.BeginMaintenanceAsync(LaunchAction.Install) : this.BeginPlanAsync(LaunchAction.Install);
                this.window.RepairRequested += (_, _) => _ = this.BeginMaintenanceAsync(LaunchAction.Repair);
                this.window.UninstallRequested += (_, _) => _ = this.BeginMaintenanceAsync(LaunchAction.Uninstall);
                this.window.ReplacePreviewRequested += (_, _) => _ = this.ReplacePreviousPreviewAsync();
                this.window.CancelRequested += (_, _) =>
                {
                    this.cancellation.Request(this.maintenanceCancellation);
                };
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
        this.DetectBegin += (_, _) => this.upgradeDetection.Reset();
        this.DetectRelatedMsiPackage += (_, args) => this.upgradeDetection.Observe(args.PackageId,
            args.PerMachine, args.Operation == RelatedOperation.MajorUpgrade, args.Version);
        this.DetectPackageComplete += this.OnDetectPackageComplete;
        this.DetectComplete += this.OnDetectComplete;
        this.PlanComplete += this.OnPlanComplete;
        this.PlanPackageBegin += (_, args) =>
        {
            if (this.retiringSupersededBundle)
            {
                // MSI replacement and the new bundle already own the runtime.
                // Only retire this superseded Burn registration and its cache.
                args.State = RequestState.Absent;
                return;
            }
            try
            {
                if (NativeHostPreparation.SkipPackage(args.PackageId, this.preparationTier, this.plannedAction == LaunchAction.Uninstall))
                    args.State = RequestState.None;
            }
            catch (InvalidOperationException) { args.Cancel = true; }
        };
        this.ApplyBegin += (_, _) => this.Ui(() => this.window?.ShowProgress("Preparing your changes", "Windows is preparing the selected changes to NemoClaw on this PC."));
        this.CacheAcquireProgress += (_, args) =>
        {
            args.Cancel = this.cancellation.IsRequested;
            if (!this.executingPackage)
            {
                var completed = args.Progress;
                var total = args.Total;
                var phase = "cache-acquire-" + args.PackageOrContainerId + "-" + args.PayloadId;
                this.UiProgress(() => this.window?.ShowMeasuredProgress(phase, "Preparing installer files", "Reading the packaged files needed for the installation.", completed, total));
            }
        };
        this.CacheContainerOrPayloadVerifyProgress += (_, args) =>
        {
            args.Cancel = this.cancellation.IsRequested;
            if (!this.executingPackage)
            {
                var completed = args.Progress;
                var total = args.Total;
                var phase = "cache-verify-" + args.PackageOrContainerId + "-" + args.PayloadId;
                this.UiProgress(() => this.window?.ShowMeasuredProgress(phase, "Checking installer files", "Verifying the packaged files before Windows installs them.", completed, total));
            }
        };
        this.ExecutePackageBegin += this.OnExecutePackageBegin;
        this.ExecutePackageComplete += (_, args) =>
        {
            if (args.PackageId == "MxcSystemDrivePreparation" && args.Status < 0)
                this.RememberPreparationFailure(args.Status);
        };
        this.ExecuteProgress += (_, args) =>
        {
            args.Cancel = this.cancellation.IsRequested;
            var percentage = args.ProgressPercentage;
            this.UiProgress(() => this.window?.SetPackageProgress(percentage));
        };
        this.Progress += (_, args) =>
        {
            args.Cancel = this.cancellation.IsRequested;
            var percentage = args.OverallPercentage;
            this.UiProgress(() => this.window?.SetInstallerProgress(percentage), overall: true);
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
            var inspection = NativeMaintenance.InspectInstallation(this.installed);
            if (inspection is null)
            {
                this.result = 1;
                this.Engine.Log(LogLevel.Error, "The installed NemoClaw maintenance contract could not be verified. No changes were started.");
                this.Ui(() => {
                    this.window?.SetDataRemovalAvailable(false);
                    this.window?.ShowFailure("Windows could not inspect the current or previous NemoClaw installation. No changes were started.", this.BundleLogPath());
                });
                return;
            }
            this.relatedOnly = inspection.Value.RelatedOnly;
            try
            {
                this.upgrading = this.command.Action is not (LaunchAction.Repair or LaunchAction.Uninstall)
                    && this.upgradeDetection.CanUpgrade(this.installed, this.relatedOnly,
                    this.IsHermesOnly(), NativeMaintenance.SupportsImmutableInstallation);
            }
            catch (Exception)
            {
                this.result = 1;
                this.Ui(() => this.window?.ShowFailure("Setup could not verify the installed runtime for upgrade. No changes were started.", this.BundleLogPath()));
                return;
            }
            if (this.upgrading) this.relatedOnly = false;
            this.Ui(() => {
                this.window?.SetDataRemovalAvailable(inspection.Value.RemovalAvailable);
                this.window?.SetMaintenanceContext(this.relatedOnly);
                this.window?.SetUpgradeContext(this.upgrading);
                this.window?.SetReplacementSetupAvailable(new[] { "openclaw", "hermes" }.Where(agent =>
                    !this.installed && !this.relatedOnly
                    && ((agent == "openclaw" && this.replacedPreviousPreview) || NativeSetupOperations.HasSavedSetup(agent))));
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
        this.retiringSupersededBundle = NativeHermesUpgrade.RetireSupersededBundle(this.IsHermesOnly(),
            this.installed, this.command?.Relation == RelationType.Upgrade, requested == LaunchAction.Uninstall);
        var retirementDetection = this.Engine.GetVariableNumeric("NemoClawRetireSuperseded") == 1;
        if (retirementDetection && !this.retiringSupersededBundle)
        {
            this.result = 1;
            this.Engine.Log(LogLevel.Error, "The superseded product changed during detection. No removal was planned.");
            this.StopDispatchersForHeadless();
            return;
        }
        if (this.retiringSupersededBundle)
        {
            if (!retirementDetection)
            {
                // Re-detect absent transaction sentinels so Burn naturally
                // unregisters this old bundle without touching the new runtime.
                this.Engine.SetVariableNumeric("NemoClawRetireSuperseded", 1);
                this.Engine.Detect();
                return;
            }
            this.plannedAction = LaunchAction.Uninstall;
            this.Engine.Plan(LaunchAction.Uninstall);
            return;
        }
        if (requested == LaunchAction.Install && !this.installed && this.IsHermesOnly())
        {
            try
            {
                if (NativeMaintenance.HasRelatedInstallation())
                {
                    if (!this.upgradeDetection.CanUpgrade(false, true, true, NativeMaintenance.SupportsImmutableInstallation))
                        throw new InvalidOperationException("This preview requires interactive retained-data replacement before an in-place upgrade is supported.");
                    this.upgrading = true;
                    _ = this.BeginMaintenanceAsync(LaunchAction.Install);
                    return;
                }
            }
            catch (Exception error)
            {
                this.result = 1;
                this.Engine.Log(LogLevel.Error, error.Message);
                this.StopDispatchersForHeadless();
                return;
            }
        }
        if (requested is LaunchAction.Repair or LaunchAction.Uninstall) _ = this.PrepareHeadlessMaintenanceAsync(requested);
        else _ = this.BeginPlanAsync(requested);
    }

    private bool IsHermesOnly()
    {
        return this.runtimeAvailability.CanSelect("hermes") && !this.runtimeAvailability.CanSelect("openclaw");
    }

    private async Task BeginPlanAsync(LaunchAction action)
    {
        if (this.plannedAction != LaunchAction.Unknown)
        {
            return;
        }

        this.plannedAction = action;
        this.Ui(() => this.window?.ShowProgress("Preparing your installation", "Checking the files and changes needed on this PC."));
        try
        {
            if (action is LaunchAction.Install or LaunchAction.Repair)
            {
                this.preparationTier = await NativeHostPreparation.ProbeAsync(Path.Combine(AppContext.BaseDirectory, "NemoClaw.MxcProbe.exe"));
                this.Engine.Log(LogLevel.Standard, "MXC preparation tier: " + this.preparationTier);
                this.Ui(() => this.window?.ShowProgress("Preparing your installation", "Detected isolation: " + this.preparationTier));
            }
            this.Engine.Plan(action);
        }
        catch (Exception)
        {
            this.result = 1;
            this.plannedAction = LaunchAction.Unknown;
            this.preparationTier = null;
            this.Engine.Log(LogLevel.Error, "MXC capability inspection failed; no installation plan was applied.");
            this.Ui(() => this.window?.ShowFailure("Setup could not verify the packaged MXC isolation capabilities. No installation changes were started.", this.BundleLogPath()));
            this.StopDispatchersForHeadless();
        }
    }

    private async Task BeginMaintenanceAsync(LaunchAction action)
    {
        if (this.preparingMaintenance || this.plannedAction != LaunchAction.Unknown) return;
        this.preparingMaintenance = true;
        using var cancellation = new CancellationTokenSource();
        this.maintenanceCancellation = cancellation;
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
                    await NativeMaintenance.RemoveAgentDataAsync(agents, cancellation.Token);
                }
            }
            await NativeMaintenance.StopSharedInferenceAsync(() => this.window?.ShowProgress("Stopping the shared local model", "Closing the owned inference service before Windows updates its application files. Downloaded model files are being kept."), cancellation.Token);
            cancellation.Token.ThrowIfCancellationRequested();
            if (this.relatedOnly)
            {
                this.window?.ShowProgress("Maintaining your installation", "Windows is updating the previous registered NemoClaw installation.");
                var code = await NativeMaintenance.RunRelatedActionAsync(action == LaunchAction.Uninstall, cancellation.Token);
                if (code is not (0 or 3010 or 1641)) throw new InvalidOperationException("Windows could not complete maintenance of the previous installation.");
                this.result = code;
                this.plannedAction = action;
                NativeMaintenance.CompleteRelatedAction(code, () =>
                {
                    if (action == LaunchAction.Uninstall) NativeDesktopIntegration.RemoveOwned(NativeSetupOperations.InstalledLauncher());
                    this.window?.ShowSuccess(action);
                }, message => this.window?.ShowFailure(message, this.BundleLogPath()));
            }
            else await this.BeginPlanAsync(action);
        }
        catch (Exception error)
        {
            this.result = 1;
            if (this.upgrading) this.window?.ShowFailure(error.Message, this.BundleLogPath());
            else this.ShowRecoverableMaintenanceError(error);
            this.StopDispatchersForHeadless();
        }
        finally
        {
            if (ReferenceEquals(this.maintenanceCancellation, cancellation)) this.maintenanceCancellation = null;
            this.preparingMaintenance = false;
        }
    }

    private async Task ReplacePreviousPreviewAsync()
    {
        if (!this.relatedOnly || this.preparingMaintenance || this.plannedAction != LaunchAction.Unknown) return;
        this.preparingMaintenance = true;
        using var cancellation = new CancellationTokenSource();
        this.maintenanceCancellation = cancellation;
        try
        {
            await NativeMaintenance.StopSharedInferenceAsync(() => this.window?.ShowProgress("Stopping the shared local model", "Closing the owned inference service before replacing the application. Downloaded model files are being kept."), cancellation.Token);
            cancellation.Token.ThrowIfCancellationRequested();
            this.window?.ShowProgress("Removing the previous preview", "Windows is removing the registered application. Your agent data and saved keys are being kept.");
            // Only the registered old Burn package receives its supported quiet
            // uninstall command. New native helper flags never reach its launcher.
            var code = await NativeMaintenance.RunRelatedActionAsync(uninstall: true, cancellation.Token);
            this.result = code;
            NativeMaintenance.CompleteRelatedAction(code, () =>
            {
                NativeDesktopIntegration.RemoveOwned(NativeSetupOperations.InstalledLauncher());
                this.installed = false;
                this.relatedOnly = false;
                this.replacedPreviousPreview = true;
                this.preparingMaintenance = false;
                // Re-enter setup only after Windows confirms removal without a pending restart.
                this.Engine.Detect();
            }, message => this.window?.ShowFailure(message, this.BundleLogPath()));
        }
        catch (Exception error)
        {
            this.result = 1;
            this.ShowRecoverableMaintenanceError(error);
        }
        finally
        {
            if (ReferenceEquals(this.maintenanceCancellation, cancellation)) this.maintenanceCancellation = null;
            this.preparingMaintenance = false;
        }
    }

    private void ShowRecoverableMaintenanceError(Exception error)
    {
        if (error is NativeMaintenance.RelatedActionPendingException)
        {
            // ShowFailure exposes only Close and the log, not another transaction.
            // The cached installer still owns completion or rollback.
            this.window?.ShowFailure(error.Message, this.BundleLogPath());
            return;
        }
        this.cancellation.ResetForRetry();
        this.window?.ShowMaintenance();
        this.window?.ShowRecoverableError(error.Message);
    }

    private async Task PrepareHeadlessMaintenanceAsync(LaunchAction action)
    {
        if (this.preparingMaintenance || this.plannedAction != LaunchAction.Unknown) return;
        this.preparingMaintenance = true;
        using var cancellation = new CancellationTokenSource();
        this.maintenanceCancellation = cancellation;
        try
        {
            var code = await NativeMaintenance.PrepareHeadlessActionAsync(this.installed,
                action == LaunchAction.Uninstall, () => this.BeginPlanAsync(action), cancellation.Token);
            // The current bundle's ApplyComplete event owns shutdown after planning.
            if (code is null) return;
            this.result = code.Value;
            this.plannedAction = action;
            if (code is 0 or 3010 or 1641)
            {
                NativeMaintenance.CompleteRelatedAction(code.Value, () =>
                {
                    if (action == LaunchAction.Uninstall)
                    {
                        try { NativeDesktopIntegration.RemoveOwned(NativeSetupOperations.InstalledLauncher()); }
                        catch (Exception) { this.Engine.Log(LogLevel.Error, "NemoClaw was removed, but a desktop shortcut could not be removed safely."); }
                    }
                    this.Ui(() => this.window?.ShowSuccess(action));
                }, message =>
                {
                    this.Engine.Log(LogLevel.Standard, message);
                    this.Ui(() => this.window?.ShowFailure(message, this.BundleLogPath()));
                });
            }
            else this.Engine.Log(LogLevel.Error, "The registered previous installer did not complete maintenance successfully.");
        }
        catch (NativeMaintenance.RelatedActionPendingException error)
        {
            this.result = 1;
            this.Engine.Log(LogLevel.Error, error.Message);
            this.Ui(() => this.window?.ShowFailure(error.Message, this.BundleLogPath()));
        }
        catch (Exception)
        {
            this.result = 1;
            this.Engine.Log(LogLevel.Error, "Native maintenance did not complete. Check the setup log before trying again.");
        }
        finally
        {
            if (ReferenceEquals(this.maintenanceCancellation, cancellation)) this.maintenanceCancellation = null;
            this.preparingMaintenance = false;
        }
        this.StopDispatchersForHeadless();
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
        this.executingPackage = true;
        this.executingPackageId = args.PackageId;
        var (title, detail) = args.PackageId switch
        {
            "MxcSystemDrivePreparation" => ("Preparing native isolation", "Windows is preparing protected access for the native agent runtimes."),
            "MxcNullDevicePreparation" => ("Preparing required Windows features", "Windows is configuring the local isolation support used by NemoClaw."),
            "NemoClawArm64Msi" when this.plannedAction == LaunchAction.Uninstall => ("Removing NemoClaw", "Windows is removing the installed application and agent runtimes."),
            "NemoClawArm64Msi" when this.plannedAction == LaunchAction.Repair => ("Repairing NemoClaw", "Windows is restoring the installed application and native agent runtimes."),
            "NemoClawArm64Msi" => ("Installing NemoClaw", "Windows is installing the application and native agent runtimes. Large runtimes can take several minutes."),
            _ => ("Installing required components", "Windows is processing the next component in the installation."),
        };
        args.Cancel = this.cancellation.IsRequested;
        this.Ui(() => this.window?.ShowProgress(title, detail, "package-" + args.PackageId));
    }

    private void OnError(object? sender, WixToolset.BootstrapperApplicationApi.ErrorEventArgs args)
    {
        this.Engine.Log(LogLevel.Error, $"NemoClaw setup error {args.ErrorCode}: {args.ErrorMessage}");
        if (this.executingPackageId == "MxcSystemDrivePreparation" && args.PackageId == "MxcSystemDrivePreparation")
            this.RememberPreparationFailure(args.ErrorCode);
        var detail = this.preparationFailure?.Summary
            ?? NativeCancellationState.FailureDetail(args.ErrorCode, this.executingPackage)
            ?? $"Windows reported setup error {args.ErrorCode}. Setup log contains the saved details.";
        this.Ui(() => this.window?.ShowRecoverableError(detail));
        args.Result = this.cancellation.IsRequested ? Result.Cancel : args.Recommendation;
    }

    private void RememberPreparationFailure(int status)
    {
        this.preparationFailure = NativeHostPreparationDiagnostics.Read(this.BundleLogPath(), this.preparationAttempt)
            ?? this.preparationFailure ?? NativeHostPreparationDiagnostics.Fallback(status);
        this.Engine.Log(LogLevel.Error, this.preparationFailure.LogDetail);
    }

    private void OnApplyComplete(object? sender, ApplyCompleteEventArgs args)
    {
        this.result = args.Status;
        var restartCode = NativeMaintenance.RestartExitCode(args.Status,
            args.Restart == ApplyRestart.RestartRequired, args.Restart == ApplyRestart.RestartInitiated);
        if (restartCode is int code)
        {
            this.result = code;
            var message = NativeMaintenance.RestartMessage(code);
            this.Engine.Log(LogLevel.Standard, message);
            this.Ui(() => this.window?.ShowFailure(message, this.BundleLogPath()));
        }
        else if (args.Status >= 0)
        {
            if (this.plannedAction is LaunchAction.Install or LaunchAction.Repair)
            {
                try { NativeDesktopIntegration.Repair(NativeSetupOperations.InstalledLauncher()); }
                catch (Exception) { this.Engine.Log(LogLevel.Error, "The installed application is available, but desktop shortcuts could not be refreshed safely."); }
            }
            if (this.plannedAction == LaunchAction.Uninstall && !this.retiringSupersededBundle)
            {
                try { NativeDesktopIntegration.RemoveOwned(NativeSetupOperations.InstalledLauncher()); }
                catch (Exception) { this.Engine.Log(LogLevel.Error, "NemoClaw was removed, but a desktop shortcut could not be removed safely."); }
            }
            if (this.command?.Display == Display.Full && this.plannedAction == LaunchAction.Install && !this.cancellation.IsRequested)
            {
                this.Ui(() => _ = this.ConfigureInstalledAgentAsync());
            }
            else this.Ui(() => this.window?.ShowSuccess(this.plannedAction));
        }
        else
        {
            var detail = this.preparationFailure?.Summary
                ?? NativeCancellationState.FailureDetail(args.Status, this.executingPackage)
                ?? "Windows could not complete the requested change. Review the setup log before opening the installer again.";
            this.Ui(() => this.window?.ShowFailure(detail, this.BundleLogPath()));
        }

        if (this.command?.Display != Display.Full)
        {
            this.StopDispatchersForHeadless();
        }
    }

    private async Task ConfigureInstalledAgentAsync()
    {
        if (this.window is null || !this.window.TryBeginConfiguration()) return;
        await this.window.ObserveConfigurationAsync(this.FinishConfigurationAsync());
    }

    private async Task FinishConfigurationAsync()
    {
        if (this.window is null) throw new InvalidOperationException("The setup window is unavailable.");
        using var cancellation = new CancellationTokenSource();
        this.modelSetupCancellation = cancellation;
        try
        {
            NativeSetupConfiguration configuration;
            if (this.window.ResumeSavedSetup)
            {
                configuration = await this.window.RestoreSavedSetupAsync();
                NativeDesktopIntegration.Ensure(configuration.Agent, NativeSetupOperations.InstalledLauncher());
            }
            else
            {
                configuration = this.window.Configuration ?? throw new InvalidOperationException("Agent configuration is missing.");
                using var password = this.window.CopyCredential();
                using var serviceCredentials = this.window.CopyServiceCredentials();
                await NativeSetupOperations.SaveAsync(configuration, password, serviceCredentials, this.window.ShowModelProgress, cancellation.Token, this.window.ShowConfigurationUnconfirmed);
            }
            this.result = 0;
            this.cancellation.ResetForRetry();
            this.window.ShowConfiguredSuccess();
            if (configuration.LaunchAfterSetup && !this.window.ConfigurationWindowClosed) this.LaunchNemoClaw();
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
        finally { this.modelSetupCancellation = null; this.window?.CompleteConfigurationObservation(); }
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

    private void UiProgress(Action action, bool overall = false)
    {
        var target = this.dispatcher;
        if (target is null || target.HasShutdownStarted) return;
        (overall ? this.overallProgressUpdates : this.stepProgressUpdates).Post(action,
            render => { _ = target.BeginInvoke(render, DispatcherPriority.Background); });
    }

    private void Ui(Action action)
    {
        this.stepProgressUpdates.Clear();
        this.overallProgressUpdates.Clear();
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
        if (this.cancellation.IsRequested && code == 0)
        {
            return UserCancelled;
        }
        return (code & unchecked((int)0xFFFF0000)) == unchecked((int)0x80070000) ? code & 0xFFFF : code;
    }
}
