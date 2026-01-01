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
  sub_job_id?: string; // Job ID from sub-agent
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
