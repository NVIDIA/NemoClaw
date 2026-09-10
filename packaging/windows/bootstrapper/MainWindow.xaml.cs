// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security;
using System.Security.Cryptography;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using WixToolset.BootstrapperApplicationApi;

namespace Nvidia.NemoClaw.Bootstrapper;

public partial class MainWindow : Window
{
    private static readonly IReadOnlyDictionary<string, string> AgentNames = new Dictionary<string, string>
    {
        ["openclaw"] = "OpenClaw",
        ["hermes"] = "Hermes Agent",
        ["langchain-deepagents-code"] = "Deep Agents Code",
        ["pi"] = "Pi",
        ["nemocua"] = "NemoCUA",
    };
    private readonly Stopwatch elapsed = new();
    private readonly Stopwatch phaseElapsed = new();
    private TimeSpan lastStatusUpdate;
    private bool hasInstallerProgress;
    private readonly DispatcherTimer elapsedTimer;
    private bool busy;
    private bool canCancel;
    private bool cancelling;
    private bool completed;
    private bool packageInstalled;
    private bool configurationSaved;
    private bool preparingModel;

    public MainWindow()
    {
        this.InitializeComponent();
        this.elapsedTimer = new DispatcherTimer(TimeSpan.FromSeconds(1), DispatcherPriority.Background, this.UpdateElapsed, this.Dispatcher);
        this.elapsedTimer.Stop();
        this.ProviderChoice.SelectedIndex = 0;
        this.ShowProgress("Checking this PC", "Looking for an existing NemoClaw installation.");
        this.canCancel = false;
        this.CancelButton.IsEnabled = false;
        this.Closing += this.WindowClosing;
        this.Loaded += (_, _) =>
        {
            var workArea = SystemParameters.WorkArea;
            this.MinWidth = Math.Min(this.MinWidth, Math.Max(640, workArea.Width - 24));
            this.MinHeight = Math.Min(this.MinHeight, Math.Max(480, workArea.Height - 24));
            this.Width = Math.Min(this.Width, workArea.Width - 24);
            this.Height = Math.Min(this.Height, workArea.Height - 24);
        };
        this.Loaded += async (_, _) =>
        {
            try
            {
                var eligibility = await NativeExpressSetup.CheckPreliminaryEligibilityAsync();
                if (!this.IsLoaded || !eligibility.IsDevice) return;
                this.ExpressOffer.Visibility = Visibility.Visible;
                this.ExpressStatus.Text = eligibility.Message;
                this.UseExpressButton.IsEnabled = eligibility.Eligible;
                if (eligibility.Eligible) this.ProviderChoice.Items.Add(new ComboBoxItem { Tag = "n1x", Content = NativeExpressSetup.DisplayName });
            }
            catch (Exception) { this.ExpressOffer.Visibility = Visibility.Collapsed; }
        };
    }

    public event EventHandler? InstallRequested;
    public event EventHandler? RepairRequested;
    public event EventHandler? UninstallRequested;
    public event EventHandler? ReplacePreviewRequested;
    public void SetDataRemovalAvailable(bool available) => this.RemovalOptions.SetAvailable(available);
    public void SetMaintenanceContext(bool relatedOnly)
    {
        this.ReplacePreviewButton.Visibility = relatedOnly ? Visibility.Visible : Visibility.Collapsed;
        this.ConfigureInstalledAgentButton.Visibility = relatedOnly ? Visibility.Collapsed : Visibility.Visible;
    }
    private void ReplacePreviewClicked(object sender, RoutedEventArgs args) => this.ReplacePreviewRequested?.Invoke(this, EventArgs.Empty);
    public event EventHandler? CancelRequested;
    public event EventHandler? OpenLogRequested;
    public event EventHandler? ConfigureRequested;
    public event EventHandler? LaunchRequested;
    public event EventHandler? ModelSetupCancelRequested;

    public string SelectedAgent { get; private set; } = "openclaw";
    public string[] SelectedRemovalAgents => this.RemovalOptions.SelectedAgents;
    public bool RequiresRemovalSelection => this.RemovalOptions.RequiresSelection;
    internal NativeSetupConfiguration? Configuration { get; private set; }
    internal SecureString CopyCredential() => this.CredentialBox.SecurePassword;
    internal NativeServiceCredentials CopyServiceCredentials() => this.ServiceOptions.CopyCredentials();
    internal void ClearCredential()
    {
        this.CredentialBox.Clear();
        this.ServiceOptions.ClearSecrets();
    }

    internal void ShowNativeOnboarding(string? initialAgent)
    {
        this.OpenLogButton.Visibility = Visibility.Collapsed;
        this.ConfigureAnotherClicked(this, new RoutedEventArgs());
        var choice = initialAgent switch
        {
            "hermes" => this.HermesChoice,
            "langchain-deepagents-code" => this.DeepAgentsChoice,
            "pi" => this.PiChoice,
            "nemocua" => this.NemoCuaChoice,
            _ => this.OpenClawChoice,
        };
        choice.IsChecked = true;
        choice.BringIntoView();
    }

    public void ShowReady(bool installed)
    {
        this.busy = false;
        this.StopElapsed();
        this.elapsed.Reset();
        this.hasInstallerProgress = false;
        this.SetJourneyStage(installed ? 4 : 1);
        this.HidePanels();
        (installed ? this.MaintenancePanel : this.ReadyPanel).Visibility = Visibility.Visible;
    }

    public void ShowMaintenance()
    {
        this.busy = false;
        this.MaintenanceError.Visibility = Visibility.Collapsed;
        this.HidePanels();
        this.MaintenancePanel.Visibility = Visibility.Visible;
    }

    public void ShowProgress(string title, string detail)
    {
        this.busy = true;
        this.canCancel = true;
        this.SetJourneyStage(3);
        this.HidePanels();
        this.ProgressPanel.Visibility = Visibility.Visible;
        var currentTitle = this.cancelling ? "Cancelling safely" : title;
        if (this.ProgressTitle.Text != currentTitle) this.phaseElapsed.Restart();
        this.ProgressTitle.Text = currentTitle;
        this.ProgressDetail.Text = this.cancelling ? "Please keep this window open while Windows completes rollback." : detail;
        if (!this.hasInstallerProgress)
        {
            this.ProgressBar.IsIndeterminate = true;
            this.ProgressPercent.Text = "In progress";
        }
        this.CancelButton.IsEnabled = !this.cancelling;
        if (!this.elapsed.IsRunning)
        {
            this.elapsed.Start();
            this.elapsedTimer.Start();
        }
        this.lastStatusUpdate = this.elapsed.Elapsed;
        this.UpdateElapsed(this, EventArgs.Empty);
    }

    public void SetInstallerProgress(int percentage)
    {
        this.hasInstallerProgress = true;
        this.ProgressBar.IsIndeterminate = false;
        this.ProgressBar.Value = Math.Clamp(percentage, 0, 100);
        this.ProgressPercent.Text = $"{this.ProgressBar.Value:0}%";
        this.lastStatusUpdate = this.elapsed.Elapsed;
    }

    public void ShowConfiguring()
    {
        this.packageInstalled = true;
        this.hasInstallerProgress = false;
        this.ShowProgress("Saving your agent settings", "Saving your choices and protecting the API key in Windows Credential Manager.");
        this.canCancel = false;
        this.CancelButton.IsEnabled = false;
    }

    internal void ShowModelProgress(NativeExpressProgress progress)
    {
        if (progress.Phase == "configuration")
        {
            this.preparingModel = false;
            this.ShowConfiguring();
            return;
        }
        this.preparingModel = true;
        this.hasInstallerProgress = false;
        this.ShowProgress("Preparing your on-device model", progress.Message);
        this.ProgressLabel.Text = "N1X EXPRESS MODEL SETUP";
        this.canCancel = true;
        this.CancelButton.Content = "Cancel model setup";
        if (progress.CompletedBytes is long completed && progress.TotalBytes is long total && total > 0 && completed >= 0 && completed <= total)
        {
            this.ProgressBar.IsIndeterminate = false;
            this.ProgressBar.Value = 100d * completed / total;
            this.ProgressPercent.Text = $"{completed / 1_000_000_000d:0.0} / {total / 1_000_000_000d:0.0} GB";
        }
    }

    public void ShowConfigurationFailure(string? detail = null)
    {
        this.busy = false;
        this.preparingModel = false;
        this.StopElapsed();
        this.HidePanels();
        this.ConfigurationPanel.Visibility = Visibility.Visible;
        this.SetJourneyStage(2);
        this.ConfigurationDetail.Text = "NemoClaw is installed. Complete your agent settings to finish setup.";
        this.InstallButton.Content = "Save configuration";
        this.BackButton.Visibility = Visibility.Collapsed;
        this.ShowConfigurationError(detail ?? "Windows could not save the agent configuration. Check these settings and try again. Your installed application is available for repair in Windows Installed apps.");
    }

    public void ShowConfiguredSuccess()
    {
        this.configurationSaved = true;
        this.ShowSuccess(LaunchAction.Install);
    }

    public void ShowSuccess(LaunchAction action)
    {
        this.busy = false;
        this.preparingModel = false;
        this.completed = true;
        this.SetJourneyStage(4);
        this.StopElapsed();
        this.ClearCredential();
        this.HidePanels();
        this.SuccessPanel.Visibility = Visibility.Visible;
        this.LaunchButton.Visibility = action == LaunchAction.Install && this.configurationSaved ? Visibility.Visible : Visibility.Collapsed;
        if (action == LaunchAction.Uninstall)
        {
            this.SuccessTitle.Text = "NemoClaw was removed.";
            this.SuccessDetail.Text = "The application was removed. Your personal agent settings remain in your Windows account.";
        }
        else if (action == LaunchAction.Repair)
        {
            this.SuccessTitle.Text = "NemoClaw is repaired.";
            this.SuccessDetail.Text = "Your native runtime is restored. Open NemoClaw from the Start menu when you are ready.";
        }
        else
        {
            var agentName = AgentNames.GetValueOrDefault(this.SelectedAgent, "Your agent");
            this.SuccessTitle.Text = this.configurationSaved ? $"{agentName} is ready." : "NemoClaw is installed.";
            this.SuccessDetail.Text = this.configurationSaved
                ? "Setup is complete. Your settings are saved for your Windows account. Launch your agent when you are ready."
                : "The native application is installed. Your agent configuration has not been saved.";
            this.LaunchButton.Content = $"Launch {agentName}";
        }
        this.CloseButton.Focus();
    }

    public void MarkLaunched()
    {
        this.SuccessDetail.Text = "Your configured agent is opening. You can close this setup window.";
        this.LaunchButton.IsEnabled = false;
    }

    public void ShowFailure(string detail, string setupLog)
    {
        this.busy = false;
        this.completed = true;
        this.StopElapsed();
        this.ClearCredential();
        this.HidePanels();
        this.FailurePanel.Visibility = Visibility.Visible;
        this.FailureDetail.Text = File.Exists(setupLog) ? $"{detail}\n\nSetup log:\n{setupLog}" : detail;
    }

    public void ShowRecoverableError(string detail)
    {
        if (this.MaintenancePanel.Visibility == Visibility.Visible)
        {
            this.MaintenanceError.Text = detail;
            this.MaintenanceError.Visibility = Visibility.Visible;
            this.MaintenanceError.BringIntoView();
            return;
        }
        if (this.SuccessPanel.Visibility == Visibility.Visible)
        {
            this.SuccessDetail.Text = detail;
            return;
        }
        this.RecoverableError.Text = detail;
        this.RecoverableError.Visibility = Visibility.Visible;
    }

    private void HidePanels()
    {
        foreach (var panel in new[] { this.ReadyPanel, this.ConfigurationPanel, this.ProgressPanel, this.SuccessPanel, this.FailurePanel, this.MaintenancePanel })
        {
            panel.Visibility = Visibility.Collapsed;
        }
    }

    private void SetJourneyStage(int stage)
    {
        var inactive = new SolidColorBrush(Color.FromRgb(0x62, 0x65, 0x5F));
        var active = (Brush)this.FindResource("NvidiaGreen");
        var dots = new[] { this.ChooseStageDot, this.ProtectStageDot, this.InstallStageDot, this.LaunchStageDot };
        for (var index = 0; index < dots.Length; index++)
        {
            var reached = index < stage;
            dots[index].Background = reached ? active : Brushes.Transparent;
            dots[index].BorderBrush = reached ? active : inactive;
            if (dots[index].Child is TextBlock number)
            {
                number.Foreground = reached ? Brushes.Black : Brushes.LightGray;
                number.FontWeight = reached ? FontWeights.Bold : FontWeights.Normal;
            }
        }
    }

    private void LicenseChanged(object sender, RoutedEventArgs args)
    {
        if (this.InstallButton is not null) this.InstallButton.IsEnabled = this.LicenseCheck.IsChecked == true;
    }

    private void AgentSelected(object sender, RoutedEventArgs args)
    {
        if (sender is RadioButton { Tag: string agent } choice && AgentNames.ContainsKey(agent))
        {
            this.SelectedAgent = agent;
            choice.BringIntoView();
        }
    }

    private void ConfigureClicked(object sender, RoutedEventArgs args)
    {
        this.ServiceOptions.SetAgent(this.SelectedAgent);
        this.HidePanels();
        this.SetJourneyStage(2);
        this.ConfigurationPanel.Visibility = Visibility.Visible;
        this.ConfigurationDetail.Text = $"Connect {AgentNames[this.SelectedAgent]} to a provider or an existing local model server.";
        this.ProviderChoice.Focus();
    }

    private void BackClicked(object sender, RoutedEventArgs args) => this.ShowReady(false);

    private void ConfigureAnotherClicked(object sender, RoutedEventArgs args)
    {
        this.packageInstalled = true;
        this.configurationSaved = false;
        this.completed = false;
        this.Configuration = null;
        this.InstallButton.Content = "Save configuration";
        this.BackButton.Visibility = Visibility.Visible;
        this.ShowReady(false);
    }

    private void ProviderChanged(object sender, SelectionChangedEventArgs args)
    {
        if (this.EndpointBox is null || this.ProviderChoice.SelectedItem is not ComboBoxItem { Tag: string provider }) return;
        this.CredentialBox.Clear();
        this.EndpointBox.IsReadOnly = provider is "nvidia" or "openrouter" or "n1x";
        this.EndpointLabel.Visibility = this.EndpointBox.Visibility = provider == "n1x" ? Visibility.Collapsed : Visibility.Visible;
        this.CredentialLabel.Visibility = this.CredentialBox.Visibility = provider == "n1x" ? Visibility.Collapsed : Visibility.Visible;
        this.ModelBox.IsReadOnly = provider == "n1x";
        this.ModelDownloadNotice.Visibility = provider == "n1x" ? Visibility.Visible : Visibility.Collapsed;
        this.ModelDownloadNotice.Text = NativeExpressSetup.DownloadDescription + ". Setup downloads and checks the text-and-tools model, then waits for a successful local response.";
        this.EndpointBox.Text = provider switch
        {
            "nvidia" => "https://integrate.api.nvidia.com/v1",
            "openrouter" => "https://openrouter.ai/api/v1",
            "local" => "http://127.0.0.1:8000/v1",
            "n1x" => "http://127.0.0.1:8000/v1",
            _ => "https://",
        };
        this.ModelBox.Text = provider == "n1x" ? NativeExpressSetup.Model : provider is "nvidia" or "openrouter" ? "nvidia/nemotron-3-super-120b-a12b" : string.Empty;
        this.CredentialLabel.Content = provider is "nvidia" or "openrouter" ? "API _key" : "API _key (optional)";
        this.InferenceHelpPanel.Visibility = provider is "nvidia" or "openrouter" ? Visibility.Visible : Visibility.Collapsed;
        var helpUrl = provider == "openrouter" ? "https://openrouter.ai/settings/keys" : "https://build.nvidia.com/";
        this.InferenceHelpLink.NavigateUri = new Uri(helpUrl);
        this.InferenceHelpUrlText.Text = helpUrl;
        this.InferenceKeyHelp.Text = provider == "openrouter" ? "Create a key in your OpenRouter workspace." : "Sign in to NVIDIA's API catalog, choose a model, and create an API key.";
        this.EndpointHelp.Text = provider == "local" ? "Use an already-running server at 127.0.0.1 or [::1]. Local inference is experimental." : "Use the provider's HTTPS API root. API keys belong in the protected field below.";
        this.ConfigurationErrorPanel.Visibility = Visibility.Collapsed;
    }

    private void InstallClicked(object sender, RoutedEventArgs args)
    {
        try
        {
            if (this.LicenseCheck.IsChecked != true) return;
            if (this.ProviderChoice.SelectedItem is not ComboBoxItem { Tag: string provider }) throw new InvalidOperationException("Choose an inference provider.");
            var express = provider == "n1x";
            if (express) provider = "local";
            if (!Uri.TryCreate(this.EndpointBox.Text.Trim(), UriKind.Absolute, out var endpoint) ||
                endpoint.UserInfo.Length != 0 || endpoint.Query.Length != 0 || endpoint.Fragment.Length != 0)
            {
                throw new InvalidOperationException("Enter a complete API endpoint without credentials, query parameters, or a fragment.");
            }
            var loopback = endpoint.Host is "127.0.0.1" or "[::1]" or "::1";
            if ((provider == "local" && (!loopback || endpoint.Scheme is not ("http" or "https"))) ||
                (provider != "local" && endpoint.Scheme != "https"))
            {
                throw new InvalidOperationException("Use HTTPS for hosted inference or a loopback address for local inference.");
            }
            var model = this.ModelBox.Text.Trim();
            if (model.Length is 0 or > 256 || model.Any(char.IsControl)) throw new InvalidOperationException("Enter a valid model ID.");
            using var password = this.CopyCredential();
            var options = this.ServiceOptions.ReadOptions();
            using var serviceCredentials = this.CopyServiceCredentials();
            foreach (var (service, key) in serviceCredentials)
            {
                var serviceBytes = NativeSetupConfiguration.ReadServiceCredential(service, key);
                CryptographicOperations.ZeroMemory(serviceBytes);
            }
            var configuration = new NativeSetupConfiguration(this.SelectedAgent, provider, endpoint.AbsoluteUri.TrimEnd('/'), model, password.Length != 0) { Options = options, LocalModel = express ? NativeExpressSetup.Id : null };
            var bytes = configuration.ReadCredential(password);
            CryptographicOperations.ZeroMemory(bytes);
            this.Configuration = configuration;
            this.ConfigurationErrorPanel.Visibility = Visibility.Collapsed;
            if (this.packageInstalled) this.ConfigureRequested?.Invoke(this, EventArgs.Empty);
            else this.InstallRequested?.Invoke(this, EventArgs.Empty);
        }
        catch (InvalidOperationException error)
        {
            this.ShowConfigurationError(error.Message);
        }
    }

    private void ShowConfigurationError(string message)
    {
        this.ConfigurationError.Text = message;
        this.ConfigurationErrorPanel.Visibility = Visibility.Visible;
        this.ConfigurationError.BringIntoView();
    }

    private void InferenceHelpClicked(object sender, RoutedEventArgs args)
    {
        if (sender is not Hyperlink { NavigateUri: Uri uri }) return;
        try { Process.Start(new ProcessStartInfo { FileName = uri.AbsoluteUri, UseShellExecute = true })?.Dispose(); }
        catch (Exception) { this.ShowConfigurationError($"Open the official key page in your browser: {uri.AbsoluteUri}"); }
    }

    private void RepairClicked(object sender, RoutedEventArgs args) => this.RepairRequested?.Invoke(this, EventArgs.Empty);
    private void UninstallClicked(object sender, RoutedEventArgs args) => this.UninstallRequested?.Invoke(this, EventArgs.Empty);
    private void OpenLogClicked(object sender, RoutedEventArgs args) => this.OpenLogRequested?.Invoke(this, EventArgs.Empty);
    private void LaunchClicked(object sender, RoutedEventArgs args) => this.LaunchRequested?.Invoke(this, EventArgs.Empty);
    private void CloseClicked(object sender, RoutedEventArgs args) => this.Close();
    private void MinimizeClicked(object sender, RoutedEventArgs args) => this.WindowState = WindowState.Minimized;

    private void CancelClicked(object sender, RoutedEventArgs args)
    {
        if (this.preparingModel)
        {
            this.ModelSetupCancelRequested?.Invoke(this, EventArgs.Empty);
            this.CancelButton.IsEnabled = false;
            this.ProgressTitle.Text = "Stopping model setup";
            this.ProgressDetail.Text = "Waiting for the native model helper to stop safely.";
            return;
        }
        if (!this.canCancel || this.cancelling) return;
        this.cancelling = true;
        this.CancelButton.IsEnabled = false;
        this.CancelRequested?.Invoke(this, EventArgs.Empty);
        this.ProgressTitle.Text = "Cancelling safely";
        this.phaseElapsed.Restart();
        this.lastStatusUpdate = this.elapsed.Elapsed;
        this.ProgressDetail.Text = "Please keep this window open while Windows completes rollback.";
    }

    private void UseExpressClicked(object sender, RoutedEventArgs args)
    {
        foreach (var item in this.ProviderChoice.Items.OfType<ComboBoxItem>())
            if (item.Tag as string == "n1x") { this.ProviderChoice.SelectedItem = item; this.ConfigureClicked(sender, args); return; }
    }

    private void WindowClosing(object? sender, CancelEventArgs args)
    {
        if (this.busy)
        {
            args.Cancel = true;
            this.CancelClicked(this, new RoutedEventArgs());
            return;
        }
        if (!this.completed) this.CancelRequested?.Invoke(this, EventArgs.Empty);
        this.ClearCredential();
        this.StopElapsed();
    }

    private void HeaderMouseDown(object sender, MouseButtonEventArgs args)
    {
        if (args.OriginalSource is DependencyObject source)
        {
            for (var current = source; current is not null; current = VisualTreeHelper.GetParent(current))
            {
                if (current is Button) return;
            }
        }
        if (args.ClickCount == 2) this.WindowState = this.WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        else if (args.LeftButton == MouseButtonState.Pressed) this.DragMove();
    }

    private void WindowKeyDown(object sender, KeyEventArgs args)
    {
        if (args.Key != Key.Escape) return;
        args.Handled = true;
        this.Close();
    }

    private void WindowSizeChanged(object sender, SizeChangedEventArgs args)
    {
        if (this.SidebarLogo is not null) this.SidebarLogo.Visibility = this.ActualHeight < 680 ? Visibility.Collapsed : Visibility.Visible;
    }

    private void UpdateElapsed(object? sender, EventArgs args)
    {
        this.ElapsedText.Text = $"Elapsed {this.elapsed.Elapsed:hh\\:mm\\:ss}";
        var sinceUpdate = this.elapsed.Elapsed - this.lastStatusUpdate;
        this.PhaseActivityText.Text = $"This step {this.phaseElapsed.Elapsed:hh\\:mm\\:ss} · last status update {sinceUpdate:hh\\:mm\\:ss} ago";
    }
    private void StopElapsed()
    {
        this.elapsed.Stop();
        this.phaseElapsed.Stop();
        this.elapsedTimer.Stop();
    }
}
