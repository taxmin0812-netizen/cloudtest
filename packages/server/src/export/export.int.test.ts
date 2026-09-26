/**
 * WEHAGO Bridge · 대사 · 전송센터 통합 테스트 — 실제 PostgreSQL (mintax_test_export).
 * DATABASE_URL_TEST=postgres://mintax:mintax_dev@localhost:5432/mintax_test_export npx vitest run --project integration packages/server/src/export
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.MINTAX_DATA_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.MINTAX_INDEX_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.STORAGE_LOCAL_DIR = mkdtempSync(path.join(os.tmpdir(), 'mintax-export-'));

/** 1원 게이트 시험용: adapters 의 writeWehagoExport 를 감싸 켜면 첫 행 부가세·합계를 1원 줄인 파일을 만든다 (서식 렌더링 오류 모사) */
const tamper = vi.hoisted(() => ({ on: false }));

vi.mock('@mintax/adapters', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@mintax/adapters')>();
  return {
    ...mod,
    writeWehagoExport: async (...args: Parameters<typeof mod.writeWehagoExport>) => {
      const [template, rows, meta] = args;
      if (!tamper.on) return mod.writeWehagoExport(template, rows, meta);
      // 렌더링 버그 모사: 첫 행 부가세·합계가 1원 적게 기록된 파일
      const bad = rows.map((r, i) => (i === 0 ? { ...r, vatAmount: r.vatAmount - 1, totalAmount: r.totalAmount - 1 } : r));
      return mod.writeWehagoExport(template, bad, meta);
    },
  };
});


import { and, eq, like, sql } from 'drizzle-orm';
import { auditLogs, closeDb, exportItems, exportJobs, files, notifications, reconciliationJobs, settings, setupTestDatabase, transactions, type Database } from '@mintax/db';
import { readTabularFile, WEHAGO_PURCHASE_SALES_TEMPLATE } from '@mintax/adapters';
import { CUSTOMER_A, LEDGER_HEADER, VENDOR_A, VENDOR_B, VENDOR_C, dashed, makeBizNo, toXlsxBuffer } from '@mintax/adapters/__fixtures__/builders';
import { AppError, ForbiddenError, ValidationError } from '@mintax/security';
import type { ServiceContext } from '../context';
import { enqueueJob, getJob } from '../jobs/queue';
import { getJobHandler } from '../jobs/registry';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import { getReconciliation, listReconciliations, registerReconciliationJobHandlers, runReconciliation } from '../reconciliation';
import { getTransferBoard, prepareTransferBatch } from '../transfer';
import {
  DEFAULT_TEMPLATE_WARNING,
  OFFICE_TEMPLATE_WARNING,
  confirmWehagoUpload,
  downloadExport,
  getActiveTemplate,
  getExportJob,
  importWehagoLedger,
  listExportJobs,
  listUnmappedPartners,
  prepareClientExports,
  prepareWehagoExport,
  previewWehagoTemplate,
  registerExportJobHandlers,
  registerWehagoTemplate,
  resetWehagoTemplate,
  runExportBatch,
  saveWehagoPartnerCodes,
  type PrepareExportBlocked,
  type PrepareExportReady,
  type PrepareExportResult,
} from './index';
import { seedPeriod, setRuleParams, type TxSpec } from './test-fixtures';

const P = '2026-09';
let db: Database;
let staff: ServiceContext;
let admin: ServiceContext;
let viewer: ServiceContext;
let staffId: string;

function ready(r: PrepareExportResult): PrepareExportReady {
  if (r.status !== 'ready') throw new Error(`expected ready, got blocked: ${JSON.stringify((r as PrepareExportBlocked).reasons)}`);
  return r;
}
function blocked(r: PrepareExportResult): PrepareExportBlocked {
  if (r.status !== 'blocked') throw new Error(`expected blocked, got ready: ${r.summary}`);
  return r;
}

const card = (date: string, v: { name: string; bizno: string }, supply: number, vat: number, extra: Partial<TxSpec> = {}): TxSpec => ({ date, merchant: v.name, bizno: v.bizno, supply, vat, ...extra });

async function partnerCodes(clientId: string, entries: Array<[{ name: string; bizno: string }, string]>) {
  await saveWehagoPartnerCodes(staff, { clientId, entries: entries.map(([v, code]) => ({ businessNumber: v.bizno, merchantName: v.name, code })) });
}

function ledgerRow(date: string, code: string, partner: string, v: { name: string; bizno: string }, supply: number, vat: number, debit: string, credit: string, mgmt: string): unknown[] {
  return [date, code, partner, v.name, dashed(v.bizno), '', supply, vat, supply + vat, debit, credit, mgmt, '승인'];
}

async function ledgerFile(rows: unknown[][]): Promise<Buffer> {
  return toXlsxBuffer([{ name: '매입매출장', rows: [['매입매출장'], LEDGER_HEADER, ...rows] }]);
}

/** 준비 → 받기 → 업로드 확인 */
async function exportAndConfirm(clientId: string): Promise<PrepareExportReady> {
  const r = ready(await prepareWehagoExport(staff, { clientId, period: P, kind: 'wehago_purchase_sales' }));
  await downloadExport(staff, r.exportJobId);
  await confirmWehagoUpload(staff, r.exportJobId);
  return r;
}

async function clearTemplateVerification() {
  await db.delete(settings).where(like(settings.key, 'wehago_template_verified:%'));
}

beforeAll(async () => {
  db = await setupTestDatabase();
  const s = await createTestUser(db, 'staff', '이세무');
  const a = await createTestUser(db, 'admin', '김관리');
  const v = await createTestUser(db, 'viewer', '조회자');
  staffId = s.id;
  staff = testContext(db, s.actor);
  admin = testContext(db, a.actor);
  viewer = testContext(db, v.actor);
  registerExportJobHandlers();
});

afterAll(async () => {
  await closeDb();
});

describe('WEHAGO 전송파일 end-to-end', () => {
  let client: { id: string; businessNumber: string; code: string; name: string };
  let result: PrepareExportReady;
  let txIds: string[];

  it('승인 거래 → 거래처코드 미연결이면 차단 → 연결 후 전송준비(ready) · 재검증 통과 · Source vs Export 일치', async () => {
    client = await createTestClient(db, { name: '에이플러스디자인' });
    const seeded = await seedPeriod(db, client, P, [
      card('2026-09-01', VENDOR_B, 9091, 909),
      card('2026-09-05', VENDOR_A, 20000, 2000, { status: 'approved', reviewedBy: staffId, accountCode: '830', accountName: '소모품비' }),
      { date: '2026-09-11', merchant: CUSTOMER_A.name, bizno: CUSTOMER_A.bizno, direction: 'sales', evidenceType: 'tax_invoice', supply: 500000, vat: 50000 },
      { date: '2026-09-12', merchant: 'ABC마트', bizno: VENDOR_C.bizno, supply: 29546, vat: 2954, status: 'duplicate', duplicateReason: '같은 자료의 1행과 같아 중복으로 판정했습니다' },
      { date: '2026-09-15', merchant: '개인용품점', supply: 1000, vat: 100, status: 'excluded', excludedReason: '대표자 개인 사용' },
    ]);
    txIds = seeded.txIds;

    await expect(prepareWehagoExport(viewer, { clientId: client.id, period: P, kind: 'wehago_purchase_sales' })).rejects.toBeInstanceOf(ForbiddenError);

    const b = blocked(await prepareWehagoExport(staff, { clientId: client.id, period: P, kind: 'wehago_purchase_sales' }));
    expect(b.reasons.map((r) => r.code)).toEqual(['missing_counterparty_code']);
    expect(b.reasons[0]!.message).toContain('WEHAGO 거래처코드가 연결되지 않은 거래처 3곳(3건)');
    expect(b.reasons[0]!.href).toBe(`/transfer/partners?client=${client.id}&period=${P}`);
    expect(await listUnmappedPartners(staff, { clientId: client.id, period: P })).toHaveLength(3);

    await partnerCodes(client.id, [
      [VENDOR_B, '00101'],
      [VENDOR_A, '00102'],
      [CUSTOMER_A, '00201'],
    ]);
    result = ready(await prepareWehagoExport(staff, { clientId: client.id, period: P, kind: 'wehago_purchase_sales' }));
    // 차단 기록은 이력으로 남고, 준비 완료 파일은 새 행(v1)이다
    expect(result.exportJobId).not.toBe(b.exportJobId);
    expect(result.version).toBe(1);
    expect(result.fileName).toBe(`${client.code}_에이플러스디자인_2026-09_매입매출.xlsx`);
    expect(result.rowCount).toBe(3);
    expect(result.totals).toEqual({ count: 3, supplyAmount: 529091, vatAmount: 52909, totalAmount: 582000 });
    expect(result.comparison.match).toBe(true);
    expect(result.comparison.source).toEqual(result.comparison.export);
    expect(result.comparison.byEvidenceType.map((r) => [r.key, r.source.count, r.export.count, r.match])).toEqual([
      ['card', 2, 2, true],
      ['tax_invoice', 1, 1, true],
    ]);
    expect(result.comparison.byAccount.map((r) => r.key)).toEqual(['401', '811', '830']);
    expect(result.warnings).toContain(DEFAULT_TEMPLATE_WARNING);
    expect(result.warnings.join(' ')).toContain('이중 기장 주의');
    expect(result.template).toMatchObject({ source: 'default', verified: false, warning: DEFAULT_TEMPLATE_WARNING });
    expect(result.integrationStatus).toBe('FILE_BASED');
    expect(result.nextStep).toContain('WEHAGO 전표 API가 없어');

    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, result.exportJobId));
    expect(job).toMatchObject({ status: 'ready', rowCount: 3, supplyAmount: 529091, vatAmount: 52909, totalAmount: 582000, kind: 'wehago_purchase_sales' });
    expect(job!.fileId).not.toBeNull();
    const v = job!.validation as { comparison: { match: boolean }; verify: { ok: boolean; summary: string } };
    expect(v.comparison.match).toBe(true);
    expect(v.verify.ok).toBe(true);
    expect(v.verify.summary).toContain('1원 단위 일치');
    const items = await db.select().from(exportItems).where(eq(exportItems.exportJobId, result.exportJobId));
    expect(items).toHaveLength(3);
    expect(items.reduce((s, i) => s + i.totalAmount, 0)).toBe(582000);

    const txs = await db.select().from(transactions).where(eq(transactions.clientId, client.id));
    const inFile = txs.filter((t) => t.exportJobId === result.exportJobId);
    expect(inFile.map((t) => t.id).sort()).toEqual(txIds.slice(0, 3).sort());
    // 파일 생성만으로 거래 상태를 바꾸지 않는다 (업로드 확인 때 exported)
    expect(inFile.map((t) => t.status).sort()).toEqual(['approved', 'auto_approved', 'auto_approved']);
    expect(txs.find((t) => t.status === 'duplicate')!.exportJobId).toBeNull();

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, result.exportJobId), eq(auditLogs.action, 'export.create')));
    expect(audit[0]!.summary).toContain('에이플러스디자인 2026-09 WEHAGO 매입매출 전송파일 v1 생성');
    expect(audit[0]!.actorName).toBe('이세무');
  });

  it('대사 보고서: 중복·제외를 정확한 한국어로 설명하고 단계 합계를 보여준다', async () => {
    const pre = await getReconciliation(staff, result.preReconciliationId);
    expect(pre.phase).toBe('pre_export');
    expect(pre.mode).toBe('ready');
    expect(pre.exportAllowed).toBe(true);
    expect(pre.balanced).toBe(true);
    const dup = pre.discrepancies.find((d) => d.kind === 'duplicate_excluded')!;
    expect(dup.message.startsWith('2026-09-12 ABC마트 32,500원 거래가 중복판정으로 제외되었습니다.')).toBe(true);
    expect(dup.blocking).toBe(false);
    const exc = pre.discrepancies.find((d) => d.kind === 'user_excluded')!;
    expect(exc.message).toBe('2026-09-15 개인용품점 1,100원 거래가 사용자에 의해 제외되었습니다. 사유: 대표자 개인 사용');
    expect(pre.stageLine).toBe('위멤버스(원본) 5건 / MIN TAX OPS 4건 / 전송준비 3건');

    const file = await getReconciliation(staff, result.reconciliationId);
    expect(file.mode).toBe('file');
    expect(file.exportJobId).toBe(result.exportJobId);
    expect(file.exportAllowed).toBe(true);
    expect(file.stageLine).toBe('위멤버스(원본) 5건 / MIN TAX OPS 4건 / 전송파일 3건');
    expect(file.equation.residual).toEqual({ count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0 });
    const list = await listReconciliations(staff, { clientId: client.id, period: P });
    expect(list.length).toBeGreaterThanOrEqual(3);
    await expect(getReconciliation(viewer, result.reconciliationId)).resolves.toMatchObject({ id: result.reconciliationId });
  });

  it('다운로드: 파일명·내용 확인, 다운로드 감사(download), downloaded 상태', async () => {
    await expect(downloadExport(viewer, result.exportJobId)).rejects.toBeInstanceOf(ForbiddenError);
    const d = await downloadExport(staff, result.exportJobId);
    expect(d.fileName).toBe(`${client.code}_에이플러스디자인_2026-09_매입매출.xlsx`);
    expect(d.mimeType).toContain('spreadsheetml');
    const f = await readTabularFile(d.data, d.fileName);
    const sheet = f.sheets.find((s) => !s.hidden)!;
    expect(sheet.rows[0]).toEqual(WEHAGO_PURCHASE_SALES_TEMPLATE.columns.map((c) => c.header));
    expect(sheet.rows.slice(1).filter((r) => r.some((c) => c !== null && c !== ''))).toHaveLength(3);
    expect(d.exportJob.status).toBe('downloaded');
    expect(d.exportJob.downloadedAt).not.toBeNull();
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, result.exportJobId), eq(auditLogs.action, 'export.download')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.category).toBe('download');
    expect(audit[0]!.summary).toContain('전송파일 다운로드');
  });

  it('업로드 완료 확인 (FILE_BASED): 거래 → exported, 감사로그', async () => {
    const r = await confirmWehagoUpload(staff, result.exportJobId);
    expect(r.alreadyConfirmed).toBe(false);
    expect(r.transactionsExported).toBe(3);
    expect(r.integrationStatus).toBe('FILE_BASED');
    expect(r.note).toContain('WEHAGO 전표 API가 없어');
    expect(r.exportJob.status).toBe('uploaded_confirmed');
    const txs = await db.select().from(transactions).where(eq(transactions.exportJobId, result.exportJobId));
    expect(txs.every((t) => t.status === 'exported')).toBe(true);
    const again = await confirmWehagoUpload(staff, result.exportJobId);
    expect(again.alreadyConfirmed).toBe(true);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, result.exportJobId), eq(auditLogs.action, 'export.confirm_upload')));
    expect(audit).toHaveLength(1);
  });

  it('WEHAGO 매입매출장 역수입 일치 → reconciled, 서식 검증 기록', async () => {
    const buf = await ledgerFile([
      ledgerRow('2026-09-01', '57', '00101', VENDOR_B, 9091, 909, '811 복리후생비', '253 미지급금', 'M1'),
      ledgerRow('2026-09-05', '57.카과', '00102', VENDOR_A, 20000, 2000, '830 소모품비', '253 미지급금', 'M2'),
      ledgerRow('2026-09-11', '11', '00201', CUSTOMER_A, 500000, 50000, '108 외상매출금', '401 상품매출', 'M3'),
    ]);
    const r = await importWehagoLedger(staff, { clientId: client.id, period: P, fileName: 'WEHAGO_매입매출장_202609.xlsx', data: buf });
    expect(r.ledger.failures).toEqual([]);
    expect(r.ledger.rows).toBe(3);
    expect(r.matched).toBe(true);
    expect(r.transactionsReconciled).toBe(3);
    expect(r.exportJobId).toBe(result.exportJobId);
    expect(r.summary).toContain('1원 단위까지 일치');
    const txs = await db.select().from(transactions).where(eq(transactions.exportJobId, result.exportJobId));
    expect(txs.every((t) => t.status === 'reconciled')).toBe(true);
    const rec = await getReconciliation(staff, r.reconciliationId);
    expect(rec.phase).toBe('post_export');
    expect(rec.exportAllowed).toBe(true);
    expect(rec.wehagoMatched).toBe(true);
    expect(rec.stageLine).toBe('위멤버스(원본) 5건 / MIN TAX OPS 4건 / 전송파일 3건 / WEHAGO 3건');
    const t = await getActiveTemplate(staff, 'wehago_purchase_sales');
    expect(t.verified).toBe(true); // 역수입 1원 일치 = 서식 검증
    expect(t.warning).toBeNull();

    // 다시 대사(post_export): 저장된 역수입 파일을 다시 읽어 같은 결과
    const again = await runReconciliation(staff, { clientId: client.id, period: P, phase: 'post_export' });
    expect(again.exportAllowed).toBe(true);
    await clearTemplateVerification();
  });
});

describe('전송 차단 (사전검증)', () => {
  it('검토 대기가 남아 있으면 차단 — "검토 대기 3건이 남아 있습니다 [3건 검토하기]"', async () => {
    const c = await createTestClient(db, { name: '미소카페' });
    await seedPeriod(db, c, P, [
      card('2026-09-02', VENDOR_B, 4546, 454),
      card('2026-09-03', VENDOR_A, 1000, 100),
      card('2026-09-04', VENDOR_A, 2000, 200, { status: 'needs_review' }),
      card('2026-09-05', VENDOR_A, 3000, 300, { status: 'needs_review' }),
      card('2026-09-06', VENDOR_C, 4000, 400, { status: 'classified' }),
    ]);
    await partnerCodes(c.id, [
      [VENDOR_A, '00102'],
      [VENDOR_B, '00101'],
      [VENDOR_C, '00103'],
    ]);
    const b = blocked(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    expect(b.reasons[0]).toMatchObject({
      code: 'pending_review',
      message: '검토 대기 3건이 남아 있습니다.',
      count: 3,
      href: `/inbox?client=${c.id}&period=${P}`,
      actionLabel: '3건 검토하기',
    });
    expect(b.summary).toBe('미소카페 2026-09 매입매출 전송 차단: 검토 대기 3건이 남아 있습니다.');
    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, b.exportJobId!));
    expect(job).toMatchObject({ status: 'blocked', fileId: null });
    expect(job!.blockedReason).toContain('검토 대기 3건');
    // 정상 흐름(검토 대기)만으로는 문제 알림을 만들지 않는다
    const n = await db.select().from(notifications).where(eq(notifications.clientId, c.id));
    expect(n).toHaveLength(0);
    // 다시 눌러도 차단 행이 쌓이지 않는다
    const b2 = blocked(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    expect(b2.exportJobId).toBe(b.exportJobId);
    const txs = await db.select().from(transactions).where(eq(transactions.clientId, c.id));
    expect(txs.every((t) => t.exportJobId === null)).toBe(true);
  });

  it('계정코드 없음 · 차대 불일치 · 유형코드 매핑 없음 → 차단 사유별 문구 + 문제 알림', async () => {
    const c = await createTestClient(db, { name: '한빛철물' });
    await seedPeriod(db, c, P, [
      card('2026-09-02', VENDOR_B, 4546, 454, { accountCode: null, accountName: null }),
      card('2026-09-03', VENDOR_A, 1000, 100, { accountCode: null, accountName: null }),
      card('2026-09-04', VENDOR_A, 1000, 100, { total: 1101 }),
      card('2026-09-05', VENDOR_B, 500, 50, { vatType: 'purchase_mystery' }),
      card('2026-09-06', VENDOR_B, 700, 70),
    ]);
    await partnerCodes(c.id, [
      [VENDOR_A, '00102'],
      [VENDOR_B, '00101'],
    ]);
    const b = blocked(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    const by = new Map(b.reasons.map((r) => [r.code, r]));
    expect(by.get('missing_account')!.message).toBe('WEHAGO 파일 생성 중 2건의 계정코드를 찾지 못했습니다.');
    expect(by.get('missing_account')!.actionLabel).toBe('2건 검토하기');
    expect(by.get('missing_account')!.href).toBe(`/inbox?client=${c.id}&period=${P}&filter=account_missing`);
    expect(by.get('unbalanced')!.message).toMatch(/^차대 불일치 1건 \(예: 2026-09-04 .* 차변 1,100원 ≠ 대변 1,101원\)\.$/);
    expect(by.get('vat_code_unmapped')!.message).toContain('WEHAGO 유형코드 매핑 없음: purchase_mystery');
    // 원본 행 금액 = 거래 금액이므로 대사 불일치 사유는 없다
    expect(by.has('recon_mismatch')).toBe(false);
    const n = await db.select().from(notifications).where(and(eq(notifications.clientId, c.id), eq(notifications.kind, 'export_error')));
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain('계정코드를 찾지 못했습니다');
  });

  it('서식에 유형코드 매핑이 없으면 "WEHAGO 유형코드 매핑 없음: purchase_card_exempt"', async () => {
    const c = await createTestClient(db, { name: '새봄농산' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 3000, 0)]); // 카드 면세 → purchase_card_exempt
    await partnerCodes(c.id, [[VENDOR_B, '00101']]);
    const tpl = { ...WEHAGO_PURCHASE_SALES_TEMPLATE, key: 'wehago_purchase_sales_office', version: 'test', status: 'office_sample', vatTypeCodes: { ...WEHAGO_PURCHASE_SALES_TEMPLATE.vatTypeCodes, purchase_card_exempt: null } };
    await db.insert(settings).values({
      key: 'wehago_template_purchase_sales',
      value: { template: tpl, meta: { registeredAt: new Date().toISOString(), registeredBy: '테스트', registeredById: null, sourceFileId: null, sourceFileName: 'x.xlsx', headerHash: '' } },
    });
    try {
      const b = blocked(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
      expect(b.reasons.map((r) => r.message).join(' ')).toContain('WEHAGO 유형코드 매핑 없음: purchase_card_exempt');
      expect(b.reasons.find((r) => r.code === 'vat_code_unmapped')!.href).toBe('/settings/templates');
    } finally {
      await db.delete(settings).where(eq(settings.key, 'wehago_template_purchase_sales'));
    }
  });

  it('수집 실패 행이 있으면 차단하고, 대사 보고서에서 행 번호와 사유로 설명한다', async () => {
    const c = await createTestClient(db, { name: '온누리상사' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 4546, 454), card('2026-09-03', VENDOR_A, 1000, 100)], [
      { rowNumber: 3, reason: '거래일자 형식을 읽을 수 없습니다: "2026-13-45"', supply: 1000, vat: 100, total: 1100 },
    ]);
    await partnerCodes(c.id, [
      [VENDOR_A, '00102'],
      [VENDOR_B, '00101'],
    ]);
    const b = blocked(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    const pf = b.reasons.find((r) => r.code === 'parse_failed')!;
    expect(pf.message).toContain('수집 실패 행 1건이 해소되지 않아 전송할 수 없습니다');
    expect(pf.href).toBe(`/imports?client=${c.id}&period=${P}&outcome=failed`);
    const rec = await runReconciliation(staff, { clientId: c.id, period: P, phase: 'pre_export' });
    const d = rec.discrepancies.find((x) => x.kind === 'parse_failed')!;
    expect(d.message).toBe('3행: 거래일자 형식을 읽을 수 없습니다: "2026-13-45" (수집 실패) — 합계 1,100원');
    expect(d.blocking).toBe(true);
    expect(rec.balanced).toBe(true); // 설명된 차이 — 등식은 닫힌다
    expect(rec.exportAllowed).toBe(false);
    expect(rec.stageLine).toBe('위멤버스(원본) 3건 / MIN TAX OPS 2건 / 전송준비 2건');
  });

  it('승인 거래가 없으면 "전송할 승인 거래가 없습니다"', async () => {
    const c = await createTestClient(db, { name: '빈거래처' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 100, 10, { status: 'excluded', excludedReason: '테스트' })]);
    const b = blocked(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    expect(b.reasons.map((r) => r.code)).toEqual(['empty']);
    expect(b.reasons[0]!.message).toBe('전송할 승인 거래가 없습니다 (WEHAGO 매입매출).');
  });
});

describe('버전 · 이중 기장 방지', () => {
  it('다시 만들면 받지 않은 v1 은 무효(다운로드 불가), 올린 v2 뒤 v3 확인은 이전 전표 삭제 확인이 필요', async () => {
    const c = await createTestClient(db, { name: '상록건설' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 9091, 909), card('2026-09-03', VENDOR_A, 20000, 2000)]);
    await partnerCodes(c.id, [
      [VENDOR_A, '00102'],
      [VENDOR_B, '00101'],
    ]);
    const v1 = ready(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    await expect(confirmWehagoUpload(staff, v1.exportJobId)).rejects.toMatchObject({ code: 'EXPORT_NOT_DOWNLOADED' });
    const v2 = ready(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    expect(v2.version).toBe(2);
    expect(v2.fileName.endsWith('_매입매출_v2.xlsx')).toBe(true);
    expect(v2.supersededExportIds).toEqual([v1.exportJobId]);
    const old = await getExportJob(staff, v1.exportJobId);
    expect(old.status).toBe('blocked');
    expect(old.supersededBy).toBe(v2.exportJobId);
    await expect(downloadExport(staff, v1.exportJobId)).rejects.toMatchObject({ code: 'EXPORT_BLOCKED' });

    await downloadExport(staff, v2.exportJobId);
    await confirmWehagoUpload(staff, v2.exportJobId);
    const v3 = ready(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    expect(v3.warnings.join(' ')).toContain('v2 파일은 WEHAGO 업로드가 확인되었습니다');
    await downloadExport(staff, v3.exportJobId);
    const err = await confirmWehagoUpload(staff, v3.exportJobId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).userMessage).toContain('v2 전표(행 2 · 합계 32,000원)');
    const ok = await confirmWehagoUpload(staff, v3.exportJobId, { previousVersionDeleted: true });
    expect(ok.transactionsExported).toBe(2);
    const list = await listExportJobs(staff, { clientId: c.id, period: P });
    expect(list.map((j) => j.version)).toEqual([3, 2, 1]);
  });

  it('파일 생성 뒤 포함 거래가 바뀌면 받기 전 파일을 차단한다', async () => {
    const c = await createTestClient(db, { name: '바른약국' });
    const s = await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 9091, 909)]);
    await partnerCodes(c.id, [[VENDOR_B, '00101']]);
    const r = ready(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    await db.update(transactions).set({ supplyAmount: 9090, vatAmount: 910 }).where(eq(transactions.id, s.txIds[0]!));
    const err = await downloadExport(staff, r.exportJobId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('EXPORT_STALE');
    expect((err as AppError).userMessage).toContain('파일을 다시 만드세요');
    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, r.exportJobId));
    expect(job!.status).toBe('blocked');
  });

  it('일반전표 대상(적격증빙 없음)은 매입매출 파일에서 빠지고 일반전표 파일로 만든다', async () => {
    const c = await createTestClient(db, { name: '다온컨설팅' });
    await seedPeriod(db, c, P, [
      card('2026-09-02', VENDOR_B, 9091, 909),
      { date: '2026-09-03', merchant: '동네세탁소', evidenceType: 'other', supply: 15000, vat: 0, deductible: false, accountCode: '831', accountName: '지급수수료', vatType: 'purchase_no_evidence' },
    ]);
    await partnerCodes(c.id, [[VENDOR_B, '00101']]);
    const res = await prepareClientExports(staff, { clientId: c.id, period: P });
    expect(res.status).toBe('ready');
    expect(res.results.map((r) => r.kind)).toEqual(['wehago_purchase_sales', 'wehago_general_journal']);
    const ps = ready(res.results[0]!);
    const gj = ready(res.results[1]!);
    expect(ps.rowCount).toBe(1);
    expect(ps.warnings.join(' ')).toContain('일반전표 대상 1건은 이 파일에 포함되지 않았습니다');
    expect(gj.rowCount).toBe(1);
    expect(gj.fileRowCount).toBe(2); // 차변 831 / 대변 101
    expect(gj.totals.totalAmount).toBe(15000);
    expect(gj.fileName.endsWith('_일반전표.xlsx')).toBe(true);
  });

  it('수임처 전송 범위: "WEHAGO 수집" 원천은 파일·대사에서 제외하고 알린다', async () => {
    const c = await createTestClient(db, { name: '해피카페' });
    await setRuleParams(db, c.id, { 'export_scope.card': 'mintax_exports', 'export_scope.cash_receipt': 'wehago_collects' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 9091, 909), { date: '2026-09-03', merchant: VENDOR_C.name, bizno: VENDOR_C.bizno, evidenceType: 'cash_receipt', supply: 9091, vat: 909 }]);
    await partnerCodes(c.id, [[VENDOR_B, '00101']]);
    const r = ready(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    expect(r.rowCount).toBe(1);
    expect(r.warnings.join(' ')).toContain('전송 범위가 "WEHAGO 수집"인 원천(현금영수증)은 파일에서 제외했습니다');
    expect(r.warnings.join(' ')).not.toContain('이중 기장 주의');
    const rec = await getReconciliation(staff, r.reconciliationId);
    expect(rec.excludedEvidenceTypes).toEqual(['cash_receipt']);
    expect(rec.exportAllowed).toBe(true);
  });
});

describe('WEHAGO 역수입 불일치', () => {
  it('누락·WEHAGO에만 있는 전표 → 대사 불일치 알림(설명 포함), 거래 상태는 되돌리지 않음', async () => {
    const c = await createTestClient(db, { name: '미래치과' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 9091, 909), card('2026-09-03', VENDOR_A, 20000, 2000)]);
    await partnerCodes(c.id, [
      [VENDOR_A, '00102'],
      [VENDOR_B, '00101'],
    ]);
    const r = await exportAndConfirm(c.id);
    const other = { name: '다른가게', bizno: makeBizNo('314810009') };
    const buf = await ledgerFile([
      ledgerRow('2026-09-02', '57', '00101', VENDOR_B, 9091, 909, '811 복리후생비', '253 미지급금', 'M1'),
      ledgerRow('2026-09-20', '57', '00999', other, 4546, 454, '811 복리후생비', '253 미지급금', 'M9'),
    ]);
    const res = await importWehagoLedger(staff, { clientId: c.id, period: P, fileName: 'ledger.xlsx', data: buf });
    expect(res.matched).toBe(false);
    expect(res.transactionsReconciled).toBe(0);
    expect(res.ledger.learnedPartnerCodes).toBe(1); // 다른가게 → 00999 (연결된 코드는 덮어쓰지 않음)
    const rec = await getReconciliation(staff, res.reconciliationId);
    expect(rec.exportAllowed).toBe(false);
    expect(rec.wehagoMatched).toBe(false);
    const msgs = rec.discrepancies.filter((d) => d.blocking).map((d) => d.message);
    expect(msgs).toContain(`2026-09-03 ${VENDOR_A.name} 22,000원 거래가 WEHAGO에 반영되지 않았습니다.`);
    expect(msgs.some((m) => m.startsWith('WEHAGO에만 있는 전표입니다: 2026-09-20 다른가게 5,000원'))).toBe(true);
    const [n] = await db.select().from(notifications).where(and(eq(notifications.clientId, c.id), eq(notifications.kind, 'recon_mismatch')));
    expect(n!.title).toBe('미래치과 2026-09 WEHAGO 대사 불일치 2건');
    expect(n!.body).toContain('WEHAGO에 반영되지 않았습니다');
    expect(n!.href).toBe(`/reconciliation/${res.reconciliationId}`);
    const txs = await db.select().from(transactions).where(eq(transactions.exportJobId, r.exportJobId));
    expect(txs.every((t) => t.status === 'exported')).toBe(true);

    // WEHAGO 를 고친 뒤 다시 올리면 일치 → 알림 해소
    const fixed = await ledgerFile([
      ledgerRow('2026-09-02', '57', '00101', VENDOR_B, 9091, 909, '811 복리후생비', '253 미지급금', 'M1'),
      ledgerRow('2026-09-03', '57', '00102', VENDOR_A, 20000, 2000, '811 복리후생비', '253 미지급금', 'M2'),
    ]);
    const ok = await importWehagoLedger(staff, { clientId: c.id, period: P, fileName: 'ledger2.xlsx', data: fixed });
    expect(ok.matched).toBe(true);
    const [n2] = await db.select().from(notifications).where(eq(notifications.id, n!.id));
    expect(n2!.resolvedAt).not.toBeNull();
    await clearTemplateVerification();
  });

  it('받지 않은 전송파일이 있는데 WEHAGO 에 이미 같은 전표가 있으면 이중 기장 경고', async () => {
    const c = await createTestClient(db, { name: '이중기장상사' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 9091, 909)]);
    await partnerCodes(c.id, [[VENDOR_B, '00101']]);
    const r = ready(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    // WEHAGO T 자동전표처리가 같은 카드 전표를 이미 만든 상황
    const buf = await ledgerFile([ledgerRow('2026-09-02', '57', '00101', VENDOR_B, 9091, 909, '811 복리후생비', '253 미지급금', 'W1')]);
    const res = await importWehagoLedger(staff, { clientId: c.id, period: P, fileName: 'auto.xlsx', data: buf });
    expect(res.exportJobId).toBeNull(); // 받지 않은 파일은 WEHAGO 대사 기준이 아니다
    expect(res.doubleBookingWarning).toContain('이중 기장');
    const [n] = await db.select().from(notifications).where(and(eq(notifications.clientId, c.id), eq(notifications.kind, 'export_error')));
    expect(n!.severity).toBe('high');
    expect(n!.title).toContain('이중 기장 위험');
    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, r.exportJobId));
    expect(job!.status).toBe('ready'); // 업로드로 추정하지 않는다
    await clearTemplateVerification();
  });

  it('매입매출장이 아닌 파일은 사용자 오류(한국어)로 거부', async () => {
    const c = await createTestClient(db, { name: '엉뚱파일' });
    const buf = await toXlsxBuffer([{ name: 'x', rows: [['안녕하세요'], ['a', 'b']] }]);
    const err = await importWehagoLedger(staff, { clientId: c.id, period: P, fileName: 'x.xlsx', data: buf }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(422);
  });
});

describe('WEHAGO 전송센터', () => {
  const B = '2026-08';
  it('수임처별 단계(데이터로 계산) · 단계별 수임처 수 · 일괄 전송 준비 → "N개 거래처 전송파일 생성 완료 / 1곳 차단: 사유"', async () => {
    const mk = (name: string) => createTestClient(db, { name });
    const noData = await mk('보드-자료없음');
    const collected = await mk('보드-수집완료');
    const review = await mk('보드-검토필요');
    const auto = await mk('보드-자동완료');
    const reviewed = await mk('보드-검토완료');
    const readyC = await mk('보드-전송준비');
    const exported = await mk('보드-전송');
    const noCode = await mk('보드-코드없음');
    await seedPeriod(db, collected, B, [card('2026-08-02', VENDOR_B, 100, 10, { status: 'imported' })]);
    await seedPeriod(db, review, B, [card('2026-08-02', VENDOR_B, 100, 10), card('2026-08-03', VENDOR_B, 200, 20, { status: 'needs_review' })]);
    await seedPeriod(db, auto, B, [card('2026-08-02', VENDOR_B, 100, 10)]);
    await seedPeriod(db, reviewed, B, [card('2026-08-02', VENDOR_B, 100, 10, { status: 'approved', reviewedBy: staffId })]);
    await seedPeriod(db, readyC, B, [card('2026-08-02', VENDOR_B, 100, 10)]);
    await seedPeriod(db, exported, B, [card('2026-08-02', VENDOR_B, 100, 10)]);
    await seedPeriod(db, noCode, B, [card('2026-08-02', VENDOR_A, 100, 10)]);
    for (const c of [auto, reviewed, readyC, exported, noCode]) await partnerCodes(c.id, [[VENDOR_B, '00101']]);
    ready(await prepareWehagoExport(staff, { clientId: readyC.id, period: B, kind: 'wehago_purchase_sales' }));
    const ex = ready(await prepareWehagoExport(staff, { clientId: exported.id, period: B, kind: 'wehago_purchase_sales' }));
    await downloadExport(staff, ex.exportJobId);

    const ids = [noData, collected, review, auto, reviewed, readyC, exported, noCode].map((c) => c.id);
    const board = await getTransferBoard(staff, { period: B, clientIds: ids });
    const stageOf = (id: string) => board.rows.find((r) => r.clientId === id)!;
    expect(stageOf(noData.id).stage).toBe('no_data');
    expect(stageOf(collected.id).stage).toBe('collected');
    expect(stageOf(review.id).stage).toBe('needs_review');
    expect(stageOf(review.id).pending).toBe(1);
    expect(stageOf(review.id).nextAction).toMatchObject({ code: 'review', label: '1건 검토하기' });
    expect(stageOf(auto.id).stage).toBe('auto_classified');
    expect(stageOf(reviewed.id).stage).toBe('reviewed');
    expect(stageOf(readyC.id).stage).toBe('export_ready');
    expect(stageOf(readyC.id).nextAction.code).toBe('download');
    expect(stageOf(exported.id).stage).toBe('exported');
    expect(stageOf(exported.id).nextAction.code).toBe('confirm_upload');
    expect(stageOf(exported.id).lastExport).toMatchObject({ status: 'downloaded', version: 1, templateVerified: false });
    expect(stageOf(exported.id).blockers.map((b) => b.code)).toContain('wehago_unverified');
    expect(board.stages.find((s) => s.stage === 'export_ready')!.clients).toBe(1);
    expect(board.stages.find((s) => s.stage === 'auto_classified')!.clients).toBe(2); // auto + noCode
    expect(board.totals.eligibleForPrepare).toBe(3);
    expect(board.integration.find((i) => i.key === 'wehago.voucher_api')!.status).toBe('NOT_AVAILABLE');
    expect(board.integration.find((i) => i.key === 'wehago.purchase_sales_file')!.status).toBe('FILE_BASED');
    await expect(getTransferBoard(viewer, { period: B })).rejects.toBeInstanceOf(ForbiddenError);

    const req = await prepareTransferBatch(staff, { period: B, clientIds: ids });
    expect(req.clientCount).toBe(3);
    expect(new Set(req.clientIds)).toEqual(new Set([auto.id, reviewed.id, noCode.id]));
    expect(req.skipped.map((s) => s.clientId).sort()).toEqual([noData.id, collected.id, review.id, readyC.id, exported.id].sort());
    const job = await getJob(db, req.jobId!);
    expect(job!.type).toBe('export_wehago');
    const handler = getJobHandler('export_wehago')!;
    const progress: Array<[number, number]> = [];
    const out = await handler({
      ctx: staff,
      job: job!,
      progress: async (d, t) => {
        progress.push([d, t]);
      },
    });
    expect(out.status).toBe('partial');
    const summary = String(out.result.summary);
    expect(summary).toMatch(/^2개 거래처 전송파일 생성 완료 \/ 1곳 차단: 보드-코드없음 — WEHAGO 거래처코드가 연결되지 않은 거래처 1곳\(1건\)/);
    expect(progress.at(-1)).toEqual([3, 3]);

    const after = await getTransferBoard(staff, { period: B, clientIds: ids });
    const s2 = (id: string) => after.rows.find((r) => r.clientId === id)!;
    expect(s2(auto.id).stage).toBe('export_ready');
    expect(s2(reviewed.id).stage).toBe('export_ready');
    expect(s2(noCode.id).stage).toBe('auto_classified');
    expect(s2(noCode.id).blockers.find((b) => b.code === 'export_blocked')!.message).toContain('거래처코드');
    expect(after.totals.blocked).toBe(1);

    // 대사완료 단계: 업로드 확인 + 역수입 일치
    await confirmWehagoUpload(staff, ex.exportJobId);
    const buf = await ledgerFile([ledgerRow('2026-08-02', '57', '00101', VENDOR_B, 100, 10, '811 복리후생비', '253 미지급금', 'M1')]);
    const imp = await importWehagoLedger(staff, { clientId: exported.id, period: B, fileName: 'l.xlsx', data: buf });
    expect(imp.matched).toBe(true);
    const fin = await getTransferBoard(staff, { period: B, clientIds: [exported.id] });
    expect(fin.rows[0]!.stage).toBe('reconciled');
    expect(fin.rows[0]!.reconStatus).toBe('reconciled');
    await clearTemplateVerification();
  });

  it('직접 배치 실행: 한 곳 오류가 다른 곳 처리를 멈추지 않는다', async () => {
    const c = await createTestClient(db, { name: '배치-정상' });
    await seedPeriod(db, c, '2026-07', [card('2026-07-02', VENDOR_B, 100, 10)]);
    await partnerCodes(c.id, [[VENDOR_B, '00101']]);
    const res = await runExportBatch(staff, { period: '2026-07', clientIds: [c.id, '00000000-0000-4000-8000-000000000000'] });
    expect(res.ready).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.summary).toMatch(/^1개 거래처 전송파일 생성 완료 \/ 1곳 오류:/);
  });
});

describe('WEHAGO 서식 등록', () => {
  const OFFICE_HEADER = ['전표일자', '유형코드', '코드', '거래처', '사업자등록번호', '품명', '공급가액', '세액', '합계금액', '분개', '계정과목코드', '계정과목명', '부서'];

  it('사무소 서식 샘플 → 매핑 미리보기 → 등록(관리자) → 그 서식으로 파일 생성', async () => {
    const sample = await toXlsxBuffer([{ name: '매입매출', rows: [OFFICE_HEADER] }]);
    await expect(previewWehagoTemplate(staff, { kind: 'wehago_purchase_sales', fileName: 's.xlsx', data: sample })).rejects.toBeInstanceOf(ForbiddenError);
    const pv = await previewWehagoTemplate(admin, { kind: 'wehago_purchase_sales', fileName: 'WEHAGO_매입매출_서식.xlsx', data: sample });
    expect(pv.canRegister).toBe(true);
    expect(pv.columns.map((c) => c.field)).toEqual([
      'date', 'vatTypeCode', 'counterpartyCode', 'counterpartyName', 'counterpartyBusinessNumber', 'description',
      'supplyAmount', 'vatAmount', 'totalAmount', 'journalTypeCode', 'accountCode', 'accountName', null,
    ]);
    expect(pv.unmatchedHeaders).toEqual(['부서']);

    const reg = await registerWehagoTemplate(admin, { kind: 'wehago_purchase_sales', fileName: 'WEHAGO_매입매출_서식.xlsx', data: sample });
    expect(reg.template).toMatchObject({ source: 'office', status: 'office_sample', verified: false, warning: OFFICE_TEMPLATE_WARNING, sourceFileName: 'WEHAGO_매입매출_서식.xlsx' });
    const active = await getActiveTemplate(staff, 'wehago_purchase_sales');
    expect(active.columns.map((c) => c.header)).toEqual(OFFICE_HEADER);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'settings.update'), eq(auditLogs.entityId, 'wehago_template_purchase_sales')));
    expect(audit.at(-1)!.summary).toContain('WEHAGO 매입매출 서식 등록: WEHAGO_매입매출_서식.xlsx');

    const c = await createTestClient(db, { name: '서식테스트' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 9091, 909)]);
    await partnerCodes(c.id, [[VENDOR_B, '00101']]);
    const r = ready(await prepareWehagoExport(staff, { clientId: c.id, period: P, kind: 'wehago_purchase_sales' }));
    expect(r.template.source).toBe('office');
    expect(r.warnings).toContain(OFFICE_TEMPLATE_WARNING);
    const d = await downloadExport(staff, r.exportJobId);
    const f = await readTabularFile(d.data, d.fileName);
    const sheet = f.sheets.find((s) => !s.hidden)!;
    expect(sheet.name).toBe('매입매출');
    expect(sheet.rows[0]).toEqual(OFFICE_HEADER);
    expect(sheet.rows[1]!.slice(0, 4)).toEqual(['2026-09-02', '57', '00101', VENDOR_B.name]);

    const reset = await resetWehagoTemplate(admin, 'wehago_purchase_sales');
    expect(reset.source).toBe('default');
    expect(reset.warning).toBe(DEFAULT_TEMPLATE_WARNING);
  });

  it('필수 항목이 없는 서식은 등록하지 않는다', async () => {
    const sample = await toXlsxBuffer([{ name: 's', rows: [['일자', '거래처명', '공급가액', '부가세', '합계']] }]);
    const err = await previewWehagoTemplate(admin, { kind: 'wehago_purchase_sales', fileName: 'bad.xlsx', data: sample }).catch((e: unknown) => e);
    // 제목행 탐지에 필요한 최소 매칭(3열)은 넘으므로 미리보기는 되지만 등록은 거부
    if (err instanceof Error) throw err;
    const pv = err as Awaited<ReturnType<typeof previewWehagoTemplate>>;
    expect(pv.canRegister).toBe(false);
    expect(pv.missingRequired).toEqual(expect.arrayContaining(['vatTypeCode', 'accountCode']));
    await expect(registerWehagoTemplate(admin, { kind: 'wehago_purchase_sales', fileName: 'bad.xlsx', data: sample })).rejects.toBeInstanceOf(ValidationError);
    expect((await getActiveTemplate(staff, 'wehago_purchase_sales')).source).toBe('default');
  });
});

describe('감사 · 민감정보', () => {
  it('전송·대사 감사로그에 카드번호·주민번호 원문이 없다', async () => {
    const rows = await db.select({ before: auditLogs.beforeData, after: auditLogs.afterData, summary: auditLogs.summary }).from(auditLogs);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/\b\d{6}-?[1-4]\d{6}\b/);
    expect(text).not.toMatch(/\b\d{4}-\d{4}-\d{4}-\d{4}\b/);
    const recs = await db.select({ n: sql<number>`count(*)::int` }).from(reconciliationJobs);
    expect(Number(recs[0]!.n)).toBeGreaterThan(5);
  });
});

describe('reconcile 작업', () => {
  it('작업 처리기로 대사를 실행해 이력을 남긴다 (여러 수임처 순차)', async () => {
    registerReconciliationJobHandlers();
    const c = await createTestClient(db, { name: '대사작업' });
    await seedPeriod(db, c, P, [card('2026-09-02', VENDOR_B, 9091, 909), card('2026-09-03', VENDOR_A, 100, 10, { status: 'needs_review' })]);
    const jobId = await enqueueJob(db, 'reconcile', { clientIds: [c.id], period: P, phase: 'pre_export' });
    const job = await getJob(db, jobId);
    const out = await getJobHandler('reconcile')!({ ctx: staff, job: job!, progress: async () => undefined });
    expect(out.status).toBe('succeeded');
    const per = out.result.perClient as Array<{ reconciliationId: string; exportAllowed: boolean }>;
    expect(per[0]!.exportAllowed).toBe(false);
    const rec = await getReconciliation(staff, per[0]!.reconciliationId);
    expect(rec.discrepancies.find((d) => d.kind === 'pending_review')!.message).toBe('검토 대기 1건(합계 110원)이 남아 있어 전송할 수 없습니다.');
    expect(rec.discrepancies.find((d) => d.kind === 'pending_review')!.href).toBe(`/inbox?client=${c.id}&period=${P}`);
  });
});

describe('재검증 게이트 (verifyExportFile)', () => {
  it('파일이 1원 다르면 blocked — ready 파일·거래 연결·파일 저장 없음, 높은 심각도 알림', async () => {
    const c = await createTestClient(db, { name: '일원차이상회' });
    await seedPeriod(db, c, '2026-09', [
      { date: '2026-09-02', merchant: VENDOR_B.name, bizno: VENDOR_B.bizno, supply: 9091, vat: 909 },
      { date: '2026-09-03', merchant: VENDOR_A.name, bizno: VENDOR_A.bizno, supply: 20000, vat: 2000 },
    ]);
    await saveWehagoPartnerCodes(staff, {
      clientId: c.id,
      entries: [
        { businessNumber: VENDOR_B.bizno, merchantName: VENDOR_B.name, code: '00101' },
        { businessNumber: VENDOR_A.bizno, merchantName: VENDOR_A.name, code: '00102' },
      ],
    });
    const filesBefore = (await db.select().from(files)).length;
    tamper.on = true;
    const r = await prepareWehagoExport(staff, { clientId: c.id, period: '2026-09', kind: 'wehago_purchase_sales' });
    tamper.on = false;
    expect(r.status).toBe('blocked');
    if (r.status !== 'blocked') return;
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]!.code).toBe('verify_failed');
    expect(r.reasons[0]!.message).toContain('1원 차이도 전송하지 않습니다');
    expect(r.reasons[0]!.message).toMatch(/부가세|합계/);

    const jobs = await db.select().from(exportJobs).where(eq(exportJobs.clientId, c.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'blocked', fileId: null });
    const v = jobs[0]!.validation as { verify?: { ok: boolean; diffs: Array<{ code: string }> } };
    expect(v.verify?.ok).toBe(false);
    expect(v.verify?.diffs.map((d) => d.code)).toEqual(expect.arrayContaining(['vat_mismatch', 'total_mismatch']));
    expect((await db.select().from(files)).length).toBe(filesBefore);
    const txs = await db.select().from(transactions).where(eq(transactions.clientId, c.id));
    expect(txs.every((t) => t.exportJobId === null && t.status === 'auto_approved')).toBe(true);
    const [n] = await db.select().from(notifications).where(and(eq(notifications.clientId, c.id), eq(notifications.kind, 'export_error')));
    expect(n!.severity).toBe('high');

    // 렌더링이 정상으로 돌아오면 같은 거래로 ready
    const ok = await prepareWehagoExport(staff, { clientId: c.id, period: '2026-09', kind: 'wehago_purchase_sales' });
    expect(ok.status).toBe('ready');
    const [n2] = await db.select().from(notifications).where(eq(notifications.id, n!.id));
    expect(n2!.resolvedAt).not.toBeNull();
  });
});

describe('10,000건 / 수임처·월', () => {
  it('전송파일 준비 → 다운로드 → 업로드 확인이 제한 시간 안에 1원 단위로 끝난다', async () => {
    const N = 10_000;
    const c = await createTestClient(db, { name: '대량거래처' });
    const vendors = Array.from({ length: 200 }, (_, i) => ({ name: `가맹점${i}`, bizno: makeBizNo(String(310000000 + i * 37).slice(0, 9)) }));
    const specs: TxSpec[] = Array.from({ length: N }, (_, i) => {
      const v = vendors[i % vendors.length]!;
      const supply = 1000 + (i % 977) * 10;
      return { date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, merchant: v.name, bizno: v.bizno, supply, vat: Math.trunc(supply / 10), approvalNumber: `P${i}` };
    });
    await seedPeriod(db, c, '2026-09', specs);
    await saveWehagoPartnerCodes(staff, { clientId: c.id, entries: vendors.map((v, i) => ({ businessNumber: v.bizno, merchantName: v.name, code: String(10000 + i) })) });

    const t0 = performance.now();
    const r = await prepareWehagoExport(staff, { clientId: c.id, period: '2026-09', kind: 'wehago_purchase_sales' });
    const prepMs = performance.now() - t0;
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.rowCount).toBe(N);
    const expectedTotal = specs.reduce((s, x) => s + x.supply + x.vat, 0);
    expect(r.totals.totalAmount).toBe(expectedTotal);
    expect(r.comparison.match).toBe(true);
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(exportItems).where(eq(exportItems.exportJobId, r.exportJobId))) as [{ n: number }];
    expect(Number(n)).toBe(N);

    const t1 = performance.now();
    const d = await downloadExport(staff, r.exportJobId);
    const conf = await confirmWehagoUpload(staff, r.exportJobId);
    const dlMs = performance.now() - t1;
    expect(d.sizeBytes).toBeGreaterThan(100_000);
    expect(conf.transactionsExported).toBe(N);
    const [{ e }] = (await db.select({ e: sql<number>`count(*)::int` }).from(transactions).where(sql`${transactions.clientId} = ${c.id} and ${transactions.status} = 'exported'`)) as [{ e: number }];
    expect(Number(e)).toBe(N);

    const t2 = performance.now();
    const board = await getTransferBoard(staff, { period: '2026-09', clientIds: [c.id] });
    const boardMs = performance.now() - t2;
    expect(board.rows[0]!.stage).toBe('exported');

    console.info(`[perf] prepare ${N}건 ${Math.round(prepMs)}ms · download+confirm ${Math.round(dlMs)}ms · board ${Math.round(boardMs)}ms`);
    expect(prepMs).toBeLessThan(60_000);
    expect(boardMs).toBeLessThan(2_000);
  });
});
