# Orchestrator Template - Implementation Plan

This template provides the base structure for orchestrator agents that dispatch work to sub-agents. Fork this to create orchestrators like `description-orchestrator`, `ocr-orchestrator`, etc.

## Overview

An orchestrator:
- Receives a job from Arke with multiple `entity_ids`
- Dispatches each entity to a sub-agent via Arke API
- Polls sub-agent status and tracks per-entity progress
- Handles retries for failed entities
- Reports aggregate status via polling endpoint
- Writes summary log to the log file entity

## Key Difference from Agent Template

| Aspect | Agent | Orchestrator |
|--------|-------|--------------|
| Input | `{ entity_id }` | `{ entity_ids: [...] }` |
| State | Single entity status | Per-entity tracking map |
| Processing | Direct task execution | Dispatch to sub-agent via Arke API |
| Concurrency | N/A | Configurable parallel dispatches |
| Retries | N/A (orchestrator handles) | Yes, configurable max_retries |

## Registration

When registering an orchestrator, declare the sub-agent it uses:

```typescript
// POST /agents
{
  label: "Description Orchestrator",
  endpoint: "https://description-orchestrator.arke.institute",
  actions_required: ["entity:view"],  // Orchestrator only needs to read
  uses_agents: [
    {
      pi: "01DESCRIPTION_AGENT_ID",
      actions_required: ["entity:view", "entity:update"]
    }
  ],
  collection: "01AGENT_HOME_COLLECTION"
}
```

When invoked, Arke pre-grants permissions to BOTH the orchestrator AND all declared sub-agents.

## Directory Structure

```
orchestrator-template/
├── package.json
├── wrangler.jsonc
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts                 # Hono app entry point
    ├── env.ts                   # Environment type definition
    ├── types.ts                 # Job types
    ├── verify.ts                # Ed25519 signature verification (same as agent)
    ├── state.ts                 # KV state management
    ├── logger.ts                # Job logger (same as agent)
    ├── dispatcher.ts            # Sub-agent dispatch + polling logic
    └── config.ts                # CONFIGURATION - customize when forking
```

---

## File Specifications

### `env.ts` - Environment Bindings

```typescript
export interface Env {
  // KV for job state
  JOBS: KVNamespace;

  // Agent configuration
  ARKE_API_KEY: string;      // Secret: orchestrator's API key
  ARKE_API_BASE: string;     // Default: https://arke-v1.arke.institute

  // Agent identity (for logging)
  AGENT_ID: string;          // e.g., "description-orchestrator"
  AGENT_VERSION: string;     // e.g., "1.0.0"
}
```

---

### `types.ts` - Orchestrator Job Types

```typescript
import type { OrchestratorOptions } from './config';

// What Arke sends us
export interface JobRequest {
  job_id: string;
  target: string;
  log: { pi: string; type: 'file' };
  input: {
    entity_ids: string[];
    options?: OrchestratorOptions;
  };
  api_base: string;
  expires_at: string;
}

// Per-entity tracking
export interface EntityStatus {
  status: 'pending' | 'dispatched' | 'polling' | 'done' | 'error';
  sub_job_id?: string;         // Job ID from sub-agent
  attempts: number;
  last_attempt_at?: string;
  error?: string;
  result?: Record<string, unknown>;
}

// Aggregate progress
export interface JobProgress {
  total: number;
  pending: number;
  dispatched: number;
  done: number;
  error: number;
}

// What we store in KV
export interface JobState {
  job_id: string;
  status: 'pending' | 'running' | 'done' | 'error';

  target: string;
  log_pi: string;
  api_base: string;
  expires_at: string;
  options?: OrchestratorOptions;

  // Per-entity tracking
  entities: Record<string, EntityStatus>;

  // Aggregate progress
  progress: JobProgress;

  // Runtime config (from input.options merged with defaults)
  config: {
    max_retries: number;
    concurrency: number;
    poll_interval_ms: number;
    poll_timeout_ms: number;
  };

  started_at: string;
  completed_at?: string;

  // Final result
  result?: {
    total: number;
    succeeded: number;
    failed: number;
    message: string;
  };
  error?: { code: string; message: string };
}

// What we return on POST /process
export interface JobAcceptResponse {
  accepted: true;
  job_id: string;
}

export interface JobRejectResponse {
  accepted: false;
  error: string;
  retry_after?: number;
}

export type JobResponse = JobAcceptResponse | JobRejectResponse;

// What we return on GET /status/:job_id
export interface StatusResponse {
  job_id: string;
  status: JobState['status'];
  progress: JobProgress;
  result?: JobState['result'];
  error?: JobState['error'];
  started_at: string;
  completed_at?: string;
}

// Signature verification types (same as agent template)
export interface SigningKeyInfo {
  public_key: string;
  algorithm: string;
  key_id: string;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
}
```

---

### `verify.ts` - Signature Verification

Same as agent template - copy verbatim.

---

### `state.ts` - KV State Management

```typescript
import type { JobState, JobProgress } from './types';

const KV_TTL = 86400; // 24 hours

export async function getJobState(kv: KVNamespace, jobId: string): Promise<JobState | null> {
  const data = await kv.get(`job:${jobId}`, 'json');
  return data as JobState | null;
}

export async function saveJobState(kv: KVNamespace, state: JobState): Promise<void> {
  await kv.put(`job:${state.job_id}`, JSON.stringify(state), {
    expirationTtl: KV_TTL,
  });
}

// Recalculate progress from entity statuses
export function updateProgress(state: JobState): void {
  const entities = Object.values(state.entities);
  state.progress = {
    total: entities.length,
    pending: entities.filter(e => e.status === 'pending').length,
    dispatched: entities.filter(e => e.status === 'dispatched' || e.status === 'polling').length,
    done: entities.filter(e => e.status === 'done').length,
    error: entities.filter(e => e.status === 'error').length,
  };
}
```

---

### `logger.ts` - Job Logger

Same as agent template, but the log structure includes aggregate results:

```typescript
export async function writeJobLog(
  client: ArkeClient,
  logPi: string,
  log: {
    job_id: string;
    agent_id: string;
    agent_version: string;
    started_at: string;
    completed_at: string;
    status: 'done' | 'error';
    result?: {
      total: number;
      succeeded: number;
      failed: number;
      message: string;
    };
    error?: { code: string; message: string };
    entity_results: Record<string, {
      status: 'done' | 'error';
      sub_job_id?: string;
      result?: Record<string, unknown>;
      error?: string;
    }>;
    entries: LogEntry[];
  }
): Promise<void>;
```

---

### `config.ts` - CONFIGURATION POINT

This is the primary file you modify when forking the template.

```typescript
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
  poll_interval_ms: 2000,      // Poll every 2 seconds
  poll_timeout_ms: 300000,     // 5 minutes timeout per entity
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
```

---

### `dispatcher.ts` - Sub-Agent Dispatch Logic

```typescript
import { ArkeClient } from '@arke-institute/sdk';
import { SUB_AGENT_ID, SUB_AGENT_ENDPOINT, buildSubAgentInput } from './config';

// ============================================================================
// Dispatch
// ============================================================================

export interface DispatchResult {
  success: boolean;
  sub_job_id?: string;
  error?: string;
}

/**
 * Dispatch a single entity to the sub-agent via Arke API
 */
export async function dispatchToSubAgent(
  client: ArkeClient,
  target: string,
  entityId: string,
  options?: Record<string, unknown>
): Promise<DispatchResult> {
  try {
    const { data, error } = await client.api.POST('/agents/{id}/invoke', {
      params: { path: { id: SUB_AGENT_ID } },
      body: {
        target,
        input: buildSubAgentInput(entityId, options),
        confirm: true,
      },
    });

    if (error) {
      return { success: false, error: JSON.stringify(error) };
    }

    // Type narrowing for union response
    if ('error' in data && data.status === 'rejected') {
      return { success: false, error: data.error };
    }

    if ('job_id' in data && data.status === 'started') {
      return { success: true, sub_job_id: data.job_id };
    }

    return { success: false, error: 'Unexpected response from Arke' };

  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Dispatch failed',
    };
  }
}

// ============================================================================
// Polling
// ============================================================================

export interface PollResult {
  done: boolean;
  status: 'running' | 'done' | 'error';
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Poll sub-agent status endpoint until done/error or timeout
 */
export async function pollSubAgentStatus(
  subJobId: string,
  pollIntervalMs: number,
  timeoutMs: number
): Promise<PollResult> {
  const startTime = Date.now();
  const statusUrl = `${SUB_AGENT_ENDPOINT}/status/${subJobId}`;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(statusUrl);

      if (res.ok) {
        const data = await res.json() as {
          status: string;
          result?: Record<string, unknown>;
          error?: { code: string; message: string };
        };

        if (data.status === 'done') {
          return { done: true, status: 'done', result: data.result };
        }

        if (data.status === 'error') {
          return { done: true, status: 'error', error: data.error?.message ?? 'Unknown error' };
        }

        // Still pending or running, continue polling
      }
    } catch {
      // Network error, continue polling
    }

    await sleep(pollIntervalMs);
  }

  // Timeout
  return { done: false, status: 'error', error: 'Polling timeout exceeded' };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Concurrency Pool
// ============================================================================

/**
 * Simple promise pool for limiting concurrency
 */
export class PromisePool {
  private running = 0;
  private queue: Array<() => Promise<void>> = [];

  constructor(private concurrency: number) {}

  async add(fn: () => Promise<void>): Promise<void> {
    if (this.running >= this.concurrency) {
      // Wait for a slot
      await new Promise<void>(resolve => {
        this.queue.push(async () => {
          await fn();
          resolve();
        });
      });
    } else {
      this.running++;
      try {
        await fn();
      } finally {
        this.running--;
        this.runNext();
      }
    }
  }

  private runNext(): void {
    if (this.queue.length > 0 && this.running < this.concurrency) {
      const next = this.queue.shift()!;
      this.running++;
      next().finally(() => {
        this.running--;
        this.runNext();
      });
    }
  }

  async drain(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await sleep(100);
    }
  }
}
```

---

### `index.ts` - Main Entry Point

```typescript
import { Hono } from 'hono';
import { ArkeClient } from '@arke-institute/sdk';
import type { Env } from './env';
import type { JobRequest, JobState, JobResponse, StatusResponse, EntityStatus } from './types';
import { verifyArkeSignature } from './verify';
import { getJobState, saveJobState, updateProgress } from './state';
import { JobLogger, writeJobLog } from './logger';
import { DEFAULT_CONFIG, type OrchestratorOptions } from './config';
import { dispatchToSubAgent, pollSubAgentStatus, PromisePool } from './dispatcher';

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
    return c.json<JobResponse>({ accepted: false, error: 'Missing signature header' }, 401);
  }

  let jobRequest: JobRequest;
  try {
    jobRequest = JSON.parse(body) as JobRequest;
  } catch {
    return c.json<JobResponse>({ accepted: false, error: 'Invalid JSON body' }, 400);
  }

  const verifyResult = await verifyArkeSignature(body, signatureHeader, jobRequest.api_base);
  if (!verifyResult.valid) {
    return c.json<JobResponse>({ accepted: false, error: verifyResult.error ?? 'Invalid signature' }, 401);
  }

  // 3. Validate required fields
  if (!jobRequest.job_id || !jobRequest.target || !jobRequest.log) {
    return c.json<JobResponse>({ accepted: false, error: 'Missing required fields' }, 400);
  }

  const entityIds = jobRequest.input?.entity_ids;
  if (!entityIds || entityIds.length === 0) {
    return c.json<JobResponse>({ accepted: false, error: 'Missing or empty entity_ids in input' }, 400);
  }

  // 4. Check API key configured
  if (!env.ARKE_API_KEY) {
    return c.json<JobResponse>({ accepted: false, error: 'Agent not configured', retry_after: 60 }, 503);
  }

  // 5. Build config from defaults + options
  const options = jobRequest.input.options ?? {};
  const config = {
    max_retries: options.max_retries ?? DEFAULT_CONFIG.max_retries,
    concurrency: options.concurrency ?? DEFAULT_CONFIG.concurrency,
    poll_interval_ms: DEFAULT_CONFIG.poll_interval_ms,
    poll_timeout_ms: DEFAULT_CONFIG.poll_timeout_ms,
  };

  // 6. Create initial job state with entity tracking
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
    log_pi: jobRequest.log.pi,
    api_base: jobRequest.api_base,
    expires_at: jobRequest.expires_at,
    options: jobRequest.input.options,
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

  // 7. Start background processing
  c.executionCtx.waitUntil(
    processJob(env, jobState).catch((err) => {
      console.error(`[${env.AGENT_ID}] Background processing error:`, err);
    })
  );

  // 8. Return immediately
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
    message: state.status === 'done'
      ? `Successfully processed ${succeeded}/${entityIds.length} entities`
      : `All ${entityIds.length} entities failed`,
  };

  if (state.status === 'error') {
    state.error = { code: 'ALL_FAILED', message: 'All entities failed processing' };
  }

  logger.info('Orchestration complete', {
    status: state.status,
    succeeded,
    failed,
    total: entityIds.length,
  });

  // Write log
  try {
    const entityResults: Record<string, { status: 'done' | 'error'; sub_job_id?: string; result?: Record<string, unknown>; error?: string }> = {};
    for (const [id, es] of Object.entries(state.entities)) {
      entityResults[id] = {
        status: es.status === 'done' ? 'done' : 'error',
        sub_job_id: es.sub_job_id,
        result: es.result,
        error: es.error,
      };
    }

    await writeJobLog(client, state.log_pi, {
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

    logger.info(`Dispatching entity (attempt ${entityState.attempts}/${state.config.max_retries})`, {
      entityId,
    });

    // Dispatch to sub-agent
    const dispatchResult = await dispatchToSubAgent(
      client,
      state.target,
      entityId,
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
  return c.json({
    error: 'Not found',
    endpoints: {
      health: 'GET /health',
      process: 'POST /process',
      status: 'GET /status/:job_id',
    },
  }, 404);
});

export default app;
```

---

## Configuration Files

### `package.json`

```json
{
  "name": "arke-orchestrator-template",
  "version": "1.0.0",
  "description": "Template for Arke orchestrator agents - fork this to create orchestrators",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "@arke-institute/sdk": "^2.1.0",
    "@noble/ed25519": "^2.2.3",
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241205.0",
    "typescript": "^5.3.0",
    "wrangler": "^4.0.0"
  }
}
```

### `wrangler.jsonc`

```jsonc
{
  // ============================================================================
  // TEMPLATE: Fork this for your orchestrator
  // 1. Change "name" to your orchestrator name (e.g., "arke-description-orchestrator")
  // 2. Update the custom domain pattern
  // 3. Create a new KV namespace: wrangler kv:namespace create JOBS
  // 4. Update the KV namespace ID below
  // 5. Set secrets: wrangler secret put ARKE_API_KEY
  // ============================================================================

  "name": "arke-orchestrator-template",
  "main": "src/index.ts",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],

  "routes": [
    { "pattern": "orchestrator-template.arke.institute", "custom_domain": true }
  ],

  "workers_dev": true,

  "kv_namespaces": [
    {
      "binding": "JOBS",
      "id": "YOUR_KV_NAMESPACE_ID"
    }
  ],

  "vars": {
    "ARKE_API_BASE": "https://arke-v1.arke.institute",
    "AGENT_ID": "orchestrator-template",
    "AGENT_VERSION": "1.0.0"
  }

  // Secrets (set via wrangler secret put):
  // - ARKE_API_KEY: Orchestrator's API key for calling Arke API
}
```

### `tsconfig.json`

Same as agent template.

---

## Agent Registration in Arke

Deploying the worker is only half the story. You also need to register the orchestrator entity in Arke so it can be invoked.

### Directory Structure (Updated)

```
orchestrator-template/
├── package.json
├── wrangler.jsonc
├── tsconfig.json
├── agent.json                   # Agent manifest for registration
├── scripts/
│   └── register.ts              # Registration script
├── .agent-id                    # Stored agent PI (created after first registration)
└── src/
    └── ...
```

### `agent.json` - Orchestrator Manifest

This file defines how the orchestrator should be registered in Arke:

```json
{
  "label": "Orchestrator Template",
  "description": "Template orchestrator - customize this description",
  "endpoint": "https://orchestrator-template.arke.institute",
  "actions_required": ["entity:view"],
  "uses_agents": [
    {
      "pi": "01SUB_AGENT_PI_HERE",
      "label": "Sub-Agent Name",
      "actions_required": ["entity:view", "entity:update"]
    }
  ],
  "input_schema": {
    "type": "object",
    "properties": {
      "entity_ids": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Entities to process"
      },
      "options": {
        "type": "object",
        "properties": {
          "concurrency": { "type": "number", "description": "Max parallel sub-agents" },
          "max_retries": { "type": "number", "description": "Retries per entity" }
        }
      }
    },
    "required": ["entity_ids"]
  }
}
```

**Important**: The `uses_agents` field tells Arke to pre-grant permissions to the sub-agent when the orchestrator is invoked. The sub-agent PI must match what's in `config.ts`.

### Registration via arke-cli

The simplest way to register orchestrators is using `@arke-institute/cli`. First, authenticate:

```bash
# Option 1: Store API key (persists across sessions)
arke auth set-api-key uk_your_api_key

# Option 2: Use environment variable (one-time)
export ARKE_API_KEY=uk_your_api_key

# Check auth status
arke auth status
```

### `scripts/register.sh` - Registration Script

A shell script that reads `agent.json` (including `uses_agents`) and calls the CLI:

```bash
#!/bin/bash
set -e

# Read agent.json
LABEL=$(jq -r '.label' agent.json)
DESCRIPTION=$(jq -r '.description' agent.json)
ENDPOINT=$(jq -r '.endpoint' agent.json)
ACTIONS=$(jq -c '.actions_required' agent.json)
USES_AGENTS=$(jq -c '.uses_agents // empty' agent.json)
INPUT_SCHEMA=$(jq -c '.input_schema // empty' agent.json)
COLLECTION=${AGENT_HOME_COLLECTION:-"01AGENT_HOME_COLLECTION"}

# Check if orchestrator already registered
if [ -f .agent-id ]; then
  AGENT_ID=$(cat .agent-id)
  echo "Updating existing orchestrator: $AGENT_ID"

  # Get current CID for CAS
  CID=$(arke agents get "$AGENT_ID" --json | jq -r '.cid')

  # Build update command
  CMD="arke agents update $AGENT_ID --expect_tip $CID --label \"$LABEL\" --description \"$DESCRIPTION\" --endpoint \"$ENDPOINT\""

  if [ -n "$USES_AGENTS" ] && [ "$USES_AGENTS" != "null" ]; then
    CMD="$CMD --uses_agents '$USES_AGENTS'"
  fi

  eval "$CMD --json"
  echo "Orchestrator updated: $AGENT_ID"
else
  echo "Creating new orchestrator..."

  # Build create command
  CMD="arke agents create --label \"$LABEL\" --description \"$DESCRIPTION\" --endpoint \"$ENDPOINT\" --actions_required '$ACTIONS' --collection \"$COLLECTION\""

  if [ -n "$USES_AGENTS" ] && [ "$USES_AGENTS" != "null" ]; then
    CMD="$CMD --uses_agents '$USES_AGENTS'"
  fi

  RESULT=$(eval "$CMD --json")

  AGENT_ID=$(echo "$RESULT" | jq -r '.id')
  echo "$AGENT_ID" > .agent-id
  echo "Orchestrator created: $AGENT_ID"

  # Activate orchestrator
  CID=$(echo "$RESULT" | jq -r '.cid')
  arke agents update "$AGENT_ID" \
    --expect_tip "$CID" \
    --status active \
    --json
  echo "Orchestrator activated"

  # Create API key
  echo ""
  echo "Creating API key..."
  arke agents create-keys "$AGENT_ID" --label "Production" --json
  echo ""
  echo "=========================================="
  echo "SAVE THE API KEY ABOVE!"
  echo "Set it with: wrangler secret put ARKE_API_KEY"
  echo "=========================================="
fi
```

### Updated `package.json` Scripts

```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "deploy:worker": "wrangler deploy",
    "register": "./scripts/register.sh",
    "deploy:full": "npm run deploy:worker && npm run register",
    "type-check": "tsc --noEmit"
  }
}
```

### Manual Registration (Alternative)

```bash
# 1. Authenticate
arke auth set-api-key uk_your_api_key

# 2. Create orchestrator with uses_agents
arke agents create \
  --label "Description Orchestrator" \
  --endpoint "https://description-orchestrator.arke.institute" \
  --actions_required '["entity:view"]' \
  --uses_agents '[{"pi":"01SUB_AGENT_PI","actions_required":["entity:view","entity:update"]}]' \
  --collection "01AGENT_HOME_COLLECTION" \
  --json

# 3. Save the returned ID to .agent-id
echo "01RETURNED_ORCH_ID" > .agent-id

# 4. Activate
arke agents update 01ORCH_PI --status active --expect_tip bafyrei... --json

# 5. Create API key
arke agents create-keys 01ORCH_PI --label "Production"

# 6. Set secret
wrangler secret put ARKE_API_KEY
```

### Shared Agent Home Collection

All agents (including orchestrators) are registered in a shared "Agent Home" collection:
- **Owner**: ARCHON (system admin)
- **Public permissions**: `agent:view`, `agent:invoke` (anyone can invoke)
- **Create permission**: Configurable

See agent-template/PLAN.md for bootstrap script.

---

## How to Fork This Template

1. Copy the `orchestrator-template` folder to a new folder (e.g., `description-orchestrator`)
2. Update `wrangler.jsonc`:
   - Change `name` to your orchestrator name
   - Update the domain pattern
   - Create KV namespace: `wrangler kv:namespace create JOBS`
   - Update the KV namespace ID
   - Update `AGENT_ID` var
3. Update `package.json` name
4. Update `config.ts`:
   - Set `SUB_AGENT_ID` to the PI of your sub-agent
   - Set `SUB_AGENT_ENDPOINT` to the sub-agent's URL
   - Customize `OrchestratorOptions` if needed
   - Adjust `DEFAULT_CONFIG` if needed
5. Update `agent.json`:
   - Set `label` and `description`
   - Set `endpoint` to your domain
   - Update `uses_agents` with your sub-agent PI and required actions
   - Add `input_schema` describing your input format
6. Deploy and register:
   ```bash
   npm run deploy:full
   ```
   This will:
   - Deploy worker to Cloudflare
   - Register orchestrator in Arke (or update if exists)
   - Create API key if needed (you'll need to set it as secret)
7. Set the API key secret:
   ```bash
   wrangler secret put ARKE_API_KEY
   # Paste the key from registration output
   ```

---

## Workflow Example

### 1. Create Sub-Agent (e.g., description-agent)

```bash
# Fork and deploy agent-template
cp -r agents/agent-template agents/description-agent
# ... customize and deploy ...
```

Register in Arke:
```typescript
POST /agents
{
  label: "Description Agent",
  endpoint: "https://description-agent.arke.institute",
  actions_required: ["entity:view", "entity:update"],
  collection: "01AGENT_HOME"
}
// Returns: { id: "01DESCRIPTION_AGENT_XYZ", ... }
```

### 2. Create Orchestrator

```bash
# Fork and deploy orchestrator-template
cp -r agents/orchestrator-template agents/description-orchestrator
# Update config.ts with SUB_AGENT_ID = "01DESCRIPTION_AGENT_XYZ"
# ... deploy ...
```

Register in Arke:
```typescript
POST /agents
{
  label: "Description Orchestrator",
  endpoint: "https://description-orchestrator.arke.institute",
  actions_required: ["entity:view"],
  uses_agents: [
    { pi: "01DESCRIPTION_AGENT_XYZ", actions_required: ["entity:view", "entity:update"] }
  ],
  collection: "01AGENT_HOME"
}
```

### 3. User Invokes Orchestrator

```typescript
POST /agents/01ORCHESTRATOR_ID/invoke
{
  target: "01MY_COLLECTION",
  input: {
    entity_ids: ["01ENTITY_A", "01ENTITY_B", "01ENTITY_C"],
    options: { concurrency: 3 }
  },
  confirm: true
}
```

Arke:
1. Grants permissions to BOTH orchestrator AND description-agent
2. Calls orchestrator's `/process` endpoint

Orchestrator:
1. For each entity, calls `POST /agents/01DESCRIPTION_AGENT_XYZ/invoke`
2. Arke dispatches to description-agent (permissions already granted)
3. Orchestrator polls description-agent status
4. Aggregates results
5. Reports final status
