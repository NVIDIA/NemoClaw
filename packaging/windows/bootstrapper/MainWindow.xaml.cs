// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using WixToolset.BootstrapperApplicationApi;

namespace Nvidia.NemoClaw.Bootstrapper;

public partial class MainWindow : Window
{
    private static readonly IReadOnlyDictionary<string, string> AgentNames =
        new Dictionary<string, string>
        {
            ["openclaw"] = "OpenClaw",
            ["hermes"] = "Hermes Agent",
            ["langchain-deepagents-code"] = "Deep Agents Code",
            ["pi"] = "Pi",
            ["nemocua"] = "NemoCUA",
        };
    private readonly Stopwatch elapsed = new();
    private readonly DispatcherTimer elapsedTimer;
    private string logPath = string.Empty;

    public MainWindow()
    {
        this.InitializeComponent();
        this.elapsedTimer = new DispatcherTimer(TimeSpan.FromSeconds(1), DispatcherPriority.Background, this.UpdateElapsed, this.Dispatcher);
    }

    public event EventHandler? InstallRequested;
    public event EventHandler? RepairRequested;
    public event EventHandler? UninstallRequested;
    public event EventHandler? CancelRequested;
    public event EventHandler? OpenLogRequested;

    public string SelectedAgent { get; private set; } = "openclaw";

    public void ShowReady(bool installed)
    {
        this.HidePanels();
        if (installed)
        {
            this.MaintenancePanel.Visibility = Visibility.Visible;
        }
        else
        {
            this.ReadyPanel.Visibility = Visibility.Visible;
        }
    }

    public void ShowMaintenance()
    {
        this.HidePanels();
        this.MaintenancePanel.Visibility = Visibility.Visible;
    }

    public void ShowProgress(string title, string detail, int percentage)
    {
        this.HidePanels();
        this.ProgressPanel.Visibility = Visibility.Visible;
        this.ProgressTitle.Text = title;
        this.ProgressDetail.Text = detail;
        this.ProgressBar.Value = percentage;
        this.ProgressPercent.Text = $"{percentage}%";
        if (!this.elapsed.IsRunning)
        {
            this.elapsed.Start();
            this.elapsedTimer.Start();
        }
    }

    public void ShowSuccess(LaunchAction action)
    {
        this.StopElapsed();
        this.HidePanels();
        this.SuccessPanel.Visibility = Visibility.Visible;
        if (action == LaunchAction.Uninstall)
        {
            this.SuccessTitle.Text = "NemoClaw was removed.";
            this.SuccessDetail.Text = "Windows Installer removed the application, registration, and PATH entry. User-owned state was left outside Program Files.";
        }
        else if (action == LaunchAction.Repair)
        {
            this.SuccessTitle.Text = "NemoClaw is repaired.";
            this.SuccessDetail.Text = "Windows Installer restored the verified runtime. Launch NemoClaw from the Start menu when you are ready.";
        }
        else
        {
            this.SuccessTitle.Text = "NemoClaw is ready.";
            var agentName = AgentNames.GetValueOrDefault(this.SelectedAgent, "selected agent");
            this.SuccessDetail.Text = $"Graphical onboarding for {agentName} is opening now. Runtime state and credentials remain outside the Windows Installer-owned directory.";
        }
    }

    public void MarkLaunched()
    {
        this.SuccessDetail.Text = "NemoClaw onboarding is open. Choose inference and experience options, then continue into the authentic agent surface.";
    }

    public void ShowFailure(string detail, string setupLog)
    {
        this.StopElapsed();
        this.logPath = setupLog;
        this.HidePanels();
        this.FailurePanel.Visibility = Visibility.Visible;
        this.FailureDetail.Text = detail;
    }

    public void ShowRecoverableError(string detail)
    {
        this.RecoverableError.Text = detail;
        this.RecoverableError.Visibility = Visibility.Visible;
    }

    private void HidePanels()
    {
        this.ReadyPanel.Visibility = Visibility.Collapsed;
        this.ProgressPanel.Visibility = Visibility.Collapsed;
        this.SuccessPanel.Visibility = Visibility.Collapsed;
        this.FailurePanel.Visibility = Visibility.Collapsed;
        this.MaintenancePanel.Visibility = Visibility.Collapsed;
    }

    private void LicenseChanged(object sender, RoutedEventArgs args)
    {
        this.InstallButton.IsEnabled = this.LicenseCheck.IsChecked == true;
    }

    private void AgentSelected(object sender, RoutedEventArgs args)
    {
        if (sender is RadioButton { Tag: string agent })
        {
            this.SelectedAgent = agent;
        }
    }

    private void InstallClicked(object sender, RoutedEventArgs args) => this.InstallRequested?.Invoke(this, EventArgs.Empty);

    private void RepairClicked(object sender, RoutedEventArgs args) => this.RepairRequested?.Invoke(this, EventArgs.Empty);

    private void UninstallClicked(object sender, RoutedEventArgs args) => this.UninstallRequested?.Invoke(this, EventArgs.Empty);

    private void CancelClicked(object sender, RoutedEventArgs args)
    {
        this.CancelRequested?.Invoke(this, EventArgs.Empty);
        this.ProgressTitle.Text = "Rolling back safely";
        this.ProgressDetail.Text = "Windows Installer is returning the machine to its previous state.";
    }

    private void OpenLogClicked(object sender, RoutedEventArgs args) => this.OpenLogRequested?.Invoke(this, EventArgs.Empty);

    private void CloseClicked(object sender, RoutedEventArgs args) => this.Close();

    private void UpdateElapsed(object? sender, EventArgs args)
    {
        this.ElapsedText.Text = $"Elapsed {this.elapsed.Elapsed:mm\\:ss}";
    }

    private void StopElapsed()
    {
        this.elapsed.Stop();
        this.elapsedTimer.Stop();
    }
}
