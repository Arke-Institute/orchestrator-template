/**
 * Orchestrator Durable Object
 *
 * Manages parallel entity processing with alarm-based state machine.
 * Extends BaseAgentDO from agent-core.
 */

import { ArkeClient } from '@arke-institute/sdk';
import {
  BaseAgentDO,
  BaseJobState,
  AlarmState,
  StartRequest,
  JobResponse,
  BaseStatusResponse,
  JobProgress,
  BaseWorkItemState,
  dispatchToAgent,
  pollAgentStatus,
  writeJobLog,
  JobLogger,
} from '@arke-institute/agent-core';
import type { OrchestratorEnv } from './env';
import {
  SUB_AGENT_ID,
  SUB_AGENT_ENDPOINT,
  DEFAULT_CONFIG,
  buildSubAgentInput,
  type OrchestratorOptions,
} from './config';
import { discoverEntities } from './discovery';

// =============================================================================
// Types
// =============================================================================

export interface EntityStatus extends BaseWorkItemState {
  sub_job_id?: string;
  poll_start_time?: number;
}

export interface OrchestratorJobState extends BaseJobState {
  entities: Record<string, EntityStatus>;
  options?: OrchestratorOptions;
  config: {
    max_retries: number;
    concurrency: number;
    poll_interval_ms: number;
    poll_timeout_ms: number;
  };
}

export interface OrchestratorInput {
  entity_ids?: string[];
  options?: OrchestratorOptions;
}

interface OrchestratorAlarmState extends AlarmState {
  // Track which entities are currently being processed
  active_entities: string[];
}

// =============================================================================
// Orchestrator Durable Object
// =============================================================================

export class OrchestratorJob extends BaseAgentDO<
  OrchestratorJobState,
  OrchestratorEnv,
  OrchestratorInput
> {
  // ===========================================================================
  // Handle Start
  // ===========================================================================

  protected async handleStart(
    request: StartRequest<OrchestratorInput>
  ): Promise<JobResponse> {
    // Check if job already exists
    const existing = await this.getState();
    if (existing) {
      console.log(
        `[${this.env.AGENT_ID}] Job ${request.job_id} already exists, returning current status`
      );
      return { accepted: true, job_id: request.job_id };
    }

    const logger = this.getLogger();
    logger.info('Initializing orchestrator job', { job_id: request.job_id });

    // Determine entity IDs - use explicit list or discover
    let entityIds = request.input?.entity_ids;

    if (!entityIds || entityIds.length === 0) {
      // Discovery mode
      logger.info('Discovering entities in collection', {
        target: request.target,
      });

      const client = new ArkeClient({
        baseUrl: request.api_base,
        authToken: this.env.ARKE_API_KEY,
        network: request.network,
      });

      try {
        entityIds = await discoverEntities(client, request.target, {
          type: request.input?.options?.discover_type,
        });
      } catch (err) {
        const error =
          err instanceof Error ? err.message : 'Discovery failed';
        logger.error('Discovery failed', { error });
        return { accepted: false, error: `Discovery failed: ${error}` };
      }

      if (entityIds.length === 0) {
        return { accepted: false, error: 'No entities found in collection' };
      }

      logger.info('Discovery complete', { entity_count: entityIds.length });
    }

    // Build config
    const options = request.input?.options ?? {};
    const config = {
      max_retries: options.max_retries ?? DEFAULT_CONFIG.max_retries,
      concurrency: options.concurrency ?? DEFAULT_CONFIG.concurrency,
      poll_interval_ms: DEFAULT_CONFIG.poll_interval_ms,
      poll_timeout_ms: DEFAULT_CONFIG.poll_timeout_ms,
    };

    // Build entity status map
    const entities: Record<string, EntityStatus> = {};
    for (const entityId of entityIds) {
      entities[entityId] = {
        status: 'pending',
        attempts: 0,
      };
    }

    // Create initial state
    const state: OrchestratorJobState = {
      job_id: request.job_id,
      status: 'pending',
      target: request.target,
      job_collection: request.job_collection,
      api_base: request.api_base,
      expires_at: request.expires_at,
      network: request.network,
      options: request.input?.options,
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

    await this.saveState(state);

    // Initialize alarm state
    const alarmState: OrchestratorAlarmState = {
      phase: 'dispatch',
      active_entities: [],
    };
    await this.saveAlarmState(alarmState);

    // Schedule first alarm
    await this.scheduleImmediateAlarm();

    logger.info('Orchestrator job started', {
      entity_count: entityIds.length,
      concurrency: config.concurrency,
    });

    return { accepted: true, job_id: request.job_id };
  }

  // ===========================================================================
  // Process Alarm
  // ===========================================================================

  protected async processAlarm(
    state: OrchestratorJobState,
    alarmState: AlarmState
  ): Promise<boolean> {
    const orchAlarmState = alarmState as OrchestratorAlarmState;
    const logger = this.getLogger();

    // Update status to running if pending
    if (state.status === 'pending') {
      state.status = 'running';
      await this.saveState(state);
    }

    // Check expiry
    if (this.isExpired(state)) {
      logger.error('Job expired');
      await this.failJob(state, 'EXPIRED', 'Job expired before completion');
      await this.writeLog(state);
      return false;
    }

    // Get current entity statuses
    const pendingEntities = Object.entries(state.entities)
      .filter(([_, e]) => e.status === 'pending')
      .map(([id]) => id);

    const dispatchedEntities = Object.entries(state.entities)
      .filter(([_, e]) => e.status === 'dispatched' || e.status === 'polling')
      .map(([id]) => id);

    // Check if all done
    if (pendingEntities.length === 0 && dispatchedEntities.length === 0) {
      return await this.finalize(state);
    }

    // Dispatch more entities if we have capacity
    const availableSlots =
      state.config.concurrency - dispatchedEntities.length;
    if (availableSlots > 0 && pendingEntities.length > 0) {
      const toDispatch = pendingEntities.slice(0, availableSlots);
      await this.dispatchEntities(state, toDispatch);
    }

    // Poll dispatched entities
    if (dispatchedEntities.length > 0) {
      await this.pollEntities(state, dispatchedEntities);
    }

    // Update progress
    this.updateProgress(state);
    await this.saveState(state);

    // Schedule next alarm
    await this.scheduleAlarm(state.config.poll_interval_ms);

    return true;
  }

  // ===========================================================================
  // Dispatch Entities
  // ===========================================================================

  private async dispatchEntities(
    state: OrchestratorJobState,
    entityIds: string[]
  ): Promise<void> {
    const logger = this.getLogger();
    const client = new ArkeClient({
      baseUrl: state.api_base,
      authToken: this.env.ARKE_API_KEY,
      network: state.network,
    });

    for (const entityId of entityIds) {
      const entityState = state.entities[entityId];
      entityState.attempts++;
      entityState.started_at = new Date().toISOString();

      logger.info(
        `Dispatching entity (attempt ${entityState.attempts}/${state.config.max_retries})`,
        { entityId }
      );

      const result = await dispatchToAgent(client, SUB_AGENT_ID, {
        target: state.target,
        jobCollection: state.job_collection,
        input: buildSubAgentInput(entityId, state.options),
        expiresIn: 7200,
      });

      if (result.success && result.sub_job_id) {
        entityState.status = 'dispatched';
        entityState.sub_job_id = result.sub_job_id;
        entityState.poll_start_time = Date.now();
        entityState.error = undefined;

        logger.info('Entity dispatched', {
          entityId,
          sub_job_id: result.sub_job_id,
        });
      } else {
        logger.warning('Dispatch failed', {
          entityId,
          attempt: entityState.attempts,
          error: result.error,
        });

        entityState.error = result.error;

        if (entityState.attempts >= state.config.max_retries) {
          entityState.status = 'error';
          entityState.completed_at = new Date().toISOString();
          logger.error('Entity failed after max retries', { entityId });
        } else {
          // Leave as pending for retry on next alarm
          entityState.status = 'pending';
        }
      }
    }
  }

  // ===========================================================================
  // Poll Entities
  // ===========================================================================

  private async pollEntities(
    state: OrchestratorJobState,
    entityIds: string[]
  ): Promise<void> {
    const logger = this.getLogger();

    for (const entityId of entityIds) {
      const entityState = state.entities[entityId];

      if (!entityState.sub_job_id) continue;

      // Check poll timeout
      const pollElapsed = Date.now() - (entityState.poll_start_time ?? 0);
      if (pollElapsed > state.config.poll_timeout_ms) {
        logger.warning('Poll timeout exceeded', { entityId, pollElapsed });
        entityState.error = 'Poll timeout exceeded';

        if (entityState.attempts >= state.config.max_retries) {
          entityState.status = 'error';
          entityState.completed_at = new Date().toISOString();
          logger.error('Entity failed after timeout', { entityId });
        } else {
          // Reset for retry
          entityState.status = 'pending';
          entityState.sub_job_id = undefined;
          entityState.poll_start_time = undefined;
        }
        continue;
      }

      // Poll status
      const result = await pollAgentStatus(
        SUB_AGENT_ENDPOINT,
        entityState.sub_job_id
      );

      if (result.done) {
        if (result.status === 'done') {
          entityState.status = 'done';
          entityState.result = result.result;
          entityState.completed_at = new Date().toISOString();
          entityState.error = undefined;
          logger.success('Entity completed', { entityId });
        } else {
          // Error from sub-agent
          entityState.error = result.error;

          if (entityState.attempts >= state.config.max_retries) {
            entityState.status = 'error';
            entityState.completed_at = new Date().toISOString();
            logger.error('Entity failed', { entityId, error: result.error });
          } else {
            // Reset for retry
            entityState.status = 'pending';
            entityState.sub_job_id = undefined;
            entityState.poll_start_time = undefined;
            logger.warning('Entity error, will retry', {
              entityId,
              error: result.error,
            });
          }
        }
      }
      // If not done, keep polling on next alarm
    }
  }

  // ===========================================================================
  // Finalize
  // ===========================================================================

  private async finalize(state: OrchestratorJobState): Promise<boolean> {
    const logger = this.getLogger();

    this.updateProgress(state);

    const succeeded = state.progress.done;
    const failed = state.progress.error;
    const total = state.progress.total;

    state.status = failed === total ? 'error' : 'done';
    state.completed_at = new Date().toISOString();
    state.result = {
      total,
      succeeded,
      failed,
      message:
        state.status === 'done'
          ? `Successfully processed ${succeeded}/${total} entities`
          : `All ${total} entities failed`,
    };

    if (state.status === 'error') {
      state.error = { code: 'ALL_FAILED', message: 'All entities failed' };
    }

    await this.saveState(state);

    logger.info('Orchestration complete', {
      status: state.status,
      succeeded,
      failed,
      total,
    });

    // Write log to Arke
    await this.writeLog(state);

    return false; // No more alarms
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private updateProgress(state: OrchestratorJobState): void {
    let pending = 0;
    let dispatched = 0;
    let done = 0;
    let error = 0;

    for (const entity of Object.values(state.entities)) {
      switch (entity.status) {
        case 'pending':
          pending++;
          break;
        case 'dispatched':
        case 'polling':
          dispatched++;
          break;
        case 'done':
          done++;
          break;
        case 'error':
          error++;
          break;
      }
    }

    state.progress = {
      total: Object.keys(state.entities).length,
      pending,
      dispatched,
      done,
      error,
    };
  }

  private async writeLog(state: OrchestratorJobState): Promise<void> {
    const logger = this.getLogger();

    try {
      const client = new ArkeClient({
        baseUrl: state.api_base,
        authToken: this.env.ARKE_API_KEY,
        network: state.network,
      });

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
        agent_id: this.env.AGENT_ID,
        agent_version: this.env.AGENT_VERSION,
        started_at: state.started_at,
        completed_at: state.completed_at!,
        status: state.status === 'done' ? 'done' : 'error',
        result: state.result,
        error: state.error,
        entity_results: entityResults,
        entries: logger.getEntries(),
      });

      // Update the job collection status
      await this.updateJobCollectionStatus(client, state);
    } catch (err) {
      console.error(`[${this.env.AGENT_ID}] Failed to write log:`, err);
    }
  }

  // ===========================================================================
  // Update Job Collection Status
  // ===========================================================================

  private async updateJobCollectionStatus(
    client: ArkeClient,
    state: OrchestratorJobState
  ): Promise<void> {
    const finalStatus = state.status === 'done' ? 'done' : 'error';
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const { data: collection } = await client.api.GET('/collections/{id}', {
          params: { path: { id: state.job_collection } },
        });

        if (!collection) {
          console.error(`[${this.env.AGENT_ID}] Job collection not found: ${state.job_collection}`);
          return;
        }

        const { error: updateError } = await client.api.PUT('/collections/{id}', {
          params: { path: { id: state.job_collection } },
          body: {
            expect_tip: collection.cid,
            properties: {
              status: finalStatus,
            },
            note: `Job ${state.job_id} completed with status: ${finalStatus}`,
          },
        });

        if (updateError) {
          const errorStr = JSON.stringify(updateError);
          if (errorStr.includes('409') || errorStr.includes('Conflict')) {
            if (attempt < maxRetries - 1) {
              const delay = Math.pow(2, attempt) * 100 + Math.random() * 100;
              console.log(`[${this.env.AGENT_ID}] CAS conflict updating job collection, retrying...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }
          console.error(`[${this.env.AGENT_ID}] Failed to update job collection status:`, updateError);
          return;
        }

        console.log(`[${this.env.AGENT_ID}] Updated job collection ${state.job_collection} status to ${finalStatus}`);
        return;
      } catch (err) {
        console.error(`[${this.env.AGENT_ID}] Error updating job collection (attempt ${attempt + 1}):`, err);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
        }
      }
    }
  }

  // ===========================================================================
  // Status Response
  // ===========================================================================

  protected getStatusResponse(state: OrchestratorJobState): BaseStatusResponse {
    return {
      job_id: state.job_id,
      status: state.status,
      progress: state.progress,
      result: state.result,
      error: state.error,
      started_at: state.started_at,
      completed_at: state.completed_at,
    };
  }
}
