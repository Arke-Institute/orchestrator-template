import type { ArkeClient } from '@arke-institute/sdk';
import {
  SUB_AGENT_ID,
  SUB_AGENT_ENDPOINT,
  buildSubAgentInput,
  type OrchestratorOptions,
} from './config';

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
  jobCollection: string,
  options?: OrchestratorOptions
): Promise<DispatchResult> {
  try {
    const { data, error } = await client.api.POST('/agents/{id}/invoke', {
      params: { path: { id: SUB_AGENT_ID } },
      body: {
        target,
        job_collection: jobCollection, // Pass parent job collection - sub-agent gets its own sub-collection
        input: buildSubAgentInput(entityId, options),
        expires_in: 3600, // 1 hour for sub-agent permissions
        confirm: true,
      },
    });

    if (error) {
      return { success: false, error: JSON.stringify(error) };
    }

    // Type narrowing for union response
    if (data && 'error' in data && 'status' in data && data.status === 'rejected') {
      return { success: false, error: (data as { error: string }).error };
    }

    if (data && 'job_id' in data && 'status' in data && data.status === 'started') {
      return { success: true, sub_job_id: (data as { job_id: string }).job_id };
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
        const data = (await res.json()) as {
          status: string;
          result?: Record<string, unknown>;
          error?: { code: string; message: string };
        };

        if (data.status === 'done') {
          return { done: true, status: 'done', result: data.result };
        }

        if (data.status === 'error') {
          return {
            done: true,
            status: 'error',
            error: data.error?.message ?? 'Unknown error',
          };
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
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      await new Promise<void>((resolve) => {
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
