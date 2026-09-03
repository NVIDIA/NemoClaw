// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using WixToolset.BootstrapperApplicationApi;

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed class NemoClawBootstrapperApplication : BootstrapperApplication
{
    private const int UserCancelled = 1223;
    private static readonly HashSet<string> AllowedAgents =
    [
        "openclaw",
        "hermes",
        "langchain-deepagents-code",
        "pi",
        "nemocua",
    ];
    private IBootstrapperCommand? command;
    private MainWindow? window;
    private Dispatcher? dispatcher;
    private Exception? dispatcherFailure;
    private bool installed;
    private bool cancelRequested;
    private LaunchAction plannedAction = LaunchAction.Unknown;
    private int result;

    private IEngine Engine => this.engine;

    protected override void OnCreate(CreateEventArgs args)
    {
        base.OnCreate(args);
        this.command = args.Command;
    }

    protected override void Run()
    {
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
            throw new InvalidOperationException("The NemoClaw setup UI could not initialize.", this.dispatcherFailure);
        }

        this.Engine.Log(LogLevel.Standard, "NemoClaw native Windows bootstrapper started.");
        this.Engine.Detect();
        dispatcherThread.Join();
        if (this.dispatcherFailure is not null)
        {
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
                this.window.InstallRequested += (_, _) => this.BeginPlan(LaunchAction.Install);
                this.window.RepairRequested += (_, _) => this.BeginPlan(LaunchAction.Repair);
                this.window.UninstallRequested += (_, _) => this.BeginPlan(LaunchAction.Uninstall);
                this.window.CancelRequested += (_, _) => this.cancelRequested = true;
                this.window.OpenLogRequested += (_, _) => this.OpenBundleLog();
                this.window.Closed += (_, _) => this.dispatcher.InvokeShutdown();
                this.window.Show();
            }

            ready.Set();
            Dispatcher.Run();
        }
        catch (Exception error)
        {
            this.dispatcherFailure = error;
            ready.Set();
        }
    }

    private void SubscribeToEngine()
    {
        this.DetectPackageComplete += this.OnDetectPackageComplete;
        this.DetectComplete += this.OnDetectComplete;
        this.PlanComplete += this.OnPlanComplete;
        this.ApplyBegin += (_, _) => this.Ui(() => this.window?.ShowProgress("Preparing installation", "Windows is establishing a protected transaction.", 2));
        this.CacheAcquireProgress += (_, args) =>
        {
            args.Cancel = this.cancelRequested;
            this.OnProgress(args.OverallPercentage / 2, "Verifying packaged runtime", "Checking every embedded payload before Windows is changed.");
        };
        this.CacheContainerOrPayloadVerifyProgress += (_, args) =>
        {
            args.Cancel = this.cancelRequested;
            this.OnProgress(args.OverallPercentage / 2, "Verifying packaged runtime", "Checking every embedded payload before Windows is changed.");
        };
        this.ExecutePackageBegin += this.OnExecutePackageBegin;
        this.ExecuteProgress += (_, args) =>
        {
            args.Cancel = this.cancelRequested;
            this.OnProgress(50 + (args.OverallPercentage / 2), "Publishing NemoClaw", "Windows Installer is committing verified runtime files with rollback protection.");
        };
        this.Error += this.OnError;
        this.ApplyComplete += this.OnApplyComplete;
    }

    private void OnDetectPackageComplete(object? sender, DetectPackageCompleteEventArgs args)
    {
        if (string.Equals(args.PackageId, "NemoClawArm64Msi", StringComparison.Ordinal))
        {
            this.installed = args.State is PackageState.Present or PackageState.Superseded;
        }
    }

    private void OnDetectComplete(object? sender, DetectCompleteEventArgs args)
    {
        if (args.Status < 0)
        {
            this.result = args.Status;
            this.Ui(() => this.window?.ShowFailure("Windows could not inspect the current NemoClaw installation.", this.BundleLogPath()));
            return;
        }

        if (this.command?.Display == Display.Full)
        {
            this.Ui(() => this.window?.ShowReady(this.installed));
            if (this.command?.Action == LaunchAction.Uninstall)
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
        this.BeginPlan(requested);
    }

    private void BeginPlan(LaunchAction action)
    {
        if (this.plannedAction != LaunchAction.Unknown)
        {
            return;
        }

        this.plannedAction = action;
        this.Ui(() => this.window?.ShowProgress("Planning a safe change", "Burn is calculating install, repair, rollback, and removal actions.", 1));
        this.Engine.Plan(action);
    }

    private void OnPlanComplete(object? sender, PlanCompleteEventArgs args)
    {
        if (args.Status < 0)
        {
            this.result = args.Status;
            this.Ui(() => this.window?.ShowFailure("Windows could not plan the requested NemoClaw change.", this.BundleLogPath()));
            return;
        }

        var owner = this.UiValue(
            () => this.window is null ? IntPtr.Zero : new WindowInteropHelper(this.window).Handle,
            IntPtr.Zero);
        this.Engine.Apply(owner);
    }

    private void OnExecutePackageBegin(object? sender, ExecutePackageBeginEventArgs args)
    {
        var (title, detail, progress) = args.PackageId switch
        {
            "MxcSystemDrivePreparation" => ("Preparing native isolation", "Microsoft MXC is validating protected system-drive access. No WSL or virtual machine is involved.", 54),
            "MxcNullDevicePreparation" => ("Completing the MXC host boundary", "Windows is enabling the boot-scoped primitive required by ProcessContainer.", 58),
            "NemoClawArm64Msi" => ("Publishing NemoClaw", "Windows Installer is installing the ARM64 application, OpenShell, agent runtime, repair metadata, and PATH entry.", 62),
            _ => ("Applying the protected transaction", "Windows Installer is processing the next verified package.", 55),
        };
        args.Cancel = this.cancelRequested;
        this.Ui(() => this.window?.ShowProgress(title, detail, progress));
    }

    private void OnProgress(int percentage, string title, string detail)
    {
        this.Ui(() => this.window?.ShowProgress(title, detail, Math.Clamp(percentage, 0, 99)));
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
            this.Ui(() => this.window?.ShowSuccess(this.plannedAction));
            if (this.command?.Display == Display.Full && this.plannedAction == LaunchAction.Install)
            {
                this.LaunchNemoClaw();
            }
        }
        else
        {
            this.Ui(() => this.window?.ShowFailure("Setup rolled back because Windows could not complete the requested change.", this.BundleLogPath()));
        }

        if (this.command?.Display != Display.Full)
        {
            this.Ui(() => this.window?.Close());
            this.dispatcher?.InvokeShutdown();
        }
    }

    private void LaunchNemoClaw()
    {
        try
        {
            var launcher = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA", "NemoClaw", "bin", "NemoClaw.exe");
            var selectedAgent = this.UiValue(() => this.window?.SelectedAgent ?? "openclaw", "openclaw");
            if (!AllowedAgents.Contains(selectedAgent))
            {
                selectedAgent = "openclaw";
            }
            var process = Process.Start(new ProcessStartInfo
            {
                FileName = launcher,
                Arguments = $"--agent {selectedAgent}",
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(launcher)!,
            });
            process?.Dispose();
            this.Ui(() => this.window?.MarkLaunched());
        }
        catch (Exception error)
        {
            this.Engine.Log(LogLevel.Error, $"NemoClaw first launch failed: {error.Message}");
            this.Ui(() => this.window?.ShowRecoverableError("NemoClaw was installed, but first launch needs another attempt. Use Launch NemoClaw below."));
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

    private int NormalizeExitCode(int code)
    {
        if (this.cancelRequested && code == 0)
        {
            return UserCancelled;
        }
        return (code & unchecked((int)0xFFFF0000)) == unchecked((int)0x80070000) ? code & 0xFFFF : code;
    }
}
