import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_KEYS, insertTxs, lockTestDatabase, type TxSeed } from '../classification/test-fixtures';

process.env.MINTAX_DATA_KEY ??= TEST_KEYS.MINTAX_DATA_KEY;
process.env.MINTAX_INDEX_KEY ??= TEST_KEYS.MINTAX_INDEX_KEY;
process.env.AI_PROVIDER = 'heuristic';

import { and, eq, inArray } from 'drizzle-orm';
import { auditLogs, closeDb, mappingRules, notifications, reviewRules, setupTestDatabase, transactions, vatRules, type Database } from '@mintax/db';
import { SYSTEM_DICTIONARY } from '@mintax/core/engine/classify-index';
import { DEFAULT_REVIEW_RULES, DEFAULT_VAT_RULES } from '@mintax/core/engine/vat-risk-index';
import { AppError, ForbiddenError } from '@mintax/security';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import { systemActor, type ServiceContext } from '../context';
import { classifyClientPeriod } from '../classification/index';
import {
  approveSuggestedRule,
  countMappingRulesByStatus,
  createMappingRule,
  createReviewRule,
  createRuleFromTransaction,
  createVatRule,
  disableMappingRule,
  enableMappingRule,
  ensureDefaultRules,
  listMappingRules,
  listReviewRules,
  listVatRules,
  overrideReviewRuleForClient,
  overrideVatRuleForClient,
  previewRule,
  rejectSuggestedRule,
  removeVatRuleOverride,
  updateMappingRule,
  updateReviewRuleParams,
  updateVatRule,
} from './index';

let db: Database;
let sys: ServiceContext;
let staff: ServiceContext;
let manager: ServiceContext;
let admin: ServiceContext;

const COUPANG = '1208800767';
const coupangRule = { all: [{ field: 'direction', op: 'eq', value: 'purchase' }, { field: 'merchantKey', op: 'eq', value: '쿠팡' }] } as const;

async function expectAppError(p: Promise<unknown>, cls: new (...a: never[]) => AppError, re?: RegExp): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(cls);
    if (re) expect((e as AppError).userMessage).toMatch(re);
    return e as AppError;
  }
  throw new Error('expected rejection');
}

let unlockDb: (() => Promise<void>) | null = null;

beforeAll(async () => {
  unlockDb = await lockTestDatabase();
  db = await setupTestDatabase();
  sys = testContext(db, systemActor());
  staff = testContext(db, (await createTestUser(db, 'staff', '김담당')).actor);
  manager = testContext(db, (await createTestUser(db, 'manager', '박팀장')).actor);
  admin = testContext(db, (await createTestUser(db, 'admin', '이관리')).actor);
});

afterAll(async () => {
  await unlockDb?.();
  await closeDb();
});

describe('ensureDefaultRules', () => {
  it('seeds defaults once (idempotent)', async () => {
    const first = await ensureDefaultRules(db);
    expect(first).toEqual({
      vatRulesInserted: DEFAULT_VAT_RULES.length,
      reviewRulesInserted: DEFAULT_REVIEW_RULES.length,
      systemRulesInserted: SYSTEM_DICTIONARY.length,
    });
    const second = await ensureDefaultRules(db);
    expect(second).toEqual({ vatRulesInserted: 0, reviewRulesInserted: 0, systemRulesInserted: 0 });
    const sysRules = await listMappingRules(sys, { clientId: null });
    expect(sysRules).toHaveLength(SYSTEM_DICTIONARY.length);
    expect(sysRules.every((r) => r.origin === 'system_default' && r.dictionaryId?.startsWith('SYS-'))).toBe(true);
  });
});

describe('mapping rule approval flow', () => {
  it('staff creates → suggested; staff approve → 403 + security audit; manager approves → active → next classification uses user_rule', async () => {
    const cl = await createTestClient(db, { name: '상록건설', industry: 'construction' });
    const hist: TxSeed[] = Array.from({ length: 5 }, (_, i) => ({
      clientId: cl.id,
      date: `2026-0${7 + (i % 2)}-1${i}`,
      merchantName: '쿠팡(주)',
      merchantBusinessNumber: COUPANG,
      totalAmount: 22000 + i * 1100,
      status: 'approved',
      accountCode: '830',
      accountName: '소모품비',
    }));
    await insertTxs(db, hist);
    await insertTxs(db, [{ clientId: cl.id, date: '2026-09-02', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG, totalAmount: 16500 }]);

    const rule = await createMappingRule(staff, { clientId: cl.id, name: '쿠팡 → 사무용품비', condition: coupangRule as never, accountCode: '829' });
    expect(rule.status).toBe('suggested');
    expect(rule.origin).toBe('user');
    expect(rule.conditionText).toBe('매입/매출 = "매입" 그리고 상호키 = "쿠팡"');
    expect(rule.createdByName).toBe('김담당');
    const notes = await db.select().from(notifications).where(eq(notifications.dedupeKey, `rule_suggested:${rule.id}`));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe('rule_suggested');

    // 같은 조건 중복 생성 → 409
    await expectAppError(createMappingRule(staff, { clientId: cl.id, name: '중복', condition: coupangRule as never, accountCode: '830' }), AppError, /이미 있습니다/);

    // 백테스트: 최근 3개월 확정 5건 일치, 모두 830 → 829 로 바뀜, 미처리 1건
    const pv = await previewRule(staff, { clientId: cl.id, condition: coupangRule as never, accountCode: '829' });
    expect(pv.matchedHistory).toBe(5);
    expect(pv.wouldChange).toBe(5);
    expect(pv.unchanged).toBe(0);
    expect(pv.pendingMatched).toBe(1);
    expect(pv.samples[0]).toMatchObject({ currentAccountCode: '830', newAccountCode: '829', newAccountName: '사무용품비' });
    expect(pv.warnings.join()).toMatch(/다른 계정/);
    const pvSame = await previewRule(staff, { clientId: cl.id, condition: coupangRule as never, accountCode: '830' });
    expect(pvSame).toMatchObject({ matchedHistory: 5, wouldChange: 0, unchanged: 5 });

    // 제안 상태에서는 분류에 쓰이지 않는다
    const before = await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: null });
    expect(before.bySource.exact_history).toBe(1);

    // 담당자는 승인 불가 → 403 + 보안 감사
    await expectAppError(approveSuggestedRule(staff, rule.id), ForbiddenError, /권한/);
    const sec = await db.select().from(auditLogs).where(and(eq(auditLogs.category, 'security'), eq(auditLogs.entityId, rule.id)));
    expect(sec).toHaveLength(1);
    expect(sec[0]!.summary).toContain('규칙 승인');

    const approved = await approveSuggestedRule(manager, rule.id);
    expect(approved.status).toBe('active');
    expect(approved.approvedByName).toBe('박팀장');
    expect(approved.approvedAt).not.toBeNull();
    const resolved = await db.select().from(notifications).where(eq(notifications.dedupeKey, `rule_suggested:${rule.id}`));
    expect(resolved[0]!.resolvedAt).not.toBeNull();
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'rule.approve'), eq(auditLogs.entityId, rule.id)));
    expect(aud[0]!.summary).toContain('규칙 승인');
    await expectAppError(approveSuggestedRule(manager, rule.id), AppError, /제안/);

    // 다음 달 쿠팡 2건 → user_rule, 99, auto_approved
    const oct = await insertTxs(db, [
      { clientId: cl.id, date: '2026-10-03', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG, totalAmount: 13200 },
      { clientId: cl.id, date: '2026-10-09', merchantName: '쿠팡 주식회사', merchantBusinessNumber: COUPANG, totalAmount: 27500 },
    ]);
    const res = await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-10', aiProvider: null });
    expect(res.autoApproved).toBe(2);
    const rows = await db.select().from(transactions).where(inArray(transactions.id, oct));
    for (const r of rows) {
      expect(r.classificationSource).toBe('user_rule');
      expect(r.accountCode).toBe('829');
      expect(r.accountConfidence).toBe(99);
      expect(r.status).toBe('auto_approved');
      expect(r.confidenceScore).toBeGreaterThanOrEqual(95);
      // 과거(830)와 다른 계정이라는 사실은 숨기지 않고 참고(info, 비차단)로 남긴다
      const changed = r.riskFlags.find((f) => f.ruleCode === 'RISK-CHANGED');
      expect(changed).toMatchObject({ severity: 'info', blocksAutoApproval: false });
      expect(changed!.message).toContain("승인된 규칙 '쿠팡 → 사무용품비'");
    }
    const [mr] = await db.select().from(mappingRules).where(eq(mappingRules.id, rule.id));
    expect(mr!.appliedCount).toBe(2);
    expect(mr!.lastAppliedAt).not.toBeNull();
    const listed = await listMappingRules(staff, { clientId: cl.id });
    expect(listed.find((r) => r.id === rule.id)).toMatchObject({ appliedCount: 2, status: 'active', stale: false });
  });

  it('manager-created rules are active immediately; staff cannot edit active rules; disable/enable/reject', async () => {
    const cl = await createTestClient(db, { industry: 'service' });
    const r = await createMappingRule(manager, {
      clientId: cl.id,
      name: 'KT 통신비',
      condition: { field: 'merchantKey', op: 'starts_with', value: 'KT' },
      accountCode: '814',
      priority: 50,
    });
    expect(r.status).toBe('active');
    await expectAppError(updateMappingRule(staff, r.id, { priority: 120 }), ForbiddenError);
    const upd = await updateMappingRule(manager, r.id, { priority: 120, accountCode: '831' });
    expect(upd).toMatchObject({ priority: 120, accountCode: '831', accountName: '지급수수료' });
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'rule.update'), eq(auditLogs.entityId, r.id)));
    expect(aud[0]!.summary).toContain('계정 814 통신비 → 831 지급수수료');
    expect(aud[0]!.summary).toContain('우선순위 50 → 120');
    await expectAppError(updateMappingRule(manager, r.id, { priority: 130, expectedUpdatedAt: r.updatedAt }), AppError, /먼저 변경/);

    const off = await disableMappingRule(staff, r.id, '거래 종료');
    expect(off.status).toBe('disabled');
    await expectAppError(enableMappingRule(staff, r.id), ForbiddenError);
    expect((await enableMappingRule(manager, r.id)).status).toBe('active');

    const s = await createMappingRule(staff, { clientId: cl.id, name: '임시', condition: { field: 'merchantKey', op: 'eq', value: '다이소' }, accountCode: '830' });
    // 담당자는 제안 규칙은 고칠 수 있다
    expect((await updateMappingRule(staff, s.id, { name: '다이소 소모품' })).name).toBe('다이소 소모품');
    const rej = await rejectSuggestedRule(manager, s.id, '상품 매입도 섞여 있음');
    expect(rej.status).toBe('rejected');
    const counts = await countMappingRulesByStatus(staff, { clientId: cl.id });
    expect(counts).toMatchObject({ active: 1, rejected: 1, suggested: 0 });
  });

  it('validates input with actionable Korean messages', async () => {
    const cl = await createTestClient(db);
    await expectAppError(
      createMappingRule(staff, { clientId: cl.id, name: 'x', condition: { field: 'nope' as never, op: 'eq', value: 1 }, accountCode: '830' }),
      AppError,
      /조건/,
    );
    await expectAppError(createMappingRule(staff, { clientId: cl.id, name: 'x', condition: coupangRule as never, accountCode: '999999' }), AppError, /계정과목표에 없는/);
    await expectAppError(createMappingRule(staff, { clientId: null, name: 'x', condition: coupangRule as never, accountCode: '830' }), ForbiddenError);
    await expectAppError(createMappingRule(staff, { clientId: cl.id, name: '', condition: coupangRule as never, accountCode: '830' }), AppError, /이름/);
    await expectAppError(approveSuggestedRule(manager, 'not-a-uuid'), AppError, /찾을 수 없습니다/);
    const viewer = testContext(db, (await createTestUser(db, 'viewer')).actor);
    await expectAppError(createMappingRule(viewer, { clientId: cl.id, name: 'x', condition: coupangRule as never, accountCode: '830' }), ForbiddenError);
  });

  it('createRuleFromTransaction builds the condition and counts a human touch', async () => {
    const cl = await createTestClient(db);
    const [txId] = await insertTxs(db, [
      { clientId: cl.id, date: '2026-09-11', merchantName: '(주)오피스디포', merchantBusinessNumber: '2148712345', totalAmount: 55000, description: '오피스디포 복사용지 구매' },
    ]);
    const rule = await createRuleFromTransaction(staff, txId!, { accountCode: '829', scope: 'merchant_and_description' });
    expect(rule.status).toBe('suggested');
    expect(rule.condition).toEqual({
      all: [
        { field: 'direction', op: 'eq', value: 'purchase' },
        { field: 'merchantKey', op: 'eq', value: '오피스디포' },
        { field: 'description', op: 'contains', value: '복사용지' },
      ],
    });
    expect(rule.name).toBe('(주)오피스디포(복사용지) → 사무용품비');
    expect(rule.suggestionReason).toContain('55,000원');
    const [tx] = await db.select().from(transactions).where(eq(transactions.id, txId!));
    expect(tx!.touchCount).toBe(1);
    const byBizno = await createRuleFromTransaction(manager, txId!, { accountCode: '829', scope: 'bizno', name: '오피스디포 사업자' });
    expect(byBizno.status).toBe('active');
    await expectAppError(createRuleFromTransaction(staff, '00000000-0000-4000-8000-000000000000', { accountCode: '829', scope: 'merchant' }), AppError, /거래/);
  });
});

describe('VAT rules', () => {
  it('lists defaults with applied counts, global edits need settings.write, client override changes classification', async () => {
    const cl = await createTestClient(db, { industry: 'service' });
    const all = await listVatRules(staff, { clientId: null });
    expect(all).toHaveLength(DEFAULT_VAT_RULES.length);
    const gen = all.find((r) => r.code === 'VAT-DEF-CARD-GEN')!;
    expect(gen.isDefault).toBe(true);
    expect(gen.conditionText).toContain('증빙');

    await expectAppError(updateVatRule(manager, gen.id, { confidence: 96 }), ForbiddenError); // 공통 = 관리자
    await expectAppError(
      createVatRule(staff, { clientId: cl.id, code: 'VAT-X-01', name: '테스트', condition: { field: 'merchantKey', op: 'eq', value: 'X' }, outcome: 'non_deductible', reasonText: '사유' }),
      AppError,
      /근거 조문/,
    );

    // 수임처 override: 일반과세 카드 기본공제 → 검토 (이 수임처는 카드 공제 판단을 사람이 한다)
    const ov = await overrideVatRuleForClient(staff, gen.id, cl.id, { outcome: 'review', legalBasis: '사무소 내부 기준', reasonText: '이 수임처는 카드 매입 공제를 직접 확인' });
    expect(ov).toMatchObject({ clientId: cl.id, code: 'VAT-DEF-CARD-GEN', outcome: 'review', scope: 'client' });
    await expectAppError(overrideVatRuleForClient(staff, gen.id, cl.id), AppError, /이미 있습니다/);
    const eff = await listVatRules(staff, { clientId: cl.id });
    expect(eff.find((r) => r.id === gen.id)).toMatchObject({ overridden: true, effective: false });
    expect(eff.find((r) => r.id === ov.id)).toMatchObject({ effective: true });

    const hist: TxSeed[] = Array.from({ length: 4 }, (_, i) => ({
      clientId: cl.id, date: `2026-08-0${i + 1}`, merchantName: '스타벅스', merchantBusinessNumber: '2018123456', totalAmount: 5500, status: 'approved', accountCode: '811', accountName: '복리후생비',
    }));
    await insertTxs(db, hist);
    const [t] = await insertTxs(db, [{ clientId: cl.id, date: '2026-09-02', merchantName: '스타벅스', merchantBusinessNumber: '2018123456', totalAmount: 6600 }]);
    await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: null });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, t!));
    expect(row!.status).toBe('needs_review');
    expect(row!.buckets).toContain('vat_review');
    const [ovRow] = await db.select().from(vatRules).where(eq(vatRules.id, ov.id));
    expect(ovRow!.appliedCount).toBe(1);

    await removeVatRuleOverride(staff, ov.id);
    expect((await listVatRules(staff, { clientId: cl.id })).find((r) => r.id === gen.id)).toMatchObject({ overridden: false, effective: true });
    await expectAppError(removeVatRuleOverride(admin, gen.id), AppError, /삭제할 수 없습니다/);
    const aud = await db.select().from(auditLogs).where(eq(auditLogs.action, 'vat_rule.remove_override'));
    expect(aud[0]!.beforeData).toMatchObject({ code: 'VAT-DEF-CARD-GEN', outcome: 'review' });

    const updated = await updateVatRule(admin, gen.id, { confidence: 96 });
    expect(updated.confidence).toBe(96);
  });
});

describe('review rules', () => {
  it('edits params with validation, client overrides flag high amounts, counts applications', async () => {
    const list = await listReviewRules(staff, { clientId: null });
    const high = list.find((r) => r.code === 'RISK-HIGH-AMOUNT')!;
    expect(high.params).toEqual({ threshold: 1_000_000 });
    await expectAppError(updateReviewRuleParams(manager, high.id, { threshold: '2,000,000' }), ForbiddenError);
    await expectAppError(updateReviewRuleParams(admin, high.id, { threshold: '이백만' }), AppError, /숫자/);
    const upd = await updateReviewRuleParams(admin, high.id, { threshold: '2,000,000' });
    expect(upd.params.threshold).toBe(2_000_000);
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'review_rule.update'), eq(auditLogs.entityId, high.id)));
    expect(aud[0]!.summary).toContain('threshold 1,000,000 → 2,000,000');

    const cl = await createTestClient(db, { industry: 'service' });
    const ov = await overrideReviewRuleForClient(staff, high.id, cl.id, { params: { threshold: '50,000' } });
    expect(ov.params.threshold).toBe(50_000);
    const eff = await listReviewRules(staff, { clientId: cl.id });
    expect(eff.find((r) => r.id === ov.id)).toMatchObject({ effective: true, effectiveParams: { threshold: 50_000 } });

    const hist: TxSeed[] = Array.from({ length: 4 }, (_, i) => ({
      clientId: cl.id, date: `2026-08-1${i}`, merchantName: '한국전력공사', merchantBusinessNumber: '1208200052', totalAmount: 80000, status: 'approved', accountCode: '815', accountName: '수도광열비',
    }));
    await insertTxs(db, hist);
    const [t] = await insertTxs(db, [{ clientId: cl.id, date: '2026-09-15', merchantName: '한국전력공사', merchantBusinessNumber: '1208200052', totalAmount: 88000 }]);
    await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: null });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, t!));
    expect(row!.buckets).toContain('high_amount');
    expect(row!.status).toBe('needs_review');
    expect(row!.riskFlags.find((f) => f.ruleCode === 'RISK-HIGH-AMOUNT')?.message).toContain('50,000원');
    const [ovRow] = await db.select().from(reviewRules).where(eq(reviewRules.id, ov.id));
    expect(ovRow!.appliedCount).toBe(1);

    await expectAppError(
      createReviewRule(staff, { clientId: cl.id, code: 'RISK-CUSTOM', name: '고액', kind: 'high_amount', params: {}, bucket: 'high_amount', severity: 'warning', messageTemplate: '{amount}' }),
      AppError,
      /threshold/,
    );
    const custom = await createReviewRule(staff, {
      clientId: cl.id,
      code: 'RISK-CUSTOM-KW',
      name: '코인 거래',
      kind: 'condition',
      condition: { field: 'searchText', op: 'contains', value: '$keywords' } as never,
      params: { keywords: ['업비트', '빗썸'] },
      bucket: 'personal_use',
      severity: 'high',
      messageTemplate: '{merchantName}: 가상자산 거래소 결제입니다.',
    });
    expect(custom.conditionText).toContain('업비트, 빗썸');
  });
});
