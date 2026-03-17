import type { Command } from "commander";
/** Subset of OpenClawConfig that we actually read. */
export interface OpenClawConfig {
    [key: string]: unknown;
}
/** Logger provided by the plugin host. */
export interface PluginLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
}
/** Context passed to slash-command handlers. */
export interface PluginCommandContext {
    senderId?: string;
    channel: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    config: OpenClawConfig;
    from?: string;
    to?: string;
    accountId?: string;
}
/** Return value from a slash-command handler. */
export interface PluginCommandResult {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
}
/** Registration shape for a slash command. */
export interface PluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
}
/** Context passed to the CLI registrar callback. */
export interface PluginCliContext {
    program: Command;
    config: OpenClawConfig;
    workspaceDir?: string;
    logger: PluginLogger;
}
/** CLI registrar callback type. */
export type PluginCliRegistrar = (ctx: PluginCliContext) => void | Promise<void>;
/** Auth method for a provider plugin. */
export interface ProviderAuthMethod {
    type: string;
    envVar?: string;
    headerName?: string;
    label?: string;
}
/** Model entry in a provider's model catalog. */
export interface ModelProviderEntry {
    id: string;
    label: string;
    contextWindow?: number;
    maxOutput?: number;
}
/** Model catalog shape. */
export interface ModelProviderConfig {
    chat?: ModelProviderEntry[];
    completion?: ModelProviderEntry[];
}
/** Registration shape for a custom model provider. */
export interface ProviderPlugin {
    id: string;
    label: string;
    docsPath?: string;
    aliases?: string[];
    envVars?: string[];
    models?: ModelProviderConfig;
    auth: ProviderAuthMethod[];
}
/** Background service registration. */
export interface PluginService {
    id: string;
    start: (ctx: {
        config: OpenClawConfig;
        logger: PluginLogger;
    }) => void | Promise<void>;
    stop?: (ctx: {
        config: OpenClawConfig;
        logger: PluginLogger;
    }) => void | Promise<void>;
}
/**
 * The API object injected into the plugin's register function by the OpenClaw
 * host. Only the methods we actually call are listed here.
 */
export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    registerCommand: (command: PluginCommandDefinition) => void;
    registerCli: (registrar: PluginCliRegistrar, opts?: {
        commands?: string[];
    }) => void;
    registerProvider: (provider: ProviderPlugin) => void;
    registerService: (service: PluginService) => void;
    resolvePath: (input: string) => string;
    on: (hookName: string, handler: (...args: unknown[]) => void) => void;
}
export interface NemoClawConfig {
    blueprintVersion: string;
    blueprintRegistry: string;
    sandboxName: string;
    inferenceProvider: string;
}
export declare function getPluginConfig(api: OpenClawPluginApi): NemoClawConfig;
export default function register(api: OpenClawPluginApi): void;
//# sourceMappingURL=index.d.ts.map