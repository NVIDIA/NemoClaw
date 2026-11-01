export function isActiveNativeAgent(agent: string): boolean {
  return agent === "openclaw" || agent === "hermes";
}

export function isNativeCleanupAgent(agent: string): boolean {
  return (
    isActiveNativeAgent(agent) ||
    agent === "langchain-deepagents-code" ||
    agent === "pi" ||
    agent === "nemocua"
  );
}
