/**
 * Shared registry to track active agent execution runs so they can be stopped.
 */

export const activeAgents = new Map<string, AbortController>();
export const agentSignals = new Map<string, AbortController>();
