import { sql } from 'drizzle-orm';
import { sha256Hex, scrubSensitive } from '@mintax/core';
import { systemErrors } from '@mintax/db';
import type { ServiceContext } from '../context';

/**
 * Error Collector — Controlled Self-Improvement Loop 의 입구.
 * 동일 원인(메시지 정규화 + 스택 첫 프레임)은 fingerprint 로 묶어 occurrences 를 올린다.
 * 메시지/스택은 반드시 스크럽(주민번호·카드번호·비밀값 제거) 후 저장한다.
 */
export async function recordSystemError(
  ctx: Pick<ServiceContext, 'db'>,
  input: { area: string; error: unknown; userMessage?: string; context?: Record<string, unknown> },
): Promise<void> {
  const err = input.error instanceof Error ? input.error : new Error(String(input.error));
  const message = scrubSensitive(err.message).slice(0, 2000);
  const stack = err.stack ? scrubSensitive(err.stack).slice(0, 8000) : null;
  const normalized = message.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').replace(/\d+/g, '<n>');
  const firstFrame = (stack ?? '').split('\n').find((l) => l.trim().startsWith('at ')) ?? '';
  const fingerprint = sha256Hex(`${input.area}|${err.name}|${normalized}|${firstFrame.trim()}`);
  const context = JSON.parse(scrubSensitive(JSON.stringify(input.context ?? {}))) as Record<string, unknown>;
  await ctx.db
    .insert(systemErrors)
    .values({ fingerprint, area: input.area, message, userMessage: input.userMessage ?? null, stack, context })
    .onConflictDoUpdate({
      target: systemErrors.fingerprint,
      set: { occurrences: sql`${systemErrors.occurrences} + 1`, lastSeenAt: sql`now()`, context },
    });
}
