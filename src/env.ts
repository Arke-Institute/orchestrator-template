import type { BaseAgentEnv } from '@arke-institute/agent-core';
import type { OrchestratorJob } from './orchestrator-job';

export interface OrchestratorEnv extends BaseAgentEnv {
  // Durable Object namespace for job management
  ORCHESTRATOR_JOBS: DurableObjectNamespace<OrchestratorJob>;
}
