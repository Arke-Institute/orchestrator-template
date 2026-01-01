export interface Env {
  // KV for job state
  JOBS: KVNamespace;

  // Agent configuration
  ARKE_API_KEY: string; // Secret: orchestrator's API key
  ARKE_API_BASE: string; // Default: https://arke-v1.arke.institute

  // Agent identity (for logging)
  AGENT_ID: string; // e.g., "description-orchestrator"
  AGENT_VERSION: string; // e.g., "1.0.0"
}
