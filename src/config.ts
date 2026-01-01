// ============================================================================
// CUSTOMIZE THESE FOR YOUR ORCHESTRATOR
// ============================================================================

/** The sub-agent this orchestrator dispatches to */
export const SUB_AGENT_ID = 'YOUR_SUB_AGENT_PI_HERE';

/** The sub-agent's endpoint URL (for status polling) */
export const SUB_AGENT_ENDPOINT = 'https://your-sub-agent.arke.institute';

/** Options that can be passed in input.options */
export interface OrchestratorOptions {
  max_retries?: number;
  concurrency?: number;
  // Add your orchestrator-specific options here
  // These get passed through to the sub-agent
}

/** Default configuration */
export const DEFAULT_CONFIG = {
  max_retries: 3,
  concurrency: 5,
  poll_interval_ms: 2000, // Poll every 2 seconds
  poll_timeout_ms: 300000, // 5 minutes timeout per entity
};

/**
 * Build the input to send to the sub-agent for each entity.
 * Override this if you need to transform options per-entity.
 */
export function buildSubAgentInput(
  entityId: string,
  options?: OrchestratorOptions
): Record<string, unknown> {
  return {
    entity_id: entityId,
    options: options,
  };
}
