import type { JobType } from '@mintax/core';
import type { ServiceContext } from '../context';
import type { ClaimedJob } from './queue';

export interface JobRunContext {
  ctx: ServiceContext;
  job: ClaimedJob;
  /** 진행률 보고 (worker 가 throttle 해서 DB 기록) */
  progress: (processed: number, total: number) => Promise<void>;
}

export interface JobResult {
  status: 'succeeded' | 'partial';
  result: Record<string, unknown>;
}

export type JobHandler = (run: JobRunContext) => Promise<JobResult>;

const handlers = new Map<JobType, JobHandler>();

export function registerJobHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getJobHandler(type: string): JobHandler | undefined {
  return handlers.get(type as JobType);
}

export function registeredJobTypes(): JobType[] {
  return [...handlers.keys()];
}
