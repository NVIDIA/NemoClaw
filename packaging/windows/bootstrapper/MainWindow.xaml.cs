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
using System.Windows.Media.Animation;
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
    private readonly NativeProgressPresentation progress = new();
    private readonly NativeRuntimeAvailability runtimeAvailability = NativeRuntimeAvailability.Load();
    private double? displayedPercentage;
    private readonly DispatcherTimer elapsedTimer;
    private bool busy;
    private bool canCancel;
    private bool cancelling;
    private bool completed;
    private bool packageInstalled;
    private bool configurationSaved;
    private bool preparingModel;
    private NativeExpressEligibility? localEligibility;

    public MainWindow()
    {
        this.InitializeComponent();
        this.ApplyRuntimeAvailability();
        this.elapsedTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(100), DispatcherPriority.Background, this.UpdateElapsed, this.Dispatcher);
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
                var downloads = this.runtimeAvailability.BundledLocalInferenceAvailable;
                var eligibility = await NativeExpressSetup.CheckPreliminaryEligibilityAsync(downloads);
                if (this.runtimeAvailability.IsSelectedRuntimeBuild && !this.runtimeAvailability.PrebuiltLocalModelAvailable && !downloads)
                    eligibility = eligibility with { Eligible = false, Message = "The prebuilt on-device model is not included in this distribution. Choose a hosted provider or an existing local server." };
                if (!this.IsLoaded || !eligibility.IsDevice) return;
                this.localEligibility = eligibility;
                this.ExpressOffer.Visibility = Visibility.Visible;
                this.ExpressStatus.Text = eligibility.Message;
                if (eligibility.Eligible && downloads)
                {
                    ComboBoxItem? recommended = null;
                    foreach (var model in NativeDownloadedModelSetup.Models)
                    {
                        var item = new ComboBoxItem { Tag = model.GetProperty("id").GetString(), Content = "Run locally · " + model.GetProperty("displayName").GetString() };
                        this.ProviderChoice.Items.Add(item);
                        recommended ??= item;
                    }
                    if (this.SelectedAgent == "openclaw" && recommended is not null) this.ProviderChoice.SelectedItem = recommended;
                }
                else if (eligibility.Eligible) this.ProviderChoice.Items.Add(new ComboBoxItem { Tag = "n1x", Content = NativeExpressSetup.DisplayName });
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
    public event EventHandler? RetryRequested;
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
        var choice = (initialAgent ?? this.SelectedAgent) switch
        {
            "hermes" => this.HermesChoice,
            "langchain-deepagents-code" => this.DeepAgentsChoice,
            "pi" => this.PiChoice,
            "nemocua" => this.NemoCuaChoice,
            _ => this.OpenClawChoice,
        };
        choice.IsChecked = true;
        if (!choice.IsEnabled)
        {
            this.AgentAvailabilityDetail.Text = this.runtimeAvailability.UnavailableText;
            this.AgentAvailabilityDetail.Visibility = Visibility.Visible;
            this.ContinueAgentButton.IsEnabled = false;
            return;
        }
        choice.BringIntoView();
    }

    public void ShowReady(bool installed)
    {
        this.busy = false;
        this.StopElapsed();
        this.progress.Reset();
        this.OverallProgressText.Visibility = Visibility.Collapsed;
        this.OverallProgressBar.Visibility = Visibility.Collapsed;
        this.SetJourneyStage(installed ? 4 : 1);
        this.HidePanels();
        (installed ? this.MaintenancePanel : this.ReadyPanel).Visibility = Visibility.Visible;
    }

    public void ShowMaintenance()
    {
        this.busy = false;
        this.StopElapsed();
        this.MaintenanceError.Visibility = Visibility.Collapsed;
        this.HidePanels();
        this.MaintenancePanel.Visibility = Visibility.Visible;
    }

    public void ShowProgress(string title, string detail, string? phase = null)
    {
        if (!this.busy) this.progress.Reset();
        this.busy = true;
        this.completed = false;
        this.canCancel = true;
        this.SetJourneyStage(3);
        this.HidePanels();
        this.ProgressPanel.Visibility = Visibility.Visible;
        this.ProgressTitle.Text = this.cancelling ? "Cancelling safely" : title;
        this.ProgressDetail.Text = this.cancelling ? "Please keep this window open while Windows completes rollback." : detail;
        this.progress.Report(this.cancelling ? "cancelling" : phase ?? title);
        this.ProgressLabel.Text = "CURRENT STEP";
        this.CancelButton.IsEnabled = !this.cancelling;
        this.elapsedTimer.Start();
        this.RenderProgress();
    }

    public void SetInstallerProgress(int percentage)
    {
        if (percentage is < 0 or > 100 || !this.busy) return;
        this.OverallProgressText.Text = $"Windows installation · {percentage}% reported";
        this.OverallProgressText.Visibility = NativePreviewPresentation.DiagnosticsEnabled ? Visibility.Visible : Visibility.Collapsed;
        this.OverallProgressBar.Value = percentage;
        this.OverallProgressBar.Visibility = NativePreviewPresentation.DiagnosticsEnabled ? Visibility.Visible : Visibility.Collapsed;
    }

    public void SetPackageProgress(int percentage)
    {
        if (!this.busy || this.cancelling) return;
        this.progress.Report(this.progress.Phase, NativeProgressMeasurement.Create(percentage, 100, "percent"));
        this.RenderProgress();
    }

    public void ShowMeasuredProgress(string phase, string title, string detail, long completed, long total)
    {
        this.ShowProgress(title, detail, phase);
        if (this.cancelling) return;
        this.progress.Report(this.progress.Phase, NativeProgressMeasurement.Create(completed, total, "bytes"));
        this.RenderProgress();
    }

    private void RenderProgress()
    {
        var measurement = this.progress.Measurement;
        this.ProgressBar.IsIndeterminate = measurement is null;
        this.ProgressPercent.Text = measurement?.Label ?? "Working…";
        if (measurement is not null && this.displayedPercentage != measurement.Percentage)
        {
            if (measurement.Percentage < this.ProgressBar.Value)
            {
                this.ProgressBar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, null);
                this.ProgressBar.Value = measurement.Percentage;
            }
            else
            {
                var animation = new DoubleAnimation(this.ProgressBar.Value, measurement.Percentage, TimeSpan.FromMilliseconds(200))
                { EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut } };
                this.ProgressBar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, animation, HandoffBehavior.SnapshotAndReplace);
            }
            this.displayedPercentage = measurement.Percentage;
        }
        else if (measurement is null)
        {
            this.ProgressBar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, null);
            this.ProgressBar.Value = 0;
            this.displayedPercentage = null;
        }
        this.UpdateElapsed(this, EventArgs.Empty);
    }

    public void ShowConfiguring()
    {
        this.packageInstalled = true;
        this.ShowProgress("Preparing your agent settings", this.Configuration?.LocalModel is not null
            ? "Checking the included engine and selected model, then saving your local configuration."
            : "Saving your choices and protecting the API key in Windows Credential Manager.");
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
        var title = progress.Phase switch
        {
            "checking" => "Checking the saved model",
            "downloading" => "Downloading the on-device model",
            "verifying" => "Verifying the on-device model",
            "unpacking" => "Preparing the model engine",
            "loading" => "Loading the model on your GPU",
            "probing" => "Testing a real GPU response",
            _ => "Preparing your on-device model",
        };
        this.ShowProgress(title, progress.Message, "model-" + progress.Phase);
        this.ProgressLabel.Text = "LOCAL SETUP · " + progress.Phase.ToUpperInvariant();
        this.canCancel = true;
        this.CancelButton.Content = "Cancel model setup";
        if (progress.CompletedBytes is long completed && progress.TotalBytes is long total && total > 0 && completed >= 0 && completed <= total)
        {
            this.progress.Report(this.progress.Phase, NativeProgressMeasurement.Create(completed, total, "bytes"));
            this.RenderProgress();
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
        this.ConfigurationDetail.Text = "NemoClaw is installed, but agent setup did not finish. Correct the issue and retry; completed model downloads are reused.";
        this.InstallButton.Content = "Save configuration";
        this.BackButton.Visibility = Visibility.Collapsed;
        this.UpdateSetupAction();
        this.ShowConfigurationError(detail ?? "Windows could not save the agent configuration. Check these settings and try again. Your installed application is available for repair in Windows Installed apps.");
    }

    public void ShowConfiguredSuccess()
    {
        var launch = !this.configurationSaved && this.Configuration?.LaunchAfterSetup == true;
        this.configurationSaved = true;
        this.ShowSuccess(LaunchAction.Install);
        if (launch)
        {
            this.SuccessTitle.Text = this.Configuration?.LocalModel is not null ? "OpenClaw is GPU-ready." : "OpenClaw setup is complete.";
            this.LaunchRequested?.Invoke(this, EventArgs.Empty);
        }
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
            this.SuccessSummary.Text = "Downloaded local models are retained for a faster reinstall. Remove them manually only if you need to reclaim their storage.";
        }
        else if (action == LaunchAction.Repair)
        {
            this.SuccessTitle.Text = "NemoClaw is repaired.";
            this.SuccessDetail.Text = "Your native runtime is restored. Open NemoClaw from the Start menu when you are ready.";
            this.SuccessSummary.Text = "The installed application was repaired. Agent data and downloaded models were preserved.";
        }
        else
        {
            var agentName = AgentNames.GetValueOrDefault(this.SelectedAgent, "Your agent");
            this.SuccessTitle.Text = this.configurationSaved ? $"{agentName} is ready." : "NemoClaw is installed.";
            this.SuccessDetail.Text = this.configurationSaved
                ? this.Configuration?.LocalModel is not null
                    ? $"Setup loaded {this.Configuration.Model} on the NVIDIA GPU and received a real model response. Launching starts a fresh chat; the first visible reply can still take longer than later replies."
                    : "Setup is complete. Your settings are saved for your Windows account. Launch your agent when you are ready."
                : "The native application is installed. Your agent configuration has not been saved.";
            this.SuccessSummary.Text = this.Configuration?.LocalModel is not null
                ? $"GPU check passed · {this.Configuration.Model}" +
                    (this.localEligibility?.DriverVersion is string driver ? $" · driver {driver}" : "") +
                    (this.localEligibility?.CudaVersion is string cuda ? $" · CUDA {cuda}" : "")
                : "Installed for native Windows ARM64. Repair or remove NemoClaw from Windows Installed apps.";
            this.LaunchButton.Content = $"Launch {agentName}";
        }
        this.CloseButton.Focus();
    }

    public void MarkLaunched()
    {
        if (this.Configuration?.LaunchAfterSetup == true) this.SuccessTitle.Text = "Starting OpenClaw";
        this.SuccessDetail.Text = this.SelectedAgent is "openclaw" or "hermes"
            ? "The session window is opening. It shows preparation progress and opens the browser after the agent's Web UI becomes available. You can close Setup."
            : "Your configured agent's own window is opening. You can close this setup window.";
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
        this.FailureDetail.Text = File.Exists(setupLog)
            ? $"{detail}\n\nRetry after correcting the cause, copy this error, or open Setup log for saved details."
            : $"{detail}\n\nRetry after correcting the cause, or copy this error for support.";
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
            if (this.ContinueAgentButton is not null)
                this.ContinueAgentButton.IsEnabled = this.runtimeAvailability.CanSelect(agent);
            choice.BringIntoView();
        }
    }

    private void ConfigureClicked(object sender, RoutedEventArgs args)
    {
        if (!this.runtimeAvailability.CanSelect(this.SelectedAgent)) return;
        this.ServiceOptions.SetAgent(this.SelectedAgent);
        this.HidePanels();
        this.SetJourneyStage(2);
        this.ConfigurationPanel.Visibility = Visibility.Visible;
        this.ConfigurationDetail.Text = $"Choose on-device inference when available, a hosted provider, or an existing local server for {AgentNames[this.SelectedAgent]}.";
        this.UpdateSetupAction();
        this.ProviderChoice.Focus();
    }

    private void ApplyRuntimeAvailability()
    {
        if (!this.runtimeAvailability.IsSelectedRuntimeBuild) return;
        var choices = new[] { this.OpenClawChoice, this.HermesChoice, this.DeepAgentsChoice, this.PiChoice, this.NemoCuaChoice };
        var details = new[] { this.OpenClawAvailability, this.HermesAvailability, this.DeepAgentsAvailability, this.PiAvailability, this.NemoCuaAvailability };
        for (var index = 0; index < choices.Length; index++)
        {
            var enabled = this.runtimeAvailability.CanSelect((string)choices[index].Tag);
            choices[index].IsEnabled = enabled;
            var preview = this.runtimeAvailability.IsUnqualified((string)choices[index].Tag);
            details[index].Text = !enabled ? this.runtimeAvailability.UnavailableText : preview ? this.runtimeAvailability.PreviewText : "";
            details[index].Visibility = !enabled || preview ? Visibility.Visible : Visibility.Collapsed;
        }
        var first = choices.FirstOrDefault(choice => choice.IsEnabled);
        if (first is not null) first.IsChecked = true;
        this.ContinueAgentButton.IsEnabled = first is not null;
        this.AgentAvailabilityDetail.Text = "Included preview profiles can be tried while runtime qualification continues.";
        this.AgentAvailabilityDetail.Visibility = Visibility.Visible;
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
        var download = NativeDownloadedModelSetup.IsModel(provider);
        var managed = download || provider == "n1x";
        this.CredentialBox.Clear();
        this.EndpointBox.IsReadOnly = managed || provider is "nvidia" or "openrouter";
        this.EndpointLabel.Visibility = this.EndpointBox.Visibility = managed ? Visibility.Collapsed : Visibility.Visible;
        this.CredentialLabel.Visibility = this.CredentialBox.Visibility = managed ? Visibility.Collapsed : Visibility.Visible;
        this.EndpointHelp.Visibility = this.CredentialHelp.Visibility = managed ? Visibility.Collapsed : Visibility.Visible;
        this.ModelLabel.Visibility = this.ModelBox.Visibility = managed ? Visibility.Collapsed : Visibility.Visible;
        this.ModelBox.IsReadOnly = managed;
        this.ModelDownloadNotice.Visibility = managed ? Visibility.Visible : Visibility.Collapsed;
        this.ModelDownloadNotice.Text = download ? NativeDownloadedModelSetup.Description(provider) : "Uses the prebuilt on-device model in this distribution. Saving only records your choice; its service starts when you launch the agent.";
        this.EndpointBox.Text = provider switch
        {
            "nvidia" => "https://integrate.api.nvidia.com/v1",
            "openrouter" => "https://openrouter.ai/api/v1",
            "local" => "http://127.0.0.1:8000/v1",
            "n1x" => string.Empty,
            _ => "https://",
        };
        if (download) this.EndpointBox.Text = string.Empty;
        this.ModelBox.Text = download ? provider : provider == "n1x" ? NativeExpressSetup.Model : provider is "nvidia" or "openrouter" ? "nvidia/nemotron-3-super-120b-a12b" : string.Empty;
        this.CredentialLabel.Content = provider is "nvidia" or "openrouter" ? "API _key" : "API _key (optional)";
        this.InferenceHelpPanel.Visibility = provider is "nvidia" or "openrouter" ? Visibility.Visible : Visibility.Collapsed;
        var helpUrl = provider == "openrouter" ? "https://openrouter.ai/settings/keys" : "https://build.nvidia.com/";
        this.InferenceHelpLink.NavigateUri = new Uri(helpUrl);
        this.InferenceHelpUrlText.Text = helpUrl;
        this.InferenceKeyHelp.Text = provider == "openrouter" ? "Create a key in your OpenRouter workspace." : "Sign in to NVIDIA's API catalog, choose a model, and create an API key.";
        this.EndpointHelp.Text = provider == "local" ? "Use an already-running server at 127.0.0.1 or [::1]. Local inference is experimental." : "Use the provider's HTTPS API root. API keys belong in the protected field below.";
        this.UpdateSetupAction();
        this.ConfigurationErrorPanel.Visibility = Visibility.Collapsed;
    }

    private void UpdateSetupAction()
    {
        var localOpenClaw = this.SelectedAgent == "openclaw" && this.ProviderChoice.SelectedItem is ComboBoxItem { Tag: string provider }
            && NativeDownloadedModelSetup.IsModel(provider);
        this.InstallButton.Content = localOpenClaw ? "Set up for me" : this.packageInstalled ? "Save configuration" : "Install NemoClaw";
        this.LocalSetupSummary.Visibility = localOpenClaw ? Visibility.Visible : Visibility.Collapsed;
    }

    private void InstallClicked(object sender, RoutedEventArgs args)
    {
        try
        {
            if (this.LicenseCheck.IsChecked != true) return;
            if (this.ProviderChoice.SelectedItem is not ComboBoxItem { Tag: string provider }) throw new InvalidOperationException("Choose an inference provider.");
            var selectedLocalModel = NativeDownloadedModelSetup.IsModel(provider) ? provider : NativeExpressSetup.Id;
            var express = provider == "n1x" || NativeDownloadedModelSetup.IsModel(provider);
            if (express) provider = "local";
            Uri? endpoint = null;
            if (!express && (!Uri.TryCreate(this.EndpointBox.Text.Trim(), UriKind.Absolute, out endpoint) ||
                endpoint.UserInfo.Length != 0 || endpoint.Query.Length != 0 || endpoint.Fragment.Length != 0))
            {
                throw new InvalidOperationException("Enter a complete API endpoint without credentials, query parameters, or a fragment.");
            }
            var loopback = endpoint?.Host is "127.0.0.1" or "[::1]" or "::1";
            if (!express && ((provider == "local" && (!loopback || endpoint!.Scheme is not ("http" or "https"))) ||
                (provider != "local" && endpoint!.Scheme != "https")))
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
            var configuration = new NativeSetupConfiguration(this.SelectedAgent, provider, express ? null : endpoint!.AbsoluteUri.TrimEnd('/'), model, password.Length != 0) { Options = options, LocalModel = express ? selectedLocalModel : null };
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
    private void RetryClicked(object sender, RoutedEventArgs args) => this.RetryRequested?.Invoke(this, EventArgs.Empty);
    private void CopyErrorClicked(object sender, RoutedEventArgs args)
    {
        try { Clipboard.SetText(this.FailureDetail.Text); }
        catch (Exception) { this.RecoverableError.Text = "Windows could not copy the error. Open the setup log instead."; this.RecoverableError.Visibility = Visibility.Visible; }
    }
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
        this.progress.Report("cancelling");
        this.RenderProgress();
        this.ProgressDetail.Text = "Please keep this window open while Windows completes rollback.";
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
        this.ElapsedText.Text = $"Total elapsed {NativeProgressPresentation.Duration(this.progress.SessionElapsed)}";
        this.PhaseActivityText.Text = this.progress.ActivityText;
        this.PhaseActivityIndicator.Opacity = this.progress.ActivityOpacity;
        this.PhaseActivityPanel.Visibility = NativePreviewPresentation.DiagnosticsEnabled ? Visibility.Visible : Visibility.Collapsed;
    }
    private void StopElapsed()
    {
        this.elapsedTimer.Stop();
        this.PhaseActivityIndicator.Opacity = 1;
    }
}
