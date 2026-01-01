import type { ArkeClient } from '@arke-institute/sdk';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'success';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  metadata?: Record<string, unknown>;
}

export class JobLogger {
  private entries: LogEntry[] = [];

  constructor(private agentId: string) {}

  private log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      message,
      metadata,
    };
    this.entries.push(entry);
    console.log(`[${this.agentId}] [${level}] ${message}`, metadata ?? '');
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', message, metadata);
  }
  info(message: string, metadata?: Record<string, unknown>): void {
    this.log('info', message, metadata);
  }
  warning(message: string, metadata?: Record<string, unknown>): void {
    this.log('warning', message, metadata);
  }
  error(message: string, metadata?: Record<string, unknown>): void {
    this.log('error', message, metadata);
  }
  success(message: string, metadata?: Record<string, unknown>): void {
    this.log('success', message, metadata);
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }
}

export interface OrchestratorLogData {
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
  entity_results: Record<
    string,
    {
      status: 'done' | 'error';
      sub_job_id?: string;
      result?: Record<string, unknown>;
      error?: string;
    }
  >;
  entries: LogEntry[];
}

/**
 * Write job log to the job collection.
 *
 * Creates a new file entity in the job collection, then updates the collection
 * to add "contains" relationship with CAS retry.
 */
export async function writeJobLog(
  client: ArkeClient,
  jobCollection: string,
  log: OrchestratorLogData
): Promise<void> {
  const filename = `${log.job_id}.json`;

  // Step 1: Create file in the job collection
  const { data: file, error: createError } = await client.api.POST('/files', {
    body: {
      key: filename, // S3 key
      collection: jobCollection,
      filename,
      content_type: 'application/json',
      size: 0, // Metadata-only file
      relationships: [
        { predicate: 'in', peer: jobCollection, peer_type: 'collection' }
      ],
      properties: {
        log_data: log,
      },
      description: `Orchestrator job log for ${log.job_id}`,
    },
  });

  if (createError || !file) {
    console.error(`[logger] Failed to create log file:`, createError);
    return;
  }

  console.log(`[logger] Created log file ${file.id} in collection ${jobCollection}`);

  // Step 2: Update collection to add "contains" relationship with CAS retry
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Get current collection CID
      const { data: collection } = await client.api.GET('/collections/{id}', {
        params: { path: { id: jobCollection } },
      });

      if (!collection) {
        console.error(`[logger] Job collection not found: ${jobCollection}`);
        return;
      }

      // Update with contains relationship
      const { error: updateError } = await client.api.PUT('/collections/{id}', {
        params: { path: { id: jobCollection } },
        body: {
          expect_tip: collection.cid,
          relationships_add: [
            { predicate: 'contains', peer: file.id, peer_type: 'file' }
          ],
          note: `Added log file ${file.id}`,
        },
      });

      if (updateError) {
        // Check if it's a CAS conflict
        const errorStr = JSON.stringify(updateError);
        if (errorStr.includes('409') || errorStr.includes('Conflict')) {
          if (attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 100 + Math.random() * 100;
            console.log(`[logger] CAS conflict, retrying in ${delay}ms...`);
            await sleep(delay);
            continue;
          }
        }
        console.error(`[logger] Failed to update collection:`, updateError);
        return;
      }

      console.log(`[logger] Updated collection ${jobCollection} with contains relationship`);
      return;
    } catch (err) {
      console.error(`[logger] Error updating collection (attempt ${attempt + 1}):`, err);
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 100 + Math.random() * 100;
        await sleep(delay);
      }
    }
  }

  console.error(`[logger] Failed to update collection after ${maxRetries} retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
