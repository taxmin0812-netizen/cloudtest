/**
 * 자료 수집 — 업로드 진입점 (Adapter B/C/D/E 공통).
 *
 * 흐름: 검증 → sha256 → 형식·수임처 판정 → (같은 파일이면 거절) → 원본 암호화 저장 → import_jobs → jobs(import_file)
 * 수임처를 파일 내용으로 확신할 수 없을 때만 한 번 묻는다(needs_client). 확신하면 묻지 않는다.
 */
import { eq } from 'drizzle-orm';
import { importJobs, type Database } from '@mintax/db';
import { previewImport, isAdapterError, type FormatDetection, type ImportPreview } from '@mintax/adapters';
import { NotFoundError, ValidationError, ConflictError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { notifyProblem, resolveProblem } from '../infra/notify';
import { readStoredFile, sha256OfBuffer, storeFile } from '../infra/storage';
import { enqueueJob } from '../jobs/queue';
import { DuplicateImportFileError, ImportRejectedError, fromAdapterError, importHref } from './errors';
import {
  CHANNEL_LABELS,
  MAX_IMPORT_FILE_BYTES,
  NEEDS_CLIENT_TAG,
  deriveImportState,
  formatCount,
  isIngestChannel,
  isValidPeriod,
} from './helpers';
import {
  assertNoClientConflict,
  autoClientOf,
  detectionDTO,
  detectionFromMapping,
  findPreviousImport,
  kstShort,
  loadClientRefs,
  needsMappingMessage,
  previousImportSummary,
} from './shared';
import type { ConfirmImportInput, ImportDetectionDTO, ImportMappingInput, UploadImportInput, UploadImportResult } from './types';

/** import_file 작업 payload */
export interface ImportFilePayload {
  importJobId: string;
  fileId: string;
  clientId: string;
  channel: string;
  formatProfile: string | null;
  period: string | null;
  sheetIndex?: number;
  mapping?: ImportMappingInput;
  allowClientConflict?: boolean;
  force?: boolean;
}

/** Bridge 등 사람이 화면 앞에 없는 채널 — 확인이 필요하면 알림으로 알린다 */
const UNATTENDED_CHANNELS = new Set(['desktop_bridge', 'download_watch', 'cloud_folder', 'wemembers_api']);

export interface CreateImportOptions {
  /** Bridge 업로드 부가정보 (감사로그용 — 경로는 파일명만) */
  bridge?: { tokenName: string; sourceFileName: string | null; sourceFolder: string | null };
}

function validateUpload(input: UploadImportInput): void {
  const errors: Array<{ field: string; message: string }> = [];
  if (typeof input.fileName !== 'string' || input.fileName.trim() === '' || input.fileName.length > 255) {
    errors.push({ field: 'fileName', message: '파일 이름이 없거나 너무 깁니다.' });
  }
  if (!Buffer.isBuffer(input.data)) errors.push({ field: 'data', message: '파일 내용이 없습니다.' });
  if (!isIngestChannel(input.channel)) errors.push({ field: 'channel', message: '알 수 없는 수집 경로입니다.' });
  if (input.period !== undefined && input.period !== null && !isValidPeriod(input.period)) {
    errors.push({ field: 'period', message: '기간은 YYYY-MM 형식이어야 합니다.' });
  }
  if (input.sheetIndex !== undefined && (!Number.isInteger(input.sheetIndex) || input.sheetIndex < 0)) {
    errors.push({ field: 'sheetIndex', message: '시트 번호가 올바르지 않습니다.' });
  }
  if (errors.length > 0) throw new ValidationError(`입력값을 확인해 주세요: ${errors.map((e) => e.message).join(' ')}`, errors);
  if (input.data.length === 0) throw new ImportRejectedError('IMPORT_EMPTY_FILE', '빈 파일입니다. 파일을 다시 내려받아 올려주세요.');
  if (input.data.length > MAX_IMPORT_FILE_BYTES) {
    throw new ImportRejectedError(
      'IMPORT_TOO_LARGE',
      `파일이 너무 큽니다 (${formatCount(Math.ceil(input.data.length / 1024 / 1024))}MB, 최대 ${MAX_IMPORT_FILE_BYTES / 1024 / 1024}MB). 조회 기간을 나누어 내려받아 올려주세요.`,
      { httpStatus: 413 },
    );
  }
}

async function runPreview(data: Buffer, fileName: string, clients: Awaited<ReturnType<typeof loadClientRefs>>, sheetIndex?: number): Promise<ImportPreview> {
  try {
    return await previewImport(data, fileName, { clients, ...(sheetIndex !== undefined ? { sheetIndex } : {}) });
  } catch (e) {
    if (isAdapterError(e)) throw fromAdapterError(e);
    throw e;
  }
}

function assertTransactionFile(preview: ImportPreview): void {
  if (preview.detection.profile.purpose === 'reconciliation' && !preview.detection.requiresUserMapping) {
    throw new ImportRejectedError(
      'IMPORT_WRONG_PURPOSE',
      `${preview.detection.profile.name} 파일입니다. 이 파일은 거래로 가져오면 이중 기장이 되므로 WEHAGO 전송센터의 대사(역수입) 화면에서 올려 주세요.`,
      { action: { label: 'WEHAGO 전송센터', href: '/transfer' } },
    );
  }
}

/**
 * 공용 생성 로직 (uploadImportFile · bridgeUpload). 권한 검사는 호출자가 한다.
 */
export async function createImport(ctx: ServiceContext, input: UploadImportInput, opts: CreateImportOptions = {}): Promise<UploadImportResult> {
  validateUpload(input);
  const fileName = input.fileName.trim();
  const sha256 = sha256OfBuffer(input.data);
  const clients = await loadClientRefs(ctx.db);

  let selected: { id: string; name: string } | null = null;
  if (input.clientId) {
    const c = clients.find((x) => x.id === input.clientId);
    if (!c) throw new NotFoundError('수임처(활성)');
    selected = { id: c.id, name: c.name };
  }

  const preview = await runPreview(input.data, fileName, clients, input.sheetIndex);
  assertTransactionFile(preview);

  // ── 수임처 ──
  let clientId: string | null = selected?.id ?? null;
  let auto = false;
  if (selected) {
    assertNoClientConflict(preview.client, selected.id, selected.name, input.allowClientConflict);
  } else {
    clientId = autoClientOf(preview.client);
    auto = clientId !== null;
  }

  // ── 서식 ──
  let detection: FormatDetection = preview.detection;
  if (input.mapping) detection = detectionFromMapping(preview, input.mapping);
  const needsMapping = detection.requiresUserMapping && !detection.userConfirmed;
  const needsClient = clientId === null;

  // ── 같은 파일 (멱등성) ──
  if (!input.force) {
    const prev = await findPreviousImport(ctx.db, sha256, clientId);
    if (prev) {
      const summary = clientId ? previousImportSummary(prev) : '수임처 확인 대기 중';
      throw new DuplicateImportFileError(prev.id, kstShort(prev.createdAt), summary);
    }
  }

  const clientName = clientId ? (clients.find((c) => c.id === clientId)?.name ?? null) : null;
  const warnings = [...preview.file.warnings];
  const detected: ImportDetectionDTO = detectionDTO(preview, detection, clientId, auto);
  const status: UploadImportResult['status'] = needsMapping ? 'needs_mapping' : needsClient ? 'needs_client' : 'queued';

  let message: string | null = null;
  if (needsMapping) message = needsMappingMessage(preview);
  else if (needsClient) {
    const cands = detected.clientCandidates.slice(0, 3).map((c) => `${c.name}(${c.confidence}%)`);
    message = `${NEEDS_CLIENT_TAG} 파일에서 수임처를 확정하지 못했습니다.${cands.length > 0 ? ` 후보: ${cands.join(', ')}` : ' 파일 안에 수임처 사업자번호·상호가 없습니다.'} — 수임처를 선택하세요.`;
  }

  const result = await ctx.db.transaction(async (tx) => {
    const tctx = withTx(ctx, tx);
    const stored = await storeFile(tctx, {
      data: input.data,
      originalName: fileName,
      mimeType: mimeOf(fileName),
      purpose: 'import_source',
      clientId,
    });
    const [row] = await tx
      .insert(importJobs)
      .values({
        clientId,
        fileId: stored.id,
        channel: input.channel,
        formatProfile: needsMapping && detection.profile.id === 'generic_v1' ? null : detection.profile.id,
        source: detection.profile.source,
        period: input.period ?? null,
        status: needsMapping ? 'failed' : 'queued',
        message,
        createdBy: ctx.actor.userId,
        createdAt: ctx.now(),
        finishedAt: needsMapping ? ctx.now() : null,
      })
      .returning({ id: importJobs.id });
    const importJobId = row!.id;

    let jobId: string | null = null;
    if (status === 'queued') {
      const payload: ImportFilePayload = {
        importJobId,
        fileId: stored.id,
        clientId: clientId!,
        channel: input.channel,
        formatProfile: detection.profile.id,
        period: input.period ?? null,
        ...(input.sheetIndex !== undefined ? { sheetIndex: input.sheetIndex } : {}),
        ...(input.mapping ? { mapping: input.mapping } : {}),
        ...(input.allowClientConflict ? { allowClientConflict: true } : {}),
        ...(input.force ? { force: true } : {}),
      };
      jobId = await enqueueJob(tx as unknown as Database, 'import_file', payload as unknown as Record<string, unknown>, { createdBy: ctx.actor.userId });
    }

    const who = opts.bridge ? ` (Bridge: ${opts.bridge.tokenName})` : '';
    await writeAudit(tctx, {
      action: 'import.upload',
      category: 'data_change',
      entityType: 'import_job',
      entityId: importJobId,
      clientId,
      summary: `${fileName} 업로드${who} → ${clientName ?? '수임처 미정'} · ${detected.profileName ?? '서식 미확인'}${
        auto ? ` (수임처 자동 판정 ${preview.client?.best?.confidence ?? 0}%)` : ''
      }${input.force ? ' · 같은 파일 다시 가져오기' : ''}`,
      before: null,
      after: {
        fileName,
        fileId: stored.id,
        sha256,
        sizeBytes: input.data.length,
        channel: input.channel,
        formatProfile: detection.profile.id,
        formatConfidence: detection.confidence,
        clientId,
        clientAutoDetected: auto,
        period: input.period ?? null,
        status,
        force: input.force ?? false,
        ...(opts.bridge ? { bridge: { name: opts.bridge.tokenName, sourceFileName: opts.bridge.sourceFileName, sourceFolder: opts.bridge.sourceFolder } } : {}),
      },
    });

    if (needsMapping) {
      await notifyProblem(tctx, {
        kind: 'import_failed',
        severity: 'warning',
        title: `서식 확인 필요 — ${fileName}`,
        body: message ?? undefined,
        href: importHref(importJobId),
        clientId,
        dedupeKey: `import_failed:${importJobId}`,
      });
    } else if (needsClient && UNATTENDED_CHANNELS.has(input.channel)) {
      await notifyProblem(tctx, {
        kind: 'import_failed',
        severity: 'warning',
        title: `수임처 확인 필요 — ${fileName}`,
        body: `${CHANNEL_LABELS[input.channel]}로 들어온 파일의 수임처를 확정하지 못했습니다. 수임처를 선택하면 바로 가져옵니다.`,
        href: importHref(importJobId),
        clientId: null,
        dedupeKey: `import_needs_client:${importJobId}`,
      });
    }
    return { importJobId, jobId };
  });

  const guide =
    status === 'queued'
      ? `${clientName ?? ''} ${detected.profileName ?? ''} 가져오기를 시작했습니다.`.trim()
      : status === 'needs_client'
        ? '수임처를 선택하면 바로 가져옵니다.'
        : '서식(열)을 지정하면 가져옵니다.';
  return {
    importJobId: result.importJobId,
    jobId: result.jobId,
    status,
    message: message ? message.replace(/^\[[^\]]+\]\s*/, '') : guide,
    detected,
    warnings,
    href: importHref(result.importJobId),
  };
}

function mimeOf(fileName: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  switch (ext) {
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'csv':
      return 'text/csv';
    case 'tsv':
    case 'txt':
      return 'text/plain';
    case 'html':
    case 'htm':
      return 'text/html';
    default:
      return null;
  }
}

// ────────────────────────────── 공개 API ──────────────────────────────

/**
 * 파일 업로드 (웹 직접 업로드 · 위멤버스/홈택스 파일).
 * 권한: imports.create
 */
export async function uploadImportFile(ctx: ServiceContext, input: UploadImportInput): Promise<UploadImportResult> {
  requirePermission(ctx, 'imports.create');
  return createImport(ctx, input);
}

/**
 * 사람 확인이 필요한 가져오기(수임처 미정 / 서식 확인 필요)를 확정하고 큐에 넣는다.
 * 권한: imports.create
 */
export async function confirmImport(ctx: ServiceContext, input: ConfirmImportInput): Promise<UploadImportResult> {
  requirePermission(ctx, 'imports.create');
  const [job] = await ctx.db.select().from(importJobs).where(eq(importJobs.id, input.importJobId));
  if (!job) throw new NotFoundError('가져오기');
  const state = deriveImportState(job.status, job.clientId, job.message);
  if (state !== 'needs_client' && state !== 'needs_mapping' && !(state === 'failed' && job.totalRows === 0)) {
    throw new ConflictError('이미 처리 중이거나 처리가 끝난 가져오기입니다. 목록을 새로고침해 주세요.');
  }
  if (!job.fileId) throw new ImportRejectedError('IMPORT_FILE_MISSING', '원본 파일이 보관되어 있지 않아 다시 가져올 수 없습니다. 파일을 새로 올려 주세요.');

  const clients = await loadClientRefs(ctx.db);
  const clientId = input.clientId ?? job.clientId;
  if (!clientId) {
    throw new ValidationError('수임처를 선택해 주세요.', [{ field: 'clientId', message: '필수' }]);
  }
  const client = clients.find((c) => c.id === clientId);
  if (!client) throw new NotFoundError('수임처(활성)');

  const { data, row: fileRow } = await readStoredFile(ctx, job.fileId);
  const preview = await runPreview(data, fileRow.originalName, clients, input.sheetIndex);
  assertTransactionFile(preview);
  const clientChanged = input.clientId !== undefined && input.clientId !== null && input.clientId !== job.clientId;
  // 사람이 후보 중에서 직접 고른 경우는 확인으로 본다. 단, 파일 근거가 확실히 다른 수임처를 가리키면 한 번 더 확인
  assertNoClientConflict(preview.client, client.id, client.name, input.allowClientConflict);

  let detection: FormatDetection = preview.detection;
  if (input.mapping) detection = detectionFromMapping(preview, input.mapping);
  if (detection.requiresUserMapping && !detection.userConfirmed) {
    throw new ValidationError('서식을 자동으로 알아보지 못했습니다. 열(거래일자·금액 등)을 지정해 주세요.', [{ field: 'mapping', message: '필수' }]);
  }

  if (!input.force) {
    const prev = await findPreviousImport(ctx.db, fileRow.sha256, client.id, job.id);
    if (prev) throw new DuplicateImportFileError(prev.id, kstShort(prev.createdAt), previousImportSummary(prev));
  }

  const before = { clientId: job.clientId, formatProfile: job.formatProfile, status: job.status, state };
  const jobId = await ctx.db.transaction(async (tx) => {
    const tctx = withTx(ctx, tx);
    await tx
      .update(importJobs)
      .set({ clientId: client.id, formatProfile: detection.profile.id, source: detection.profile.source, status: 'queued', message: null, finishedAt: null })
      .where(eq(importJobs.id, job.id));
    const payload: ImportFilePayload = {
      importJobId: job.id,
      fileId: job.fileId!,
      clientId: client.id,
      channel: job.channel,
      formatProfile: detection.profile.id,
      period: job.period,
      ...(input.sheetIndex !== undefined ? { sheetIndex: input.sheetIndex } : {}),
      ...(input.mapping ? { mapping: input.mapping } : {}),
      ...(input.allowClientConflict ? { allowClientConflict: true } : {}),
      ...(input.force ? { force: true } : {}),
    };
    const id = await enqueueJob(tx as unknown as Database, 'import_file', payload as unknown as Record<string, unknown>, { createdBy: ctx.actor.userId });
    const parts: string[] = [];
    if (clientChanged || !job.clientId) parts.push(`수임처 지정: ${client.name}`);
    if (input.mapping) parts.push(`서식 지정: ${detection.profile.name}`);
    await writeAudit(tctx, {
      action: 'import.confirm',
      category: 'data_change',
      entityType: 'import_job',
      entityId: job.id,
      clientId: client.id,
      summary: `${fileRow.originalName} 가져오기 확정 — ${parts.join(' · ') || '다시 시도'}`,
      before,
      after: { clientId: client.id, formatProfile: detection.profile.id, status: 'queued', mapping: input.mapping ?? null },
    });
    await resolveProblem(tctx, `import_failed:${job.id}`);
    await resolveProblem(tctx, `import_needs_client:${job.id}`);
    return id;
  });

  return {
    importJobId: job.id,
    jobId,
    status: 'queued',
    message: `${client.name} ${detection.profile.name} 가져오기를 시작했습니다.`,
    detected: detectionDTO(preview, detection, client.id, false),
    warnings: preview.file.warnings,
    href: importHref(job.id),
  };
}
