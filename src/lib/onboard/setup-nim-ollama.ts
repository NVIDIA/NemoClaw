// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OllamaStartupOutcome } from "./ollama-startup";
import type { SetupNimSelectionState } from "./setup-nim-selection";

type SetupNimSelectionResult = "selected" | "retry-selection";

type SetupNimOllamaDeps = {
  OLLAMA_PORT: number;
  OLLAMA_PROXY_PORT: number;
  process: NodeJS.Process;
  isNonInteractive: () => boolean;
  prompt: (message: string) => Promise<string>;
  checkOllamaPortsOrWarn: (args: { isNonInteractive: () => boolean }) => boolean;
  ensureOllamaLoopbackSystemdOverride: (args: { isNonInteractive: () => boolean }) => string;
  runOllamaStartupOrGate: (args: {
    ollamaReady: boolean;
    ollamaPort: number;
    getLocalProviderBaseUrl: (provider: string) => string | null;
    isNonInteractive: () => boolean;
  }) => OllamaStartupOutcome;
  shouldFrontOllamaWithProxy: () => boolean;
  startOllamaAuthProxy: () => boolean;
  getLocalProviderBaseUrl: (provider: string) => string | null;
  selectAndValidateOllamaModel: (
    gpu: any,
    provider: string,
    args: { requestedModel: string | null; recoveredModel: string | null },
  ) => Promise<
    | { outcome: "back-to-selection" }
    | { outcome: "selected"; model: string; allowToolsIncompatible: boolean }
  >;
  printOllamaExposureWarning: () => void;
  switchToWindowsOllamaHost: () => void;
  installOllamaOnWindowsHost: () => Promise<{ ok: boolean; path?: string | null }>;
  awaitWindowsOllamaReady: () => boolean;
  setupWindowsOllamaWith0000Binding: (args: {
    announceStop?: boolean;
    installedPath?: string | null;
  }) => boolean;
  printWindowsOllamaTimeoutDiagnostics: () => void;
  resetOllamaHostCache: () => void;
  installOllamaOnMacOS: (args: { isNonInteractive: () => boolean; isUpgrade: boolean }) => {
    ok: boolean;
  };
  installOllamaOnLinux: (args: { isNonInteractive: () => boolean; isUpgrade: boolean }) => {
    ok: boolean;
  };
  abortNonInteractive: (message: string) => never;
  assertOllamaUpgradeApplied: (menu: {
    hasUpgradableOllama: boolean;
  }) => { ok: true } | { ok: false; message: string };
};

export function createSetupNimOllamaHandlers(deps: SetupNimOllamaDeps): {
  handleWindowsHostOllamaSelection: (
    gpu: any,
    selectedKey: string,
    requestedModel: string | null,
    windowsOllamaReachable: boolean,
    winOllamaLoopbackOnly: boolean,
    winOllamaInstalledPath: string | null,
    state: SetupNimSelectionState,
  ) => Promise<SetupNimSelectionResult>;
  handleRunningOllamaSelection: (
    gpu: any,
    requestedModel: string | null,
    recoveredModel: string | null,
    ollamaRunning: boolean,
    state: SetupNimSelectionState,
  ) => Promise<SetupNimSelectionResult>;
  handleInstallOllamaSelection: (
    gpu: any,
    requestedModel: string | null,
    recoveredModel: string | null,
    state: SetupNimSelectionState,
    ollamaInstallMenu: { hasUpgradableOllama: boolean },
  ) => Promise<SetupNimSelectionResult>;
} {
  async function selectModel(
    gpu: any,
    state: SetupNimSelectionState,
    requestedModel: string | null,
    recoveredModel: string | null,
  ): Promise<SetupNimSelectionResult> {
    const result = await deps.selectAndValidateOllamaModel(gpu, state.provider, {
      requestedModel,
      recoveredModel,
    });
    if (result.outcome === "back-to-selection") return "retry-selection";
    state.model = result.model;
    state.allowToolsIncompatible = result.allowToolsIncompatible;
    state.preferredInferenceApi = "openai-completions";
    return "selected";
  }

  function startProxyOrAnnounceDirect(): void {
    if (deps.shouldFrontOllamaWithProxy()) {
      if (!deps.startOllamaAuthProxy()) deps.process.exit(1);
      console.log(
        `  ✓ Using Ollama on localhost:${deps.OLLAMA_PORT} (proxy on :${deps.OLLAMA_PROXY_PORT})`,
      );
    } else {
      console.log(`  ✓ Using Ollama on localhost:${deps.OLLAMA_PORT}`);
    }
  }

  function configureOllamaState(state: SetupNimSelectionState): void {
    state.provider = "ollama-local";
    state.credentialEnv = null;
    state.endpointUrl = deps.getLocalProviderBaseUrl(state.provider);
    if (!state.endpointUrl) {
      console.error("  Local Ollama base URL could not be determined.");
      deps.process.exit(1);
    }
  }

  function applyOllamaFallbackState(
    state: SetupNimSelectionState,
    result: Extract<OllamaStartupOutcome, { kind: "fallback" }>["result"],
  ): void {
    state.provider = result.provider;
    state.credentialEnv = result.credentialEnv;
    state.endpointUrl = result.endpointUrl;
    state.model = result.model;
    state.preferredInferenceApi = result.preferredInferenceApi;
    state.nimContainer = null;
    state.allowToolsIncompatible = false;
  }

  async function handleWindowsHostOllamaSelection(
    gpu: any,
    selectedKey: string,
    requestedModel: string | null,
    windowsOllamaReachable: boolean,
    winOllamaLoopbackOnly: boolean,
    winOllamaInstalledPath: string | null,
    state: SetupNimSelectionState,
  ): Promise<SetupNimSelectionResult> {
    if (!deps.checkOllamaPortsOrWarn({ isNonInteractive: deps.isNonInteractive })) {
      return "retry-selection";
    }
    const isInstall = selectedKey === "install-windows-ollama";
    const isSwitch = !isInstall && windowsOllamaReachable;
    const isRestart = !isInstall && !isSwitch && winOllamaLoopbackOnly;
    if (!isSwitch) deps.printOllamaExposureWarning();
    const promptMsg = isInstall
      ? "  Install and launch Ollama on the Windows host with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: "
      : isSwitch
        ? "  Use Ollama on the Windows host (already running)? [Y/n]: "
        : isRestart
          ? "  Stop the running Ollama and restart it with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: "
          : "  Launch Ollama on the Windows host with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: ";
    const proceed = deps.isNonInteractive()
      ? true
      : !(await deps.prompt(promptMsg)).trim().toLowerCase().startsWith("n");
    if (!proceed) return "retry-selection";

    if (isSwitch) {
      deps.switchToWindowsOllamaHost();
    } else if (isInstall) {
      const installResult = await deps.installOllamaOnWindowsHost();
      if (!installResult.ok) {
        console.error(
          "  Install did not produce ollama.exe on PATH. Check the installer output above.",
        );
        if (deps.isNonInteractive()) deps.process.exit(1);
        return "retry-selection";
      }
      if (!deps.awaitWindowsOllamaReady()) {
        console.log("  Installer did not leave a reachable Ollama daemon; restarting it...");
        if (!deps.setupWindowsOllamaWith0000Binding({ installedPath: installResult.path })) {
          deps.printWindowsOllamaTimeoutDiagnostics();
          if (deps.isNonInteractive()) deps.process.exit(1);
          return "retry-selection";
        }
      }
      console.log(`  ✓ Using Ollama on host.docker.internal:${deps.OLLAMA_PORT}`);
    } else {
      if (
        !deps.setupWindowsOllamaWith0000Binding({
          announceStop: isRestart,
          installedPath: winOllamaInstalledPath || undefined,
        })
      ) {
        deps.printWindowsOllamaTimeoutDiagnostics();
        if (deps.isNonInteractive()) deps.process.exit(1);
        return "retry-selection";
      }
      console.log(`  ✓ Using Ollama on host.docker.internal:${deps.OLLAMA_PORT}`);
    }
    configureOllamaState(state);
    const result = await selectModel(gpu, state, requestedModel, null);
    if (result === "retry-selection") deps.resetOllamaHostCache();
    return result;
  }

  async function handleRunningOllamaSelection(
    gpu: any,
    requestedModel: string | null,
    recoveredModel: string | null,
    ollamaRunning: boolean,
    state: SetupNimSelectionState,
  ): Promise<SetupNimSelectionResult> {
    if (!deps.checkOllamaPortsOrWarn({ isNonInteractive: deps.isNonInteractive })) {
      return "retry-selection";
    }
    let ollamaReady = ollamaRunning;
    const overrideState = deps.ensureOllamaLoopbackSystemdOverride({
      isNonInteractive: deps.isNonInteractive,
    });
    if (overrideState === "ready") {
      ollamaReady = true;
    } else if (overrideState === "failed") {
      console.error(
        "  Ollama systemd restart did not recover after applying the loopback override.",
      );
      deps.process.exit(1);
    }
    const startup = deps.runOllamaStartupOrGate({
      ollamaReady,
      ollamaPort: deps.OLLAMA_PORT,
      getLocalProviderBaseUrl: deps.getLocalProviderBaseUrl,
      isNonInteractive: deps.isNonInteractive,
    });
    // Source boundary: ollama-startup owns this closed outcome contract. If a
    // stale package or test double presents an unknown kind, fail closed before
    // mutating provider state or starting proxy/model validation work.
    switch (startup.kind) {
      case "continue":
        return "retry-selection";
      case "fallback":
        // Fallback crosses a provider boundary, so write a complete safe state
        // rather than merging over stale cloud/NIM/Ollama selection fields.
        applyOllamaFallbackState(state, startup.result);
        return "selected";
      case "ready":
        startProxyOrAnnounceDirect();
        configureOllamaState(state);
        return selectModel(gpu, state, requestedModel, recoveredModel);
      default: {
        const kind = (startup as { kind?: unknown }).kind;
        console.error(`  Unknown Ollama startup outcome: ${String(kind)}`);
        deps.process.exit(1);
      }
    }
  }

  async function handleInstallOllamaSelection(
    gpu: any,
    requestedModel: string | null,
    recoveredModel: string | null,
    state: SetupNimSelectionState,
    ollamaInstallMenu: { hasUpgradableOllama: boolean },
  ): Promise<SetupNimSelectionResult> {
    if (!deps.checkOllamaPortsOrWarn({ isNonInteractive: deps.isNonInteractive })) {
      return "retry-selection";
    }
    const isUpgrade = ollamaInstallMenu.hasUpgradableOllama;
    const installResult =
      deps.process.platform === "darwin"
        ? deps.installOllamaOnMacOS({ isNonInteractive: deps.isNonInteractive, isUpgrade })
        : deps.installOllamaOnLinux({ isNonInteractive: deps.isNonInteractive, isUpgrade });
    if (!installResult.ok) {
      if (deps.isNonInteractive())
        deps.abortNonInteractive("Ollama install failed. See errors above.");
      return "retry-selection";
    }
    const upgradeCheck = deps.assertOllamaUpgradeApplied(ollamaInstallMenu);
    if (!upgradeCheck.ok) {
      console.error(`  ${upgradeCheck.message}`);
      if (deps.isNonInteractive()) deps.process.exit(1);
      return "retry-selection";
    }
    startProxyOrAnnounceDirect();
    configureOllamaState(state);
    return selectModel(gpu, state, requestedModel, recoveredModel);
  }

  return {
    handleWindowsHostOllamaSelection,
    handleRunningOllamaSelection,
    handleInstallOllamaSelection,
  };
}
