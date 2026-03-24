export type EndpointType = "build" | "ncp" | "nim-local" | "vllm" | "ollama" | "custom";
export interface NemoClawOnboardConfig {
    endpointType: EndpointType;
    endpointUrl: string;
    ncpPartner: string | null;
    model: string;
    profile: string;
    credentialEnv: string;
    provider?: string;
    providerLabel?: string;
    onboardedAt: string;
}
export declare function describeOnboardEndpoint(config: NemoClawOnboardConfig): string;
export declare function describeOnboardProvider(config: NemoClawOnboardConfig): string;
export declare function loadOnboardConfig(): NemoClawOnboardConfig | null;
export declare function saveOnboardConfig(config: NemoClawOnboardConfig): void;
export declare function clearOnboardConfig(): void;
//# sourceMappingURL=config.d.ts.map