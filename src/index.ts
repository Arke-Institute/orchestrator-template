/**
 * Orchestrator Template Entry Point
 *
 * Uses createAgentRouter from agent-core for standard endpoints.
 * All job processing is handled by the OrchestratorJob Durable Object.
 */

import { createAgentRouter } from '@arke-institute/agent-core';
import type { OrchestratorEnv } from './env';

// Create router with standard endpoints: /health, /process, /status/:job_id
const app = createAgentRouter<OrchestratorEnv>({
  doBindingName: 'ORCHESTRATOR_JOBS',
  healthData: (env) => ({
    type: 'orchestrator',
    description: 'Parallel entity processing orchestrator',
  }),
});

export default app;

// Export Durable Object class for wrangler
export { OrchestratorJob } from './orchestrator-job';
