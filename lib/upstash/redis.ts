import "server-only";

// TODO(Phase 3/4 transcription pipeline): BullMQ-backing Redis client
// (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN). Enqueues transcription
// jobs; Modal worker dequeues (PRD §19.1 — API never reachable by the worker
// except via this queue and the webhook endpoint).
export async function enqueueTranscriptionJob(_jobId: string, _payload: unknown): Promise<void> {
  throw new Error("enqueueTranscriptionJob not implemented — see transcription pipeline work");
}

export async function getQueuePosition(_jobId: string): Promise<number> {
  throw new Error("getQueuePosition not implemented — see transcription pipeline work");
}
