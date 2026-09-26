/**
 * 자료 수집 통합 테스트 — 실제 PostgreSQL (mintax_test_imports).
 * DATABASE_URL_TEST=postgres://mintax:mintax_dev@localhost:5432/mintax_test_imports npx vitest run --project integration packages/server/src/imports
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.MINTAX_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MINTAX_INDEX_KEY = Buffer.alloc(32, 9).toString('base64');
const STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'mintax-imports-'));
process.env.STORAGE_LOCAL_DIR = STORAGE_DIR;

import { and, eq, sql } from 'drizzle-orm';
import { auditLogs, closeDb, exportJobs, files, importJobs, integrationConnections, jobs, notifications, setupTestDatabase, transactionSources, transactions, type Database } from '@mintax/db';
import { readTabularFile } from '@mintax/adapters';
import { CARD_HEADER, VENDOR_A, VENDOR_B, VENDOR_C, dashed, genericRows, toCsvBuffer, toXlsxBuffer, wehagoLedgerRows } from '@mintax/adapters/__fixtures__/builders';
import { AppError, ForbiddenError, RateLimitError } from '@mintax/security';
import { systemActor, type ServiceContext } from '../context';
import { setStorageDriver, storeFile } from '../infra/storage';
import { getJob } from '../jobs/queue';
import { getJobHandler } from '../jobs/registry';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import {
  BridgeAuthError,
  bridgeDownloadResult,
  bridgeResults,
  bridgeUpload,
  createBridgeToken,
  listBridgeTokens,
  resetBridgeRateLimits,
  revokeBridgeToken,
  verifyBridgeToken,
  DuplicateImportFileError,
  WEHAGO_DUPLICATE_REASON,
  confirmImport,
  downloadImportErrorReport,
  getImportDetection,
  getImportFailures,
  getImportJob,
  listImportJobs,
  registerImportsJobHandlers,
  runImportFileJob,
  uploadImportFile,
} from './index';

let db: Database;
let ctx: ServiceContext;
let client: { id: string; businessNumber: string; code: string; name: string };

type Row = unknown[];
const card = (
  date: string,
  cardNo: string,
  v: { name: string; bizno: string },
  supply: number | string,
  vat: number | string,
  total: number | string,
  type = '일반과세자',
  approval?: string,
): Row => {
  const row: Row = [date, '비씨카드', cardNo, dashed(v.bizno), v.name, supply, vat, 0, total, type, '도소매', '기타', '공제', ''];
  if (approval !== undefined) row.push(approval);
  return row;
};
/** 승인번호 열이 있는 카드 매입 서식 (위멤버스 변형) */
const CARD_HEADER_APV = [...CARD_HEADER, '승인번호'];
const CARD1 = '4111-1111-1111-1111';
const CARD2 = '5555-5555-5555-4444';

/** 데이터 7행(정상 4 · 파일 내 중복 1 · 실패 2) + 합계행 1 */
function cardFileRows(bizno: string): Row[] {
  return [
    ['사업용 신용카드 매입내역', `사업자등록번호 ${dashed(bizno)}`],
    CARD_HEADER_APV,
    card('2026-09-01', CARD1, VENDOR_B, 9091, 909, 10000, '일반과세자', '30000001'),
    card('2026-09-02', CARD1, VENDOR_A, 20000, 2000, 22000, '일반과세자', '30000002'),
    card('2026-09-05', CARD1, VENDOR_B, 4546, 454, 5000, '일반과세자', '30000005'),
    card('2026-09-05', CARD1, VENDOR_B, 4546, 454, 5000, '일반과세자', '30000005'), // 같은 승인번호 반복 → 파일 안 중복
    card('2026-13-45', CARD1, VENDOR_A, 1000, 100, 1100, '일반과세자', '30000006'), // 일자 오류 → 실패
    card('2026-09-06', CARD2, VENDOR_A, 1000, 100, 1200, '일반과세자', '30000007'), // 금액 검산 불일치 → 실패
    card('2026-09-07', CARD2, VENDOR_C, 5500, 0, 5500, '간이과세자', '30000008'),
    ['합계', '', '', '', '', 40683, 3563, 0, 49800, '', '', '', '', '', ''],
  ];
}

async function runJob(jobId: string) {
  const job = await getJob(db, jobId);
  expect(job).not.toBeNull();
  const calls: Array<[number, number]> = [];
  const res = await runImportFileJob({
    ctx: testContext(db, systemActor()),
    job: job!,
    progress: async (p, t) => {
      calls.push([p, t]);
    },
  });
  return { res, calls };
}

async function expectAppError(p: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`expected ${code}`);
}

beforeAll(async () => {
  setStorageDriver(null);
  db = await setupTestDatabase(process.env.DATABASE_URL_TEST ?? 'postgres://mintax:mintax_dev@localhost:5432/mintax_test_imports');
  const user = await createTestUser(db, 'staff', '김담당');
  ctx = testContext(db, user.actor);
  client = await createTestClient(db, { name: '(주)민택스수집' });
  await createTestClient(db, { name: '해피카페수집' });
});

afterAll(async () => {
  await closeDb();
});

describe('import_file — 업로드 → 작업 → 정확한 건수', () => {
  let importJobId = '';
  let firstJobId = '';

  it('detects format and client from the file (does not ask), stores the original encrypted, enqueues import_file', async () => {
    const data = await toXlsxBuffer([{ name: '카드', rows: cardFileRows(client.businessNumber) }]);
    const r = await uploadImportFile(ctx, { fileName: '카드사용내역_202609.xlsx', data, channel: 'manual_upload' });
    expect(r.status).toBe('queued');
    expect(r.jobId).toBeTruthy();
    expect(r.detected.profileKey).toBe('hometax_card_purchase_v1');
    expect(r.detected.clientId).toBe(client.id);
    expect(r.detected.clientAutoDetected).toBe(true);
    expect(r.detected.clientCandidates[0]?.clientId).toBe(client.id);
    expect(r.href).toBe(`/imports/${r.importJobId}`);
    importJobId = r.importJobId;
    firstJobId = r.jobId!;

    const [ij] = await db.select().from(importJobs).where(eq(importJobs.id, importJobId));
    expect(ij!.status).toBe('queued');
    expect(ij!.clientId).toBe(client.id);
    expect(ij!.formatProfile).toBe('hometax_card_purchase_v1');
    const [f] = await db.select().from(files).where(eq(files.id, ij!.fileId!));
    expect(f!.purpose).toBe('import_source');
    expect(f!.encrypted).toBe(true);
    // 저장소의 파일은 평문 xlsx(PK..)가 아니라 암호문(MTX1)
    const onDisk = readFileSync(path.join(STORAGE_DIR, f!.storageKey));
    expect(onDisk.subarray(0, 4).toString('latin1')).toBe('MTX1');
    expect(onDisk.includes(Buffer.from('xl/workbook.xml'))).toBe(false);

    const [job] = await db.select().from(jobs).where(eq(jobs.id, firstJobId));
    expect(job!.type).toBe('import_file');
    expect((job!.payload as Record<string, unknown>).importJobId).toBe(importJobId);
  });

  it('runs the handler: totalRows = imported + duplicate + failed, every row in transaction_sources, classify_batch enqueued', async () => {
    const { res, calls } = await runJob(firstJobId);
    expect(res.status).toBe('partial');
    expect(res.result).toMatchObject({ totalRows: 7, importedRows: 4, duplicateRows: 1, failedRows: 2, nonDataRows: 1, periods: ['2026-09'] });
    // 진행률: 단조 증가, 마지막 100%
    for (let i = 1; i < calls.length; i++) expect(calls[i]![0] / calls[i]![1]).toBeGreaterThanOrEqual(calls[i - 1]![0] / calls[i - 1]![1]);
    expect(calls.at(-1)).toEqual([100, 100]);

    const [ij] = await db.select().from(importJobs).where(eq(importJobs.id, importJobId));
    expect(ij).toMatchObject({ status: 'partial', totalRows: 7, importedRows: 4, duplicateRows: 1, failedRows: 2, period: '2026-09' });
    expect(ij!.totalRows).toBe(ij!.importedRows + ij!.duplicateRows + ij!.failedRows);
    expect(ij!.message).toContain('합계·제목·안내 행 1건');

    const sources = await db.select().from(transactionSources).where(eq(transactionSources.importJobId, importJobId));
    expect(sources).toHaveLength(7);
    const byOutcome = (o: string) => sources.filter((s) => s.outcome === o);
    expect(byOutcome('ok')).toHaveLength(4);
    expect(byOutcome('duplicate')).toHaveLength(1);
    expect(byOutcome('failed')).toHaveLength(2);
    for (const s of byOutcome('failed')) {
      expect(s.errorReason).toBeTruthy();
      expect(s.transactionId).toBeNull();
    }
    // 원본 합계 = 파싱 가능한 모든 행(성공·중복·실패)
    const sumSources = sources.reduce((a, s) => a + (s.totalAmount ?? 0), 0);
    expect(ij!.sourceTotalAmount).toBe(sumSources);
    // 카드번호 원문은 어디에도 없다
    const blob = JSON.stringify(sources.map((s) => s.rawData));
    expect(blob).not.toContain('4111-1111-1111-1111');
    expect(blob).not.toContain('4111111111111111');

    const txs = await db.select().from(transactions).where(eq(transactions.importJobId, importJobId));
    expect(txs).toHaveLength(5);
    expect(txs.filter((t) => t.status === 'imported')).toHaveLength(4);
    const dup = txs.find((t) => t.status === 'duplicate')!;
    expect(dup.duplicateReason).toContain('같은 자료의');
    const original = txs.find((t) => t.id === dup.duplicateOfId)!;
    expect(original.status).toBe('imported');
    expect(original.fingerprint).toBe(dup.fingerprint);
    for (const t of txs) {
      expect(t.period).toBe('2026-09');
      expect(t.touchCount).toBe(0);
      expect(t.channel).toBe('manual_upload');
      expect(sources.find((s) => s.transactionId === t.id)).toBeTruthy();
    }

    const classify = await db.select().from(jobs).where(eq(jobs.type, 'classify_batch'));
    expect(classify).toHaveLength(1);
    expect(classify[0]!.payload).toEqual({ clientId: client.id, period: '2026-09', importJobId });
    expect(classify[0]!.parentJobId).toBe(firstJobId);

    const [n] = await db.select().from(notifications).where(eq(notifications.dedupeKey, `import_failed:${importJobId}`));
    expect(n!.kind).toBe('import_failed');
    expect(n!.title).toBe('2건 처리실패 — 오류 항목을 확인하세요');
    expect(n!.href).toBe(`/imports/${importJobId}`);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, importJobId));
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(['import.process', 'import.upload']);
    const upload = audits.find((a) => a.action === 'import.upload')!;
    expect(upload.actorName).toBe('김담당');
    expect(upload.summary).toContain('카드사용내역_202609.xlsx');
    expect(JSON.stringify(upload.afterData)).not.toMatch(/4111/);
  });

  it('is idempotent: running the same job again does not load rows twice', async () => {
    const { res } = await runJob(firstJobId);
    expect(res.result).toMatchObject({ alreadyProcessed: true, totalRows: 7 });
    const sources = await db.select().from(transactionSources).where(eq(transactionSources.importJobId, importJobId));
    expect(sources).toHaveLength(7);
  });

  it('getImportJob / listImportJobs return JSON DTOs with the Korean summary line', async () => {
    const d = await getImportJob(ctx, importJobId);
    expect(d.summary).toBe('7건 수집 · 5건 처리(중복 1건 포함) · 2건 처리실패');
    expect(d.state).toBe('partial');
    expect(d.clientName).toBe('(주)민택스수집');
    expect(d.fileName).toBe('카드사용내역_202609.xlsx');
    expect(d.formatProfileName).toContain('신용카드');
    expect(d.jobId).toBe(firstJobId);
    expect(d.transactionStatusCounts).toEqual({ imported: 4, duplicate: 1 });
    expect(typeof d.createdAt).toBe('string');
    expect(d.notes.some((x) => x.includes('합계'))).toBe(true);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);

    const list = await listImportJobs(ctx, { clientId: client.id, limit: 10 });
    expect(list.map((x) => x.id)).toContain(importJobId);
    expect(list.find((x) => x.id === importJobId)!.summary).toBe(d.summary);
    const byPeriod = await listImportJobs(ctx, { period: '2026-08', limit: 10 });
    expect(byPeriod).toHaveLength(0);
  });

  it('getImportFailures + downloadImportErrorReport (audited as download)', async () => {
    const f = await getImportFailures(ctx, importJobId);
    expect(f.total).toBe(2);
    expect(f.items).toHaveLength(2);
    expect(f.items.map((i) => i.field)).toContain('transactionDate');
    expect(f.items[0]!.reason).toMatch(/[가-힣]/);

    const file = await downloadImportErrorReport(ctx, importJobId);
    expect(file.fileName).toBe('카드사용내역_202609_오류항목.xlsx');
    expect(file.data.subarray(0, 2).toString('latin1')).toBe('PK');
    const parsed = await readTabularFile(file.data, file.fileName);
    const text = JSON.stringify(parsed.sheets[0]!.rows);
    expect(text).toContain('사유');
    expect(text).not.toContain('4111-1111-1111-1111');
    const [a] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, importJobId), eq(auditLogs.action, 'import.error_report.download')));
    expect(a!.category).toBe('download');
  });

  it('rejects the same file for the same client with a link to the previous import, unless force', async () => {
    const data = await toXlsxBuffer([{ name: '카드', rows: cardFileRows(client.businessNumber) }]);
    const err = await expectAppError(uploadImportFile(ctx, { fileName: '다시올림.xlsx', data, channel: 'manual_upload' }), 'IMPORT_DUPLICATE_FILE');
    expect(err).toBeInstanceOf(DuplicateImportFileError);
    expect(err.httpStatus).toBe(409);
    expect(err.userMessage).toContain('이미 가져온 파일입니다');
    expect(err.action).toEqual({ label: '이전 가져오기 보기', href: `/imports/${importJobId}` });

    const forced = await uploadImportFile(ctx, { fileName: '다시올림.xlsx', data, channel: 'manual_upload', force: true });
    expect(forced.status).toBe('queued');
    const before = (await db.select().from(jobs).where(eq(jobs.type, 'classify_batch'))).length;
    const { res } = await runJob(forced.jobId!);
    // 모든 행이 기존 거래와 같아 중복 — 거래가 늘지 않는다 (삭제도 하지 않는다)
    expect(res.result).toMatchObject({ totalRows: 7, importedRows: 0, duplicateRows: 5, failedRows: 2 });
    const dups = await db.select().from(transactions).where(eq(transactions.importJobId, forced.importJobId));
    expect(dups.every((t) => t.status === 'duplicate' && t.duplicateOfId)).toBe(true);
    // 새 거래가 없으면 분류 작업을 만들지 않는다
    expect((await db.select().from(jobs).where(eq(jobs.type, 'classify_batch'))).length).toBe(before);
  });

  it('flags duplicates across two files / channels (fingerprint) and keeps new rows', async () => {
    const rows = [
      CARD_HEADER_APV,
      card('2026-09-01', CARD1, VENDOR_B, 9091, 909, 10000, '일반과세자', '30000001'),
      card('2026-09-20', CARD1, VENDOR_B, 2728, 272, 3000, '일반과세자', '30000020'),
    ];
    const r = await uploadImportFile(ctx, { fileName: 'wemembers_카드.csv', data: toCsvBuffer(rows, 'cp949'), channel: 'wemembers_file', clientId: client.id });
    expect(r.status).toBe('queued');
    expect(r.detected.clientAutoDetected).toBe(false);
    const { res } = await runJob(r.jobId!);
    expect(res.result).toMatchObject({ totalRows: 2, importedRows: 1, duplicateRows: 1, failedRows: 0 });
    expect(res.status).toBe('succeeded');
    const txs = await db.select().from(transactions).where(eq(transactions.importJobId, r.importJobId));
    const dup = txs.find((t) => t.status === 'duplicate')!;
    const [orig] = await db.select().from(transactions).where(eq(transactions.id, dup.duplicateOfId!));
    expect(orig!.importJobId).toBe(importJobId);
    expect(dup.duplicateReason).toContain('이미 등록된 거래');
  });

  it('WEHAGO double-booking guard: same 일자·사업자번호·금액·과세유형 as an already-exported tx from another channel → duplicate', async () => {
    // 1차 파일의 09-02 오피스디포 22,000원 거래를 WEHAGO 로 전송된 것으로 표시
    const [exported] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.importJobId, importJobId), eq(transactions.transactionDate, '2026-09-02')));
    await db.update(transactions).set({ status: 'exported' }).where(eq(transactions.id, exported!.id));

    // 다른 카드번호(→ 다른 fingerprint)로 홈택스 원본이 다시 들어옴
    const rows = [
      CARD_HEADER_APV,
      card('2026-09-02', CARD2, VENDOR_A, 20000, 2000, 22000, '일반과세자', '77000002'),
      card('2026-09-21', CARD2, VENDOR_A, 3000, 300, 3300, '일반과세자', '77000021'),
    ];
    const r = await uploadImportFile(ctx, { fileName: '홈택스_카드.csv', data: toCsvBuffer(rows), channel: 'hometax_file', clientId: client.id });
    const { res } = await runJob(r.jobId!);
    expect(res.result).toMatchObject({ totalRows: 2, importedRows: 1, duplicateRows: 1, wehagoDuplicateRows: 1 });
    const txs = await db.select().from(transactions).where(eq(transactions.importJobId, r.importJobId));
    const flagged = txs.find((t) => t.status === 'duplicate')!;
    expect(flagged.duplicateReason).toBe(WEHAGO_DUPLICATE_REASON);
    expect(flagged.duplicateOfId).toBe(exported!.id);
    expect(flagged.fingerprint).not.toBe(exported!.fingerprint);
    expect(flagged.buckets).toEqual(['duplicate']);
    expect(flagged.riskFlags[0]!.ruleCode).toBe('IMPORT_WEHAGO_DOUBLE_BOOKING');
    const [src] = await db.select().from(transactionSources).where(eq(transactionSources.transactionId, flagged.id));
    expect(src!.outcome).toBe('duplicate');
    expect(src!.errorReason).toBe(WEHAGO_DUPLICATE_REASON);
    const [n] = await db.select().from(notifications).where(eq(notifications.dedupeKey, `import_wehago_dup:${r.importJobId}`));
    expect(n!.title).toContain('WEHAGO 이중 기장 의심 1건');
    const d = await getImportJob(ctx, r.importJobId);
    expect(d.wehagoDuplicateRows).toBe(1);
  });
});

describe('사람 확인이 필요한 경우만 묻는다', () => {
  it('needs_client when the file has no client evidence → confirmImport → processed', async () => {
    const rows = [CARD_HEADER, card('2026-09-11', CARD1, VENDOR_C, 1000, 100, 1100)];
    const r = await uploadImportFile(ctx, { fileName: 'card.csv', data: toCsvBuffer(rows), channel: 'manual_upload' });
    expect(r.status).toBe('needs_client');
    expect(r.jobId).toBeNull();
    expect(r.detected.clientId).toBeNull();
    expect(r.detected.profileKey).toBe('hometax_card_purchase_v1');
    const pending = await getImportJob(ctx, r.importJobId);
    expect(pending.state).toBe('needs_client');
    expect(pending.summary).toContain('수임처 확인 필요');
    // 사람이 화면에 있으므로 알림은 만들지 않는다
    expect(await db.select().from(notifications).where(eq(notifications.dedupeKey, `import_needs_client:${r.importJobId}`))).toHaveLength(0);

    const c = await confirmImport(ctx, { importJobId: r.importJobId, clientId: client.id });
    expect(c.status).toBe('queued');
    expect(c.jobId).toBeTruthy();
    const { res } = await runJob(c.jobId!);
    expect(res.result).toMatchObject({ totalRows: 1, importedRows: 1 });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, r.importJobId), eq(auditLogs.action, 'import.confirm')));
    expect(audit[0]!.summary).toContain('수임처 지정');
    // 같은 파일을 다시 보내면(수임처 근거가 없어도) 이미 가져온 가져오기로 연결 — 다시 묻지 않는다
    const again = await expectAppError(uploadImportFile(ctx, { fileName: 'card (1).csv', data: toCsvBuffer(rows), channel: 'manual_upload' }), 'IMPORT_DUPLICATE_FILE');
    expect(again.action?.href).toBe(`/imports/${r.importJobId}`);
  });

  it('needs_mapping for an unknown layout (import_failed notification) → column mapping → processed', async () => {
    const r = await uploadImportFile(ctx, { fileName: '기타자료.csv', data: toCsvBuffer(genericRows()), channel: 'manual_upload', clientId: client.id });
    expect(r.status).toBe('needs_mapping');
    expect(r.jobId).toBeNull();
    expect(r.message).toContain('첫 줄 제목: 날짜, 거래처, 금액, 메모');
    const [n] = await db.select().from(notifications).where(eq(notifications.dedupeKey, `import_failed:${r.importJobId}`));
    expect(n!.title).toContain('서식 확인 필요');
    const det = await getImportDetection(ctx, r.importJobId);
    expect(det.headerRow).toEqual(['날짜', '거래처', '금액', '메모']);
    expect(det.detection.requiresUserMapping).toBe(true);

    const c = await confirmImport(ctx, {
      importJobId: r.importJobId,
      mapping: { columns: { transactionDate: '날짜', merchantName: '거래처', totalAmount: '금액', description: '메모' }, direction: 'purchase', evidenceType: 'other' },
    });
    expect(c.status).toBe('queued');
    const { res } = await runJob(c.jobId!);
    expect(res.result).toMatchObject({ totalRows: 2, importedRows: 2, failedRows: 0 });
    const [resolved] = await db.select().from(notifications).where(eq(notifications.dedupeKey, `import_failed:${r.importJobId}`));
    expect(resolved!.resolvedAt).not.toBeNull();
  });

  it('rejects a WEHAGO ledger (reconciliation) file, PDFs, and a mismatching client with actionable Korean messages', async () => {
    const ledger = await toXlsxBuffer([{ name: '매입매출장', rows: wehagoLedgerRows() }]);
    const e1 = await expectAppError(uploadImportFile(ctx, { fileName: '매입매출장.xlsx', data: ledger, channel: 'manual_upload', clientId: client.id }), 'IMPORT_WRONG_PURPOSE');
    expect(e1.userMessage).toContain('대사');
    expect(e1.action?.href).toBe('/transfer');

    const e2 = await expectAppError(uploadImportFile(ctx, { fileName: '고지서.pdf', data: Buffer.from('%PDF-1.4 test'), channel: 'manual_upload' }), 'IMPORT_PDF_NOT_TABULAR');
    expect(e2.userMessage).toContain('PDF');

    // 정직한 연동 상태: 위멤버스 API 는 NOT_AVAILABLE, Bridge 경로는 Bridge 전용
    await expectAppError(uploadImportFile(ctx, { fileName: 'a.xlsx', data: ledger, channel: 'wemembers_api' }), 'IMPORT_CHANNEL_NOT_AVAILABLE');
    await expectAppError(uploadImportFile(ctx, { fileName: 'a.xlsx', data: ledger, channel: 'desktop_bridge' }), 'IMPORT_CHANNEL_BRIDGE_ONLY');

    const other = await createTestClient(db, { name: '다른수임처' });
    const data = await toXlsxBuffer([{ name: '카드', rows: [...cardFileRows(client.businessNumber).slice(0, 3)] }]);
    const e3 = await expectAppError(uploadImportFile(ctx, { fileName: 'x.xlsx', data, channel: 'manual_upload', clientId: other.id }), 'IMPORT_CLIENT_MISMATCH');
    expect(e3.userMessage).toContain('(주)민택스수집');
  });

  it('enforces imports.create', async () => {
    const viewer = await createTestUser(db, 'viewer', '조회자');
    const vctx = testContext(db, viewer.actor);
    await expect(uploadImportFile(vctx, { fileName: 'a.csv', data: Buffer.from('a'), channel: 'manual_upload' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listImportJobs(vctx, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('registers the import_file handler', () => {
    registerImportsJobHandlers();
    expect(getJobHandler('import_file')).toBe(runImportFileJob);
  });
});

describe('성능 — 10,000행 한 달치', () => {
  it('uploads and processes 10,000 rows in chunks', async () => {
    const big = await createTestClient(db, { name: '대용량상사' });
    const rows: Row[] = [CARD_HEADER];
    for (let i = 0; i < 10_000; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      const supply = 1000 + i;
      rows.push(card(`2026-09-${day}`, CARD1, i % 2 === 0 ? VENDOR_A : VENDOR_B, supply, Math.trunc(supply / 10), supply + Math.trunc(supply / 10)));
    }
    const data = toCsvBuffer(rows);
    const t0 = Date.now();
    const r = await uploadImportFile(ctx, { fileName: 'big.csv', data, channel: 'manual_upload', clientId: big.id });
    const tUpload = Date.now() - t0;
    const { res, calls } = await runJob(r.jobId!);
    const tTotal = Date.now() - t0;
    expect(res.result).toMatchObject({ totalRows: 10_000, importedRows: 10_000, failedRows: 0 });
    expect(calls.length).toBeGreaterThan(10);
    const [{ n } = { n: 0 }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from transaction_sources where import_job_id = ${r.importJobId}`)).rows;
    expect(n).toBe(10_000);
    console.info(`[perf] 10,000행: 업로드(판정) ${tUpload}ms, 전체 ${tTotal}ms`);
    expect(tTotal).toBeLessThan(90_000);
  });
});

// ────────────────────────────── Desktop Bridge ──────────────────────────────

const cardRows = (bizno: string, day: string) => [
  ['사업용 신용카드 매입내역', `사업자등록번호 ${dashed(bizno)}`],
  CARD_HEADER,
  [`2026-09-${day}`, '비씨카드', '4111-1111-1111-1111', dashed(VENDOR_B.bizno), VENDOR_B.name, 9091, 909, 0, 10000, '일반과세자', '음식', '커피', '공제', ''],
];

describe('Bridge 토큰 · 업로드 · 결과 받기', () => {
  let admin: ServiceContext;
  let staff: ServiceContext;
  let bclient: { id: string; businessNumber: string; code: string; name: string };
  let token = '';
  let tokenId = '';

  beforeAll(async () => {
    admin = testContext(db, (await createTestUser(db, 'admin', '관리자')).actor);
    staff = ctx;
    bclient = await createTestClient(db, { name: '(주)브릿지상사' });
  });
  beforeEach(() => resetBridgeRateLimits());

  it('admin issues a token once; only an HMAC hash is stored; integration status is FILE_BASED', async () => {
    await expect(createBridgeToken(staff, { name: 'PC-회계1' })).rejects.toBeInstanceOf(ForbiddenError);
    const t = await createBridgeToken(admin, { name: 'PC-회계1' });
    token = t.token;
    tokenId = t.id;
    expect(token.startsWith(`mtb1.${t.id}.`)).toBe(true);
    expect(t.active).toBe(true);

    const [conn] = await db.select().from(integrationConnections).where(eq(integrationConnections.key, 'desktop_bridge'));
    expect(conn!.status).toBe('FILE_BASED');
    const cfg = JSON.stringify(conn!.config);
    expect(cfg).not.toContain(token);
    expect(cfg).not.toContain(token.split('.')[2]!);
    expect(cfg).toMatch(/"hash":"[0-9a-f]{64}"/);

    const [a] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'bridge.token.create'));
    expect(a!.category).toBe('security');
    expect(JSON.stringify(a!.afterData)).not.toContain(token.split('.')[2]!);
    expect(JSON.stringify(a!.afterData)).not.toContain('hash');

    const list = await listBridgeTokens(staff);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token.split('.')[2]!);
  });

  it('verifyBridgeToken → least-privilege system actor "Desktop Bridge (<name>)"; bad tokens → 401', async () => {
    const actor = await verifyBridgeToken(db, token);
    expect(actor.kind).toBe('system');
    expect(actor.name).toBe('Desktop Bridge (PC-회계1)');
    expect(actor.permissions.has('imports.create')).toBe(true);
    expect(actor.permissions.has('export.download')).toBe(true);
    expect(actor.permissions.has('settings.write')).toBe(false);
    expect(actor.permissions.has('transactions.review')).toBe(false);

    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    const e = await verifyBridgeToken(db, tampered).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BridgeAuthError);
    expect((e as AppError).httpStatus).toBe(401);
    await expect(verifyBridgeToken(db, 'garbage')).rejects.toBeInstanceOf(BridgeAuthError);

    const [conn] = await db.select().from(integrationConnections).where(eq(integrationConnections.key, 'desktop_bridge'));
    const stored = (conn!.config as { tokens: Array<{ lastUsedAt: string | null }> }).tokens[0]!;
    expect(stored.lastUsedAt).not.toBeNull();
  });

  it('bridgeUpload = uploadImportFile with channel desktop_bridge / download_watch; resend of the same file → duplicate (success)', async () => {
    const data = await toXlsxBuffer([{ name: '카드', rows: cardRows(bclient.businessNumber, '03') }]);
    const r = await bridgeUpload(db, token, { fileName: '카드_202609.xlsx', data, sourcePath: 'C:\\Users\\홍길동\\문서\\MIN TAX OPS\\01_수신대기\\카드_202609.xlsx', sourceFolder: 'inbox' });
    expect(r.status).toBe('accepted');
    expect(r.jobId).toBeTruthy();
    expect(r.detected?.clientId).toBe(bclient.id);
    const [ij] = await db.select().from(importJobs).where(eq(importJobs.id, r.importJobId));
    expect(ij!.channel).toBe('desktop_bridge');
    expect(ij!.createdBy).toBeNull();
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, r.importJobId), eq(auditLogs.action, 'import.upload')));
    expect(audit!.actorName).toBe('Desktop Bridge (PC-회계1)');
    // PC 경로(사용자명)는 남기지 않고 파일명만
    expect(JSON.stringify(audit!.afterData)).not.toContain('홍길동');
    expect(JSON.stringify(audit!.afterData)).toContain('카드_202609.xlsx');

    const again = await bridgeUpload(db, token, { fileName: '카드_202609 (1).xlsx', data, sourceFolder: 'inbox' });
    expect(again.status).toBe('duplicate');
    expect(again.importJobId).toBe(r.importJobId);
    expect(again.href).toBe(`/imports/${r.importJobId}`);

    const dl = await toXlsxBuffer([{ name: '카드', rows: cardRows(bclient.businessNumber, '04') }]);
    const r2 = await bridgeUpload(db, token, { fileName: '다운로드.xlsx', data: dl, sourceFolder: 'downloads' });
    const [ij2] = await db.select().from(importJobs).where(eq(importJobs.id, r2.importJobId));
    expect(ij2!.channel).toBe('download_watch');
  });

  it('unattended upload without client evidence → needs_client + import_failed notification (no human at the PC)', async () => {
    const data = toCsvBuffer([CARD_HEADER, ['2026-09-09', '비씨카드', '', dashed(VENDOR_B.bizno), VENDOR_B.name, 1000, 100, 0, 1100, '', '', '', '공제', '']]);
    const r = await bridgeUpload(db, token, { fileName: 'card.csv', data, sourceFolder: 'inbox' });
    expect(r.status).toBe('needs_client');
    const [n] = await db.select().from(notifications).where(eq(notifications.dedupeKey, `import_needs_client:${r.importJobId}`));
    expect(n!.kind).toBe('import_failed');
    expect(n!.href).toBe(`/imports/${r.importJobId}`);
  });

  it('bridgeResults lists ready WEHAGO export files (MOCK_/_검증필요 names); bridgeDownloadResult marks downloaded + audits', async () => {
    const payload = Buffer.from('fake-wehago-xlsx-content');
    const stored = await storeFile(staff, { data: payload, originalName: '브릿지상사_202609_매입매출.xlsx', purpose: 'wehago_export', clientId: bclient.id });
    const [ready] = await db
      .insert(exportJobs)
      .values({
        clientId: bclient.id,
        period: '2026-09',
        kind: 'wehago_purchase_sales',
        templateKey: 'wehago_purchase_sales_standard',
        templateVersion: '20260926-standard',
        status: 'ready',
        fileId: stored.id,
        rowCount: 12,
        totalAmount: 123_000,
        validation: { verified: false },
      })
      .returning({ id: exportJobs.id });
    await db.insert(exportJobs).values({ clientId: bclient.id, period: '2026-09', kind: 'wehago_purchase_sales', templateKey: 'x', templateVersion: 'v', status: 'blocked' });

    const res = await bridgeResults(db, token, null);
    expect(res).toHaveLength(1);
    const item = res[0]!;
    expect(item).toMatchObject({ exportJobId: ready!.id, clientName: '(주)브릿지상사', period: '2026-09', mock: false, verified: false, sha256: stored.sha256 });
    expect(item.suggestedFileName).toBe('브릿지상사_202609_매입매출_검증필요.xlsx');
    expect(typeof item.createdAt).toBe('string');
    const later = await bridgeResults(db, token, new Date(Date.now() + 60_000).toISOString());
    expect(later).toHaveLength(0);
    await expect(bridgeResults(db, token, 'not-a-date')).rejects.toBeInstanceOf(AppError);

    const file = await bridgeDownloadResult(db, token, ready!.id);
    expect(file.data.equals(payload)).toBe(true);
    expect(file.sha256).toBe(stored.sha256);
    const [after] = await db.select().from(exportJobs).where(eq(exportJobs.id, ready!.id));
    expect(after!.status).toBe('downloaded');
    expect(after!.downloadedAt).not.toBeNull();
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, ready!.id), eq(auditLogs.action, 'export.download')));
    expect(a!.category).toBe('download');
    expect(a!.actorName).toBe('Desktop Bridge (PC-회계1)');
    expect(await bridgeResults(db, token, null)).toHaveLength(0);
  });

  it('rate-limits per token (429 with Korean message)', async () => {
    resetBridgeRateLimits({ requestsPerMinute: 3 });
    await verifyBridgeToken(db, token);
    await verifyBridgeToken(db, token);
    await verifyBridgeToken(db, token);
    const e = await verifyBridgeToken(db, token).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).httpStatus).toBe(429);
    expect((e as RateLimitError).userMessage).toContain('Bridge');
    // 다른 토큰은 영향 없음
    const other = await createBridgeToken(admin, { name: 'PC-회계2' });
    await expect(verifyBridgeToken(db, other.token)).resolves.toBeTruthy();
  });

  it('revoked token → 401 device_revoked; last active token revoked → NOT_AVAILABLE', async () => {
    const tokens = await listBridgeTokens(staff);
    for (const t of tokens) await revokeBridgeToken(admin, t.id);
    const e = await verifyBridgeToken(db, token).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BridgeAuthError);
    expect((e as AppError).code).toBe('device_revoked');
    const [conn] = await db.select().from(integrationConnections).where(eq(integrationConnections.key, 'desktop_bridge'));
    expect(conn!.status).toBe('NOT_AVAILABLE');
    await expect(revokeBridgeToken(admin, tokenId)).rejects.toBeInstanceOf(AppError);
    await expect(revokeBridgeToken(staff, tokenId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
