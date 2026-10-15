import type { Env } from './env.js';
import { newId, now } from './ids.js';

/**
 * Append-only audit trail. Every pipeline state transition and every
 * anonymous/signed mutation lands here (contract §7.7).
 *
 * Callers must pass a small, non-sensitive payload — never a request body,
 * a signature, or anything derived from an R2 credential.
 */
export async function logEvent(
  env: Env,
  kind: string,
  payload: Record<string, unknown> = {},
  agentId: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO events (id, agent_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(newId('ev'), agentId, kind, JSON.stringify(payload).slice(0, 2000), now())
    .run();
}