import type { JobState } from './types';

const KV_TTL = 86400; // 24 hours

export async function getJobState(
  kv: KVNamespace,
  jobId: string
): Promise<JobState | null> {
  const data = await kv.get(`job:${jobId}`, 'json');
  return data as JobState | null;
}

export async function saveJobState(
  kv: KVNamespace,
  state: JobState
): Promise<void> {
  await kv.put(`job:${state.job_id}`, JSON.stringify(state), {
    expirationTtl: KV_TTL,
  });
}

// Recalculate progress from entity statuses
export function updateProgress(state: JobState): void {
  const entities = Object.values(state.entities);
  state.progress = {
    total: entities.length,
    pending: entities.filter((e) => e.status === 'pending').length,
    dispatched: entities.filter(
      (e) => e.status === 'dispatched' || e.status === 'polling'
    ).length,
    done: entities.filter((e) => e.status === 'done').length,
    error: entities.filter((e) => e.status === 'error').length,
  };
}
