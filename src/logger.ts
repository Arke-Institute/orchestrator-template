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

// Write log to the log file entity via Arke API (orchestrator version with entity_results)
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
): Promise<void> {
  // Get current file to get CID for CAS
  const { data: file } = await client.api.GET('/files/{id}', {
    params: { path: { id: logPi } },
  });

  if (!file) {
    console.error(`[logger] Log file not found: ${logPi}`);
    return;
  }

  // Update file with log data in extra_properties
  await client.api.PUT('/files/{id}', {
    params: { path: { id: logPi } },
    body: {
      expect_tip: file.cid,
      extra_properties: {
        log_data: log,
        log_written_at: new Date().toISOString(),
      },
      note: `Log written by ${log.agent_id}`,
    },
  });
}
