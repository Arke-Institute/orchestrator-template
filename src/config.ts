// ============================================================================
// CUSTOMIZE THESE FOR YOUR ORCHESTRATOR
// ============================================================================

/**
 * The sub-agent this orchestrator dispatches to.
 * Replace with your agent's ID after registration.
 */
export const SUB_AGENT_ID = 'YOUR_AGENT_ID_HERE';

/**
 * The sub-agent's endpoint URL (for status polling).
 * Replace with your agent's deployed endpoint.
 */
export const SUB_AGENT_ENDPOINT = 'https://your-agent.arke.institute';

/** Options that can be passed in input.options */
export interface OrchestratorOptions {
  max_retries?: number;
  concurrency?: number;

  // Discovery options
  // Filter entities by type during discovery (e.g., 'file' to only process files)
  // Useful when collection contains mixed entity types but you only want to process some
  discover_type?: string;

  // Add your orchestrator-specific options here
  // These get passed through to the sub-agent
}

/**
 * Default configuration
 *
 * TIMEOUT CONFIGURATION:
 * - poll_interval_ms: How often to check if sub-agent tasks have completed
 * - poll_timeout_ms: Maximum time to wait for EACH ENTITY's sub-agent task to complete
 *   This is PER ENTITY, not total. If you have 100 entities, each gets this timeout independently.
 *
 * For long-running agent tasks (e.g., LLM processing, large file operations),
 * increase poll_timeout_ms accordingly. A 10-minute task needs poll_timeout_ms > 600000.
 */
export const DEFAULT_CONFIG = {
  max_retries: 3,
  concurrency: 5,
  poll_interval_ms: 2000, // How often to poll sub-agent status (ms)
  poll_timeout_ms: 300000, // Max wait time PER ENTITY before timeout (5 minutes)
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
