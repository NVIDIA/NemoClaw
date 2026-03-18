import type { PluginLogger, NemoClawConfig } from "../index.js";
export interface OnboardOptions {
    apiKey?: string;
    endpoint?: string;
    ncpPartner?: string;
    endpointUrl?: string;
    model?: string;
    nonInteractive?: boolean;
    logger: PluginLogger;
    pluginConfig: NemoClawConfig;
}
export declare function cliOnboard(opts: OnboardOptions): Promise<void>;
//# sourceMappingURL=onboard.d.ts.map