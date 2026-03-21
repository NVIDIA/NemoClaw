import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";
/** Human-readable policy summary lines injected into the agent context. */
interface RuntimeSummary {
    sandboxName: string;
    sandboxPhase: string | null;
    networkLines: string[];
    filesystemLines: string[];
}
/**
 * Returns a `RuntimeSummary` reflecting the current sandbox and policy state.
 *
 * Degrades gracefully when openshell is unavailable: returns deny-by-default
 * network lines and generic filesystem lines rather than throwing.
 */
export declare function getRuntimeSummary(pluginConfig: NemoClawConfig): Promise<RuntimeSummary>;
/**
 * Registers a `before_agent_start` hook that prepends a `<nemoclaw-runtime>`
 * context block (or a `<nemoclaw-runtime-update>` delta) to each agent turn.
 *
 * Falls back to a minimal static context block if openshell is unavailable or
 * any internal error occurs, and logs a warning via `api.logger`.
 */
export declare function registerRuntimeContext(api: OpenClawPluginApi, pluginConfig: NemoClawConfig): void;
export {};
//# sourceMappingURL=runtime-context.d.ts.map