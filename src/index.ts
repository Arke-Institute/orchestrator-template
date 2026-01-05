import { Hono } from 'hono';
import { ArkeClient } from '@arke-institute/sdk';
import type { Env } from './env';
import type {
  JobRequest,
  JobState,
  JobResponse,
  StatusResponse,
  EntityStatus,
} from './types';
import { verifyArkeSignature } from './verify';
import { getJobState, saveJobState, updateProgress } from './state';
import { JobLogger, writeJobLog } from './logger';
import { DEFAULT_CONFIG } from './config';
import {
  dispatchToSubAgent,
  pollSubAgentStatus,
  PromisePool,
} from './dispatcher';
import { discoverEntities } from './discovery';

const app = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /health
// =============================================================================

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    agent: c.env.AGENT_ID,
    version: c.env.AGENT_VERSION,
  });
});

// =============================================================================
// POST /process
// =============================================================================

app.post('/process', async (c) => {
  const env = c.env;

  // 1. Read raw body for signature verification
  const body = await c.req.text();
  const signatureHeader = c.req.header('X-Arke-Signature');
  const requestId = c.req.header('X-Arke-Request-Id');

  console.log(`[${env.AGENT_ID}] Received request ${requestId}`);

  // 2. Verify signature
  if (!signatureHeader) {
    return c.json<JobResponse>(
      { accepted: false, error: 'Missing signature header' },
      401
    );
  }

  let jobRequest: JobRequest;
  try {
    jobRequest = JSON.parse(body) as JobRequest;
  } catch {
    return c.json<JobResponse>(
      { accepted: false, error: 'Invalid JSON body' },
      400
    );
  }

  const verifyResult = await verifyArkeSignature(
    body,
    signatureHeader,
    jobRequest.api_base
  );
  if (!verifyResult.valid) {
    return c.json<JobResponse>(
      { accepted: false, error: verifyResult.error ?? 'Invalid signature' },
      401
    );
  }

  // 3. Validate required fields
  if (!jobRequest.job_id || !jobRequest.target || !jobRequest.job_collection) {
    return c.json<JobResponse>(
      { accepted: false, error: 'Missing required fields' },
      400
    );
  }

  // 4. Check API key configured (needed for discovery)
  if (!env.ARKE_API_KEY) {
    return c.json<JobResponse>(
      { accepted: false, error: 'Agent not configured', retry_after: 60 },
      503
    );
  }

  // 5. Determine entity IDs - use explicit list or discover from collection
  // Discovery is the default behavior when entity_ids is not provided.
  // Explicit entity_ids overrides discovery for processing a specific subset.
  // Note: For type filtering (e.g., only files), pass options.discover_type
  let entityIds = jobRequest.input?.entity_ids;

  if (!entityIds || entityIds.length === 0) {
    // Discovery mode: fetch all entities owned by the target collection
    console.log(`[${env.AGENT_ID}] Discovering entities in collection ${jobRequest.target}`);

    const client = new ArkeClient({
      baseUrl: jobRequest.api_base,
      authToken: env.ARKE_API_KEY,
      network: jobRequest.network,
    });

    try {
      entityIds = await discoverEntities(client, jobRequest.target, {
        // Optional type filter - useful for orchestrators that only process
        // specific entity types (e.g., type: 'file' to skip collections)
        type: jobRequest.input?.options?.discover_type,
      });
    } catch (err) {
      console.error(`[${env.AGENT_ID}] Discovery failed:`, err);
      return c.json<JobResponse>(
        { accepted: false, error: `Discovery failed: ${err instanceof Error ? err.message : 'Unknown error'}` },
        500
      );
    }

    if (entityIds.length === 0) {
      return c.json<JobResponse>(
        { accepted: false, error: 'No entities found in collection' },
        400
      );
    }

    console.log(`[${env.AGENT_ID}] Discovered ${entityIds.length} entities`);
  }

  // 6. Build config from defaults + options
  const options = jobRequest.input?.options ?? {};
  const config = {
    max_retries: options.max_retries ?? DEFAULT_CONFIG.max_retries,
    concurrency: options.concurrency ?? DEFAULT_CONFIG.concurrency,
    poll_interval_ms: DEFAULT_CONFIG.poll_interval_ms,
    poll_timeout_ms: DEFAULT_CONFIG.poll_timeout_ms,
  };

  // 7. Create initial job state with entity tracking
  const entities: Record<string, EntityStatus> = {};
  for (const entityId of entityIds) {
    entities[entityId] = {
      status: 'pending',
      attempts: 0,
    };
  }

  const jobState: JobState = {
    job_id: jobRequest.job_id,
    status: 'pending',
    target: jobRequest.target,
    job_collection: jobRequest.job_collection,
    api_base: jobRequest.api_base,
    expires_at: jobRequest.expires_at,
    network: jobRequest.network,
    options: jobRequest.input?.options,
    entities,
    progress: {
      total: entityIds.length,
      pending: entityIds.length,
      dispatched: 0,
      done: 0,
      error: 0,
    },
    config,
    started_at: new Date().toISOString(),
  };

  await saveJobState(env.JOBS, jobState);

  // 8. Start background processing
  c.executionCtx.waitUntil(
    processJob(env, jobState).catch((err) => {
      console.error(`[${env.AGENT_ID}] Background processing error:`, err);
    })
  );

  // 9. Return immediately
  return c.json<JobResponse>({ accepted: true, job_id: jobRequest.job_id });
});

// =============================================================================
// Background Processor
// =============================================================================

async function processJob(env: Env, state: JobState): Promise<void> {
  const logger = new JobLogger(env.AGENT_ID);
  const client = new ArkeClient({
    baseUrl: state.api_base,
    authToken: env.ARKE_API_KEY,
    network: state.network,
  });

  // Update state to running
  state.status = 'running';
  await saveJobState(env.JOBS, state);

  logger.info('Starting orchestration', {
    job_id: state.job_id,
    entity_count: Object.keys(state.entities).length,
    concurrency: state.config.concurrency,
    max_retries: state.config.max_retries,
  });

  // Process entities with concurrency limit
  const entityIds = Object.keys(state.entities);
  const pool = new PromisePool(state.config.concurrency);

  for (const entityId of entityIds) {
    await pool.add(async () => {
      await processEntity(env, client, state, entityId, logger);
    });
  }

  await pool.drain();

  // Calculate final result
  updateProgress(state);
  const succeeded = state.progress.done;
  const failed = state.progress.error;

  state.status = failed === entityIds.length ? 'error' : 'done';
  state.completed_at = new Date().toISOString();
  state.result = {
    total: entityIds.length,
    succeeded,
    failed,
    message:
      state.status === 'done'
        ? `Successfully processed ${succeeded}/${entityIds.length} entities`
        : `All ${entityIds.length} entities failed`,
  };

  if (state.status === 'error') {
    state.error = {
      code: 'ALL_FAILED',
      message: 'All entities failed processing',
    };
  }

  logger.info('Orchestration complete', {
    status: state.status,
    succeeded,
    failed,
    total: entityIds.length,
  });

  // Write log
  try {
    const entityResults: Record<
      string,
      {
        status: 'done' | 'error';
        sub_job_id?: string;
        result?: Record<string, unknown>;
        error?: string;
      }
    > = {};
    for (const [id, es] of Object.entries(state.entities)) {
      entityResults[id] = {
        status: es.status === 'done' ? 'done' : 'error',
        sub_job_id: es.sub_job_id,
        result: es.result,
        error: es.error,
      };
    }

    await writeJobLog(client, state.job_collection, {
      job_id: state.job_id,
      agent_id: env.AGENT_ID,
      agent_version: env.AGENT_VERSION,
      started_at: state.started_at,
      completed_at: state.completed_at!,
      status: state.status === 'done' ? 'done' : 'error',
      result: state.result,
      error: state.error,
      entity_results: entityResults,
      entries: logger.getEntries(),
    });
  } catch (err) {
    console.error(`[${env.AGENT_ID}] Failed to write log:`, err);
  }

  // Save final state
  await saveJobState(env.JOBS, state);
}

// =============================================================================
// Process Single Entity (with retries)
// =============================================================================

async function processEntity(
  env: Env,
  client: ArkeClient,
  state: JobState,
  entityId: string,
  logger: JobLogger
): Promise<void> {
  const entityState = state.entities[entityId];

  while (entityState.attempts < state.config.max_retries) {
    entityState.attempts++;
    entityState.status = 'dispatched';
    entityState.last_attempt_at = new Date().toISOString();
    updateProgress(state);
    await saveJobState(env.JOBS, state);

    logger.info(
      `Dispatching entity (attempt ${entityState.attempts}/${state.config.max_retries})`,
      {
        entityId,
      }
    );

    // Dispatch to sub-agent
    const dispatchResult = await dispatchToSubAgent(
      client,
      state.target,
      entityId,
      state.job_collection,
      state.options
    );

    if (!dispatchResult.success) {
      logger.warning('Dispatch failed', {
        entityId,
        attempt: entityState.attempts,
        error: dispatchResult.error,
      });
      entityState.error = dispatchResult.error;

      if (entityState.attempts >= state.config.max_retries) {
        break; // Exit retry loop
      }
      continue; // Retry
    }

    entityState.sub_job_id = dispatchResult.sub_job_id;
    entityState.status = 'polling';
    updateProgress(state);
    await saveJobState(env.JOBS, state);

    logger.info('Polling sub-agent status', {
      entityId,
      sub_job_id: dispatchResult.sub_job_id,
    });

    // Poll for completion
    const pollResult = await pollSubAgentStatus(
      dispatchResult.sub_job_id!,
      state.config.poll_interval_ms,
      state.config.poll_timeout_ms
    );

    if (pollResult.status === 'done') {
      entityState.status = 'done';
      entityState.result = pollResult.result;
      entityState.error = undefined;
      updateProgress(state);
      await saveJobState(env.JOBS, state);

      logger.success('Entity completed', { entityId });
      return; // Success, exit function
    }

    // Error or timeout
    entityState.error = pollResult.error;
    logger.warning('Sub-agent returned error or timeout', {
      entityId,
      attempt: entityState.attempts,
      error: pollResult.error,
    });

    if (entityState.attempts >= state.config.max_retries) {
      break; // Exit retry loop
    }
    // Otherwise continue to retry
  }

  // Exhausted retries
  entityState.status = 'error';
  updateProgress(state);
  await saveJobState(env.JOBS, state);

  logger.error(`Entity failed after ${state.config.max_retries} attempts`, {
    entityId,
    lastError: entityState.error,
  });
}

// =============================================================================
// GET /status/:job_id
// =============================================================================

app.get('/status/:job_id', async (c) => {
  const jobId = c.req.param('job_id');
  const state = await getJobState(c.env.JOBS, jobId);

  if (!state) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return c.json<StatusResponse>({
    job_id: state.job_id,
    status: state.status,
    progress: state.progress,
    result: state.result,
    error: state.error,
    started_at: state.started_at,
    completed_at: state.completed_at,
  });
});

// =============================================================================
// Fallback
// =============================================================================

app.all('*', (c) => {
  return c.json(
    {
      error: 'Not found',
      endpoints: {
        health: 'GET /health',
        process: 'POST /process',
        status: 'GET /status/:job_id',
      },
    },
    404
  );
});

export default app;
