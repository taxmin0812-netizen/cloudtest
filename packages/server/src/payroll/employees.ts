/**
 * Payroll Automation Studio — 직원 마스터.
 *
 * 보안 원칙
 * - 주민(외국인)등록번호·계좌번호는 AES-256-GCM 암호문(컨텍스트 바인딩) + HMAC blind index + 마스킹본만 저장한다.
 * - 목록·상세 DTO 에는 마스킹본만 담는다. 원문은 revealEmployeeSensitive(payroll.sensitive, 감사 'access')로만 1회 표시.
 * - 감사로그 before/after 에도 마스킹본만 넣는다.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { employees, payrollMonths } from '@mintax/db';
import { formatWon, type IncomeType } from '@mintax/core';
import { cellText, isBlankRow, normalizeHeader, readTabularFile, isAdapterError } from '@mintax/adapters';
import { AppError, ConflictError, NotFoundError, ValidationError, blindIndex, decryptField, encryptField } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit, writeAuditMany, type AuditEntry } from '../infra/audit';
import { storeFile } from '../infra/storage';
import {
  employeesHref,
  incomeTypeLabel,
  isLocalDate,
  kstToday,
  normalizeBankAccount,
  normalizeIdNumber,
  parseInput,
  toIso,
} from './helpers';
import { recomputeMonth } from './month-engine';
import { ensureEmployeeCodes, loadClientBasics, loadEmployeeCodes, refreshUnreviewedNotice, type EmployeeCodeEntry, type EmployeeRow } from './store';
import type {
  CreateEmployeeInput,
  EmployeeDTO,
  EmployeeImportResult,
  EmployeeImportRow,
  EmployeeStatus,
  RevealedSensitiveDTO,
  SensitiveField,
  UpdateEmployeePatch,
} from './types';

export const ID_NUMBER_CONTEXT = 'employees.id_number';
export const BANK_ACCOUNT_CONTEXT = 'employees.bank_account';
const EMPLOYEE_LOCK_NAMESPACE = 72_032;

// ────────────────────────────── 입력 스키마 ──────────────────────────────

const money = z.number({ invalid_type_error: '원 단위 숫자여야 합니다' }).int('원 단위 정수여야 합니다').min(0, '0 이상이어야 합니다').max(Number.MAX_SAFE_INTEGER);
const moneyMap = z.record(z.string().trim().min(1).max(40), money);
const localDate = z.string().refine(isLocalDate, '날짜 형식은 YYYY-MM-DD 입니다');
const incomeType = z.enum(['earned', 'business', 'daily'], { errorMap: () => ({ message: '소득구분은 earned(근로)/business(사업)/daily(일용) 중 하나입니다' }) });

const baseFields = {
  name: z.string().trim().min(1, '이름을 입력하세요').max(50),
  incomeType,
  idNumber: z.string().max(40).nullish(),
  hireDate: localDate.nullish(),
  resignDate: localDate.nullish(),
  baseSalary: money.optional(),
  allowances: moneyMap.optional(),
  nonTaxable: moneyMap.optional(),
  dailyWage: money.nullish(),
  businessIncomeCode: z.string().trim().regex(/^\d{6}$/, '업종코드는 숫자 6자리입니다 (예: 940909)').nullish(),
  paymentDay: z.number().int().min(1).max(31).nullish(),
  bankName: z.string().trim().max(30).nullish(),
  bankAccount: z.string().max(40).nullish(),
  dependents: z.number().int().min(1).max(20).optional(),
  reportStatus: z.string().trim().max(200).nullish(),
  employeeCode: z.string().trim().max(20).regex(/^[0-9A-Za-z_-]*$/, '사원코드는 영문·숫자만 쓸 수 있습니다').nullish(),
};

const createSchema = z.object({ clientId: z.string().uuid('수임처 식별자가 올바르지 않습니다'), ...baseFields });
const patchSchema = z.object({ ...baseFields, active: z.boolean().optional() }).partial();

type ParsedCreate = z.infer<typeof createSchema>;
type ParsedPatch = z.infer<typeof patchSchema>;

// ────────────────────────────── DTO ──────────────────────────────

function statusOf(e: EmployeeRow, today: string): EmployeeStatus {
  if (!e.active) return 'inactive';
  if (e.resignDate && e.resignDate < today) return 'resigned';
  if (e.hireDate && e.hireDate > today) return 'not_started';
  return 'active';
}

export function toEmployeeDTO(e: EmployeeRow, code: EmployeeCodeEntry | undefined, now: Date): EmployeeDTO {
  const today = kstToday(now);
  const warnings: string[] = [];
  if (!e.idNumberEnc) warnings.push('주민(외국인)등록번호 미등록 — 원천세·지급명세서 신고 불가');
  if (e.incomeType === 'business' && !e.businessIncomeCode) warnings.push('사업소득 업종코드 미등록 — WEHAGO 사업소득 파일 생성 불가');
  if (e.incomeType === 'daily' && !e.dailyWage) warnings.push('일당 미등록');
  if (!code || code.source === 'auto') warnings.push(`WEHAGO 사원코드 미확인 (자동 부여 ${code?.code ?? '-'}) — WEHAGO 코드와 다르면 수정하세요`);
  if (e.resignDate && e.resignDate >= today) warnings.push(`퇴사 예정 (${e.resignDate})`);
  return {
    id: e.id,
    clientId: e.clientId,
    name: e.name,
    incomeType: e.incomeType,
    incomeTypeLabel: incomeTypeLabel(e.incomeType),
    employeeCode: code?.code ?? '',
    employeeCodeSource: code?.source ?? 'auto',
    hasIdNumber: !!e.idNumberEnc,
    idNumberMasked: e.idNumberMasked,
    isForeigner: e.isForeigner,
    hireDate: e.hireDate,
    resignDate: e.resignDate,
    status: statusOf(e, today),
    baseSalary: e.baseSalary,
    allowances: e.allowances ?? {},
    nonTaxable: e.nonTaxable ?? {},
    dailyWage: e.dailyWage,
    businessIncomeCode: e.businessIncomeCode,
    paymentDay: e.paymentDay,
    bankName: e.bankName,
    hasBankAccount: !!e.bankAccountEnc,
    bankAccountMasked: e.bankAccountMasked,
    dependents: e.dependents,
    reportStatus: e.reportStatus,
    active: e.active,
    warnings,
    createdAt: toIso(e.createdAt)!,
    updatedAt: toIso(e.updatedAt)!,
  };
}

/** 감사로그용 (마스킹본만) */
function auditView(e: Partial<EmployeeRow>, code?: string | null): Record<string, unknown> {
  return {
    name: e.name,
    incomeType: e.incomeType,
    idNumberMasked: e.idNumberMasked ?? null,
    hireDate: e.hireDate ?? null,
    resignDate: e.resignDate ?? null,
    baseSalary: e.baseSalary,
    allowances: e.allowances,
    nonTaxable: e.nonTaxable,
    dailyWage: e.dailyWage ?? null,
    businessIncomeCode: e.businessIncomeCode ?? null,
    paymentDay: e.paymentDay ?? null,
    bankName: e.bankName ?? null,
    bankAccountMasked: e.bankAccountMasked ?? null,
    dependents: e.dependents,
    reportStatus: e.reportStatus ?? null,
    active: e.active,
    ...(code !== undefined ? { employeeCode: code } : {}),
  };
}

async function lockEmployees(ctx: ServiceContext, clientId: string): Promise<void> {
  await ctx.db.execute(sql`select pg_advisory_xact_lock(${EMPLOYEE_LOCK_NAMESPACE}, hashtext(${clientId}))`);
}

async function loadEmployee(ctx: Pick<ServiceContext, 'db'>, employeeId: string, forUpdate = false): Promise<EmployeeRow> {
  if (!z.string().uuid().safeParse(employeeId).success) throw new NotFoundError('직원');
  const q = ctx.db.select().from(employees).where(eq(employees.id, employeeId));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw new NotFoundError('직원');
  return row;
}

interface SensitiveColumns {
  idNumberEnc?: string | null;
  idNumberHash?: string | null;
  idNumberMasked?: string | null;
  isForeigner?: boolean;
  bankAccountEnc?: string | null;
  bankAccountMasked?: string | null;
}

/** 원문 → 암호문·색인·마스킹 (원문은 이 함수 밖으로 나가지 않는다) */
function sensitiveColumns(input: { idNumber?: string | null; bankAccount?: string | null }): SensitiveColumns {
  const out: SensitiveColumns = {};
  if (input.idNumber !== undefined) {
    if (input.idNumber === null || input.idNumber.trim() === '') {
      Object.assign(out, { idNumberEnc: null, idNumberHash: null, idNumberMasked: null });
    } else {
      const n = normalizeIdNumber(input.idNumber);
      Object.assign(out, {
        idNumberEnc: encryptField(n.digits, undefined, { context: ID_NUMBER_CONTEXT }),
        idNumberHash: blindIndex(n.digits, 'rrn'),
        idNumberMasked: n.masked,
        isForeigner: n.isForeigner,
      });
    }
  }
  if (input.bankAccount !== undefined) {
    if (input.bankAccount === null || input.bankAccount.trim() === '') {
      Object.assign(out, { bankAccountEnc: null, bankAccountMasked: null });
    } else {
      const b = normalizeBankAccount(input.bankAccount);
      Object.assign(out, { bankAccountEnc: encryptField(b.digits, undefined, { context: BANK_ACCOUNT_CONTEXT }), bankAccountMasked: b.masked });
    }
  }
  return out;
}

async function assertNoDuplicateId(ctx: Pick<ServiceContext, 'db'>, clientId: string, hash: string | null | undefined, exceptId?: string): Promise<void> {
  if (!hash) return;
  const conds = [eq(employees.clientId, clientId), eq(employees.idNumberHash, hash)];
  if (exceptId) conds.push(ne(employees.id, exceptId));
  const [dup] = await ctx.db.select({ name: employees.name }).from(employees).where(and(...conds)).limit(1);
  if (dup) {
    throw new ConflictError(
      `같은 주민(외국인)등록번호로 이미 등록된 직원이 있습니다 (${dup.name}). 중복 등록하면 두 사람의 급여가 합쳐질 수 있으니 기존 직원을 수정하세요.`,
      'employee id_number_hash duplicate',
    );
  }
}

function assertCodeUnique(codes: Record<string, EmployeeCodeEntry>, employeeId: string, code: string | null | undefined, names: Map<string, string>): void {
  if (!code) return;
  for (const [id, c] of Object.entries(codes)) {
    if (id !== employeeId && c.code === code) {
      throw new ConflictError(`사원코드 ${code} 는 이미 ${names.get(id) ?? '다른 직원'}에게 쓰이고 있습니다. WEHAGO 는 사원코드가 중복되면 행을 제외합니다.`);
    }
  }
}

function assertDates(hire: string | null | undefined, resign: string | null | undefined): void {
  if (hire && resign && resign < hire) {
    throw new ValidationError('퇴사일이 입사일보다 빠릅니다. 날짜를 확인해 주세요.', [{ field: 'resignDate', message: '입사일 이후' }]);
  }
}

// ────────────────────────────── 조회 ──────────────────────────────

/** 직원 목록 — 주민번호·계좌는 마스킹본만 */
export async function listEmployees(ctx: ServiceContext, clientId: string, opts: { includeInactive?: boolean } = {}): Promise<EmployeeDTO[]> {
  requirePermission(ctx, 'payroll.read');
  await loadClientBasics(ctx, clientId);
  const conds = [eq(employees.clientId, clientId)];
  if (!opts.includeInactive) conds.push(eq(employees.active, true));
  const [rows, codes] = await Promise.all([
    ctx.db.select().from(employees).where(and(...conds)).orderBy(employees.incomeType, employees.name, employees.id),
    loadEmployeeCodes(ctx, clientId),
  ]);
  const now = ctx.now();
  return rows.map((e) => toEmployeeDTO(e, codes[e.id], now));
}

export async function getEmployee(ctx: ServiceContext, employeeId: string): Promise<EmployeeDTO> {
  requirePermission(ctx, 'payroll.read');
  const e = await loadEmployee(ctx, employeeId);
  const codes = await loadEmployeeCodes(ctx, e.clientId);
  return toEmployeeDTO(e, codes[e.id], ctx.now());
}

// ────────────────────────────── 등록 · 수정 ──────────────────────────────

function insertValues(ctx: ServiceContext, p: ParsedCreate, sens: SensitiveColumns): typeof employees.$inferInsert {
  return {
    clientId: p.clientId,
    name: p.name,
    incomeType: p.incomeType,
    ...sens,
    hireDate: p.hireDate ?? null,
    resignDate: p.resignDate ?? null,
    baseSalary: p.baseSalary ?? 0,
    allowances: p.allowances ?? {},
    nonTaxable: p.nonTaxable ?? {},
    dailyWage: p.dailyWage ?? null,
    businessIncomeCode: p.businessIncomeCode ?? null,
    paymentDay: p.paymentDay ?? null,
    bankName: p.bankName ?? null,
    dependents: p.dependents ?? 1,
    reportStatus: p.reportStatus ?? null,
    createdAt: ctx.now(),
    updatedAt: ctx.now(),
  };
}

function createAudit(e: EmployeeRow, code: EmployeeCodeEntry, prefix = ''): AuditEntry {
  const pay =
    e.incomeType === 'daily' ? `일당 ${formatWon(e.dailyWage ?? 0)}` : e.incomeType === 'business' ? `지급액 ${formatWon(e.baseSalary)}` : `기본급 ${formatWon(e.baseSalary)}`;
  return {
    action: 'employee.create',
    category: 'data_change',
    entityType: 'employee',
    entityId: e.id,
    clientId: e.clientId,
    summary: `${prefix}직원 등록: ${e.name} (${incomeTypeLabel(e.incomeType)}, ${pay}${e.idNumberMasked ? `, ${e.idNumberMasked}` : ', 주민번호 미등록'})`,
    before: null,
    after: auditView(e, code.code),
  };
}

async function insertEmployee(ctx: ServiceContext, p: ParsedCreate): Promise<{ row: EmployeeRow; code: EmployeeCodeEntry; audit: AuditEntry }> {
  assertDates(p.hireDate, p.resignDate);
  const sens = sensitiveColumns({ idNumber: p.idNumber, bankAccount: p.bankAccount });
  await assertNoDuplicateId(ctx, p.clientId, sens.idNumberHash);
  if (p.employeeCode) {
    const existing = await loadEmployeeCodes(ctx, p.clientId);
    const names = new Map((await ctx.db.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.clientId, p.clientId))).map((x) => [x.id, x.name]));
    assertCodeUnique(existing, '', p.employeeCode, names);
  }
  const [row] = await ctx.db.insert(employees).values(insertValues(ctx, p, sens)).returning();
  const e = row!;
  const codes = await ensureEmployeeCodes(ctx, p.clientId, [e.id], p.employeeCode ? { [e.id]: p.employeeCode } : {});
  const code = codes[e.id]!;
  return { row: e, code, audit: createAudit(e, code) };
}

/** 직원 등록 — 주민번호는 암호화(컨텍스트 'employees.id_number') + blind index + 마스킹 */
export async function createEmployee(ctx: ServiceContext, input: CreateEmployeeInput): Promise<EmployeeDTO> {
  requirePermission(ctx, 'payroll.write');
  const p = parseInput(createSchema, input, '직원');
  await loadClientBasics(ctx, p.clientId);
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    await lockEmployees(t, p.clientId);
    const { row, code, audit } = await insertEmployee(t, p);
    await writeAudit(t, audit);
    await recomputeOpenMonths(t, p.clientId);
    return toEmployeeDTO(row, code, ctx.now());
  });
}

const FIELD_LABELS: Record<string, string> = {
  name: '이름',
  incomeType: '소득구분',
  idNumberMasked: '주민번호',
  hireDate: '입사일',
  resignDate: '퇴사일',
  baseSalary: '기본급',
  allowances: '정기수당',
  nonTaxable: '비과세',
  dailyWage: '일당',
  businessIncomeCode: '업종코드',
  paymentDay: '지급일',
  bankName: '은행',
  bankAccountMasked: '계좌',
  dependents: '부양가족',
  reportStatus: '신고상태',
  active: '사용',
  employeeCode: '사원코드',
};

function fmt(v: unknown, key: string): string {
  if (v === null || v === undefined || v === '') return '없음';
  if (typeof v === 'number' && ['baseSalary', 'dailyWage'].includes(key)) return formatWon(v);
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, number>);
    return entries.length ? entries.map(([k, n]) => `${k} ${formatWon(n)}`).join(', ') : '없음';
  }
  if (key === 'incomeType') return incomeTypeLabel(v as IncomeType);
  return String(v);
}

/** 변경 적용 (권한 검사 없음 — 호출자가 검사). 바뀐 항목만 감사로그에 남긴다 */
async function applyEmployeePatch(
  ctx: ServiceContext,
  e: EmployeeRow,
  p: ParsedPatch,
  action: string,
  summaryPrefix?: string,
): Promise<{ row: EmployeeRow; code: EmployeeCodeEntry | undefined; audit: AuditEntry | null }> {
  const sens = sensitiveColumns({ idNumber: p.idNumber, bankAccount: p.bankAccount });
  if (sens.idNumberHash) await assertNoDuplicateId(ctx, e.clientId, sens.idNumberHash, e.id);
  const set: Partial<EmployeeRow> = {};
  const plain: Array<keyof ParsedPatch & keyof EmployeeRow> = [
    'name', 'incomeType', 'hireDate', 'resignDate', 'baseSalary', 'allowances', 'nonTaxable', 'dailyWage',
    'businessIncomeCode', 'paymentDay', 'bankName', 'dependents', 'reportStatus', 'active',
  ];
  for (const k of plain) {
    if (p[k] === undefined) continue;
    const v = p[k] ?? null;
    if (JSON.stringify(v) !== JSON.stringify(e[k] ?? null)) (set as Record<string, unknown>)[k] = v;
  }
  for (const [k, v] of Object.entries(sens) as Array<[keyof SensitiveColumns, unknown]>) {
    if (k === 'idNumberEnc' || k === 'bankAccountEnc') continue;
    if (JSON.stringify(v) !== JSON.stringify(e[k] ?? null)) (set as Record<string, unknown>)[k] = v;
  }
  // 암호문은 매번 새 IV 이므로 원문 해시/마스킹이 같으면 다시 쓰지 않는다
  if (sens.idNumberEnc !== undefined && (set.idNumberHash !== undefined || (sens.idNumberEnc === null && e.idNumberEnc))) set.idNumberEnc = sens.idNumberEnc;
  if (sens.bankAccountEnc !== undefined) {
    const changed = sens.bankAccountEnc === null ? !!e.bankAccountEnc : !e.bankAccountEnc || decryptSafe(e.bankAccountEnc, BANK_ACCOUNT_CONTEXT) !== decryptSafe(sens.bankAccountEnc, BANK_ACCOUNT_CONTEXT);
    if (changed) {
      set.bankAccountEnc = sens.bankAccountEnc;
      set.bankAccountMasked = sens.bankAccountMasked ?? null;
    }
  }
  assertDates(set.hireDate !== undefined ? set.hireDate : e.hireDate, set.resignDate !== undefined ? set.resignDate : e.resignDate);

  let codes = await loadEmployeeCodes(ctx, e.clientId);
  const oldCode = codes[e.id]?.code ?? null;
  let codeChanged = false;
  if (p.employeeCode && p.employeeCode !== oldCode) {
    const names = new Map((await ctx.db.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.clientId, e.clientId))).map((x) => [x.id, x.name]));
    assertCodeUnique(codes, e.id, p.employeeCode, names);
    codes = await ensureEmployeeCodes(ctx, e.clientId, [e.id], { [e.id]: p.employeeCode });
    codeChanged = true;
  }
  if (Object.keys(set).length === 0 && !codeChanged) return { row: e, code: codes[e.id], audit: null };

  let row = e;
  if (Object.keys(set).length > 0) {
    const [u] = await ctx.db.update(employees).set({ ...set, updatedAt: ctx.now() }).where(eq(employees.id, e.id)).returning();
    row = u!;
  }
  const keys = [...Object.keys(set).filter((k) => !k.endsWith('Enc') && k !== 'idNumberHash' && k !== 'isForeigner'), ...(codeChanged ? ['employeeCode'] : [])];
  const beforeView = auditView(e, oldCode);
  const afterView = auditView(row, codes[e.id]?.code ?? null);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const k of keys) {
    before[k] = beforeView[k];
    after[k] = afterView[k];
    parts.push(`${FIELD_LABELS[k] ?? k} ${fmt(beforeView[k], k)} → ${fmt(afterView[k], k)}`);
  }
  return {
    row,
    code: codes[e.id],
    audit: {
      action,
      category: 'data_change',
      entityType: 'employee',
      entityId: e.id,
      clientId: e.clientId,
      summary: `${summaryPrefix ?? ''}${row.name} ${parts.join(', ')}`.trim(),
      before,
      after,
      revertible: false,
    },
  };
}

function decryptSafe(ct: string, context: string): string | null {
  try {
    return decryptField(ct, undefined, { context });
  } catch {
    return null;
  }
}

/** 열린(확정 전) 급여 월의 변동 분류를 다시 계산 — 퇴사일·주민번호 등록 등이 검토 대상에 바로 반영되도록 */
export async function recomputeOpenMonths(ctx: ServiceContext, clientId: string): Promise<void> {
  const open = await ctx.db
    .select({ id: payrollMonths.id, period: payrollMonths.period })
    .from(payrollMonths)
    .where(and(eq(payrollMonths.clientId, clientId), inArray(payrollMonths.status, ['draft', 'reviewing'])));
  for (const m of open) {
    await recomputeMonth(ctx, m.id, 'reviewed');
    await refreshUnreviewedNotice(ctx, m.period);
  }
}

/** 직원 정보 수정 (바뀐 항목만 감사로그) */
export async function updateEmployee(ctx: ServiceContext, employeeId: string, patch: UpdateEmployeePatch): Promise<EmployeeDTO> {
  requirePermission(ctx, 'payroll.write');
  const p = parseInput(patchSchema, patch, '직원');
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const e0 = await loadEmployee(t, employeeId);
    await lockEmployees(t, e0.clientId);
    const e = await loadEmployee(t, employeeId, true);
    const { row, code, audit } = await applyEmployeePatch(t, e, p, 'employee.update');
    if (audit) {
      await writeAudit(t, audit);
      await recomputeOpenMonths(t, e.clientId);
    }
    return toEmployeeDTO(row, code, ctx.now());
  });
}

/** 퇴사 처리 */
export async function resignEmployee(ctx: ServiceContext, employeeId: string, resignDate: string): Promise<EmployeeDTO> {
  requirePermission(ctx, 'payroll.write');
  if (!isLocalDate(resignDate)) throw new ValidationError('퇴사일 형식이 올바르지 않습니다. 예: 2026-08-31', [{ field: 'resignDate', message: 'YYYY-MM-DD' }]);
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const e0 = await loadEmployee(t, employeeId);
    await lockEmployees(t, e0.clientId);
    const e = await loadEmployee(t, employeeId, true);
    const { row, code, audit } = await applyEmployeePatch(t, e, { resignDate }, 'employee.resign', '퇴사 처리: ');
    if (audit) {
      await writeAudit(t, audit);
      await recomputeOpenMonths(t, e.clientId);
    }
    return toEmployeeDTO(row, code, ctx.now());
  });
}

/** 내부용 (급여 마법사 3단계 결정): 권한 검사·트랜잭션은 호출자 책임 */
export async function patchEmployeeInternal(ctx: ServiceContext, employeeId: string, patch: UpdateEmployeePatch, action: string, summaryPrefix?: string): Promise<{ row: EmployeeRow; audit: AuditEntry | null }> {
  const p = parseInput(patchSchema, patch, '직원');
  const e = await loadEmployee(ctx, employeeId, true);
  const r = await applyEmployeePatch(ctx, e, p, action, summaryPrefix);
  return { row: r.row, audit: r.audit };
}

// ────────────────────────────── 민감정보 열람 ──────────────────────────────

function formatIdNumber(d: string): string {
  return d.length === 13 ? `${d.slice(0, 6)}-${d.slice(6)}` : d;
}

/**
 * 주민번호·계좌 원문 1회 열람 (payroll.sensitive). 열람할 때마다 감사로그 category 'access' 를 남긴다.
 * 반환값은 화면 1회 표시용 — 저장·로그 금지.
 */
export async function revealEmployeeSensitive(ctx: ServiceContext, employeeId: string, field: SensitiveField): Promise<RevealedSensitiveDTO> {
  requirePermission(ctx, 'payroll.sensitive');
  if (field !== 'idNumber' && field !== 'bankAccount') {
    throw new ValidationError('열람할 항목은 주민번호(idNumber) 또는 계좌번호(bankAccount)입니다.', [{ field: 'field', message: 'idNumber | bankAccount' }]);
  }
  const e = await loadEmployee(ctx, employeeId);
  const enc = field === 'idNumber' ? e.idNumberEnc : e.bankAccountEnc;
  const label = field === 'idNumber' ? '주민번호' : '계좌번호';
  if (!enc) {
    throw new AppError({
      code: 'SENSITIVE_NOT_SET',
      httpStatus: 404,
      userMessage: `${e.name}님의 ${label}가 등록되어 있지 않습니다. 직원 정보에서 먼저 등록하세요.`,
      action: { label: '직원 설정', href: employeesHref(e.clientId) },
    });
  }
  const plain = decryptField(enc, undefined, { context: field === 'idNumber' ? ID_NUMBER_CONTEXT : BANK_ACCOUNT_CONTEXT });
  const masked = (field === 'idNumber' ? e.idNumberMasked : e.bankAccountMasked) ?? '';
  const auditLogId = await writeAudit(ctx, {
    action: 'employee.view_sensitive',
    category: 'access',
    entityType: 'employee',
    entityId: e.id,
    clientId: e.clientId,
    summary: `${label} 열람: ${e.name} (${masked})`,
    before: null,
    after: { field, masked },
  });
  return {
    employeeId: e.id,
    field,
    value: field === 'idNumber' ? formatIdNumber(plain) : plain,
    masked,
    revealedAt: ctx.now().toISOString(),
    displaySeconds: 30,
    auditLogId,
  };
}

/** 내부용: WEHAGO 파일 생성 시 주민번호 복호화 (호출자가 payroll.sensitive 확인) */
export function decryptIdNumber(e: Pick<EmployeeRow, 'idNumberEnc'>): string | null {
  if (!e.idNumberEnc) return null;
  return decryptField(e.idNumberEnc, undefined, { context: ID_NUMBER_CONTEXT });
}

// ────────────────────────────── 가져오기 (WEHAGO 사원등록 / 엑셀) ──────────────────────────────

const INCOME_TYPE_WORDS: Array<[RegExp, IncomeType]> = [
  [/일용/, 'daily'],
  [/사업|프리|3\.3/, 'business'],
  [/근로|상용|정규|계약|earned/i, 'earned'],
];

export function parseIncomeTypeWord(v: unknown): IncomeType | null {
  if (v === 'earned' || v === 'business' || v === 'daily') return v;
  const s = String(v ?? '').trim();
  if (!s) return null;
  for (const [re, t] of INCOME_TYPE_WORDS) if (re.test(s)) return t;
  return null;
}

/**
 * 직원 일괄 등록·갱신. 기존 직원은 주민번호(blind index) → 사원코드 → 이름(유일할 때) 순으로 맞춘다.
 * 실패 행은 사유와 함께 돌려준다 (조용히 버리지 않음).
 */
export async function importEmployees(ctx: ServiceContext, input: { clientId: string; rows: EmployeeImportRow[]; sourceName?: string }): Promise<EmployeeImportResult> {
  requirePermission(ctx, 'payroll.write');
  const client = await loadClientBasics(ctx, input.clientId);
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new ValidationError('가져올 직원 행이 없습니다.', [{ field: 'rows', message: '1행 이상' }]);
  if (input.rows.length > 5000) throw new ValidationError('한 번에 5,000명까지 가져올 수 있습니다. 파일을 나누어 올려 주세요.', [{ field: 'rows', message: '최대 5000' }]);
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    await lockEmployees(t, client.id);
    const existing = await t.db.select().from(employees).where(eq(employees.clientId, client.id));
    const codes = await loadEmployeeCodes(t, client.id);
    const byHash = new Map(existing.filter((e) => e.idNumberHash).map((e) => [e.idNumberHash!, e.name]));
    const byCode = new Map(Object.entries(codes).map(([id, c]) => [c.code, id]));
    const byName = new Map<string, EmployeeRow[]>();
    for (const e of existing) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
    const byId = new Map(existing.map((e) => [e.id, e]));

    const failed: EmployeeImportResult['failed'] = [];
    const audits: AuditEntry[] = [];
    const touched = new Map<string, EmployeeRow>();
    const inserts: Array<{ values: typeof employees.$inferInsert; code: string | null }> = [];
    const newCodes = new Set<string>();
    const newNames = new Set<string>();
    let updated = 0;
    let unchanged = 0;
    for (const [i, r] of input.rows.entries()) {
      const rowNumber = r.rowNumber ?? i + 1;
      const name = String(r.name ?? '').trim();
      try {
        const it = parseIncomeTypeWord(r.incomeType);
        if (r.incomeType && !it) throw new ValidationError(`소득구분 "${String(r.incomeType).slice(0, 20)}" 을(를) 알 수 없습니다 (근로/사업/일용).`);
        let hash: string | null = null;
        if (r.idNumber) hash = blindIndex(normalizeIdNumber(r.idNumber).digits, 'rrn');
        const code = r.employeeCode ? String(r.employeeCode).trim() : null;
        let match: EmployeeRow | undefined = hash ? existing.find((e) => e.idNumberHash === hash) : undefined;
        if (!match && code) match = byId.get(byCode.get(code) ?? '');
        if (!match && name) {
          const same = byName.get(name) ?? [];
          if (same.length > 1) throw new ValidationError(`같은 이름의 직원이 ${same.length}명 있어 구분할 수 없습니다 — 주민번호나 사원코드를 함께 넣어 주세요.`);
          match = same[0];
        }
        const common = {
          ...(r.idNumber ? { idNumber: r.idNumber } : {}),
          ...(r.hireDate ? { hireDate: String(r.hireDate) } : {}),
          ...(r.resignDate ? { resignDate: String(r.resignDate) } : {}),
          ...(r.baseSalary !== null && r.baseSalary !== undefined ? { baseSalary: r.baseSalary } : {}),
          ...(r.dailyWage !== null && r.dailyWage !== undefined ? { dailyWage: r.dailyWage } : {}),
          ...(r.businessIncomeCode ? { businessIncomeCode: String(r.businessIncomeCode) } : {}),
          ...(r.paymentDay ? { paymentDay: r.paymentDay } : {}),
          ...(r.bankName ? { bankName: r.bankName } : {}),
          ...(r.bankAccount ? { bankAccount: r.bankAccount } : {}),
          ...(r.dependents ? { dependents: r.dependents } : {}),
          ...(code ? { employeeCode: code } : {}),
        };
        if (match) {
          // 기존 직원 갱신 (드묾) — 행마다 savepoint 로 격리
          const m = match;
          await t.db.transaction(async (sp) => {
            const s = withTx(t, sp);
            const p = parseInput(patchSchema, { ...common, ...(it ? { incomeType: it } : {}), name: name || m.name }, `${rowNumber}행`);
            const res = await applyEmployeePatch(s, m, p, 'employee.update', '직원 가져오기: ');
            if (res.audit) {
              audits.push(res.audit);
              updated++;
              byId.set(res.row.id, res.row);
            } else unchanged++;
            touched.set(res.row.id, res.row);
          });
        } else {
          if (!name) throw new ValidationError('이름이 없습니다.');
          const p = parseInput(createSchema, { clientId: client.id, name, incomeType: it ?? 'earned', ...common }, `${rowNumber}행`);
          assertDates(p.hireDate, p.resignDate);
          const sens = sensitiveColumns({ idNumber: p.idNumber, bankAccount: p.bankAccount });
          if (sens.idNumberHash && byHash.has(sens.idNumberHash)) {
            throw new ConflictError(`같은 주민(외국인)등록번호로 이미 등록된 직원이 있습니다 (${byHash.get(sens.idNumberHash)}).`);
          }
          if (code && (byCode.has(code) || newCodes.has(code))) throw new ConflictError(`사원코드 ${code} 가 이미 쓰이고 있습니다.`);
          if (newNames.has(name)) throw new ValidationError('같은 이름이 파일에 두 번 있습니다 — 주민번호나 사원코드로 구분해 주세요.');
          if (sens.idNumberHash) byHash.set(sens.idNumberHash, name);
          if (code) newCodes.add(code);
          newNames.add(name);
          inserts.push({ values: insertValues(t, p, sens), code });
        }
      } catch (e) {
        const reason = e instanceof AppError ? e.userMessage : '처리 중 오류가 발생했습니다.';
        failed.push({ rowNumber, name: name || '(이름 없음)', reason });
      }
    }

    // 신규는 500건 단위 일괄 등록 + 사원코드 한 번에 저장
    const created: EmployeeRow[] = [];
    for (let k = 0; k < inserts.length; k += 500) {
      const part = inserts.slice(k, k + 500);
      const rows = await t.db.insert(employees).values(part.map((x) => x.values)).returning();
      created.push(...rows);
    }
    const userCodes: Record<string, string> = {};
    created.forEach((e, k) => {
      const c = inserts[k]!.code;
      if (c) userCodes[e.id] = c;
    });
    const allCodes = await ensureEmployeeCodes(t, client.id, created.map((e) => e.id), userCodes);
    for (const e of created) {
      audits.push(createAudit(e, allCodes[e.id]!, '직원 가져오기: '));
      touched.set(e.id, e);
    }
    await writeAuditMany(t, audits);
    const summary = `${client.name} 직원 가져오기${input.sourceName ? ` (${input.sourceName})` : ''}: 신규 ${created.length}명, 수정 ${updated}명, 변경 없음 ${unchanged}명${failed.length ? `, 실패 ${failed.length}행` : ''}`;
    await writeAudit(t, { action: 'employee.import', category: 'data_change', entityType: 'client', entityId: client.id, clientId: client.id, summary, after: { created: created.length, updated, unchanged, failed: failed.length } });
    if (created.length + updated > 0) await recomputeOpenMonths(t, client.id);
    const finalCodes = await loadEmployeeCodes(t, client.id);
    return {
      clientId: client.id,
      created: created.length,
      updated,
      unchanged,
      failed,
      employees: [...touched.values()].map((x) => toEmployeeDTO(x, finalCodes[x.id], ctx.now())),
      summary,
    };
  });
}

const EMPLOYEE_HEADER_ALIASES: Record<keyof Omit<EmployeeImportRow, 'rowNumber'>, string[]> = {
  name: ['성명', '이름', '사원명', '소득자명', '직원명'],
  employeeCode: ['사원코드', '사번', '사원번호', '소득자코드', '코드'],
  idNumber: ['주민등록번호', '주민번호', '주민(외국인)등록번호', '외국인등록번호', '주민(외국인)번호'],
  incomeType: ['소득구분', '구분', '고용형태', '근로형태'],
  hireDate: ['입사일', '입사일자', '입사년월일'],
  resignDate: ['퇴사일', '퇴사일자', '퇴사년월일'],
  baseSalary: ['기본급', '월급여', '급여', '월지급액', '지급액'],
  dailyWage: ['일당', '일급'],
  businessIncomeCode: ['업종코드', '소득구분코드'],
  paymentDay: ['지급일', '급여지급일'],
  bankName: ['은행', '은행명'],
  bankAccount: ['계좌번호', '계좌'],
  dependents: ['부양가족수', '공제대상가족수', '부양가족'],
};

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const s = String(v).replace(/[,원\s]/g, '');
  return /^-?\d+$/.test(s) ? Number(s) : null;
}

function toDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim().replace(/[./]/g, '-');
  const m = /^(\d{4})-?(\d{1,2})-?(\d{1,2})$/.exec(s);
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : s;
}

/** 엑셀/CSV 파일 → 직원 가져오기. 원본 파일은 암호화 저장한다 (주민번호 포함 가능) */
export async function importEmployeesFile(ctx: ServiceContext, input: { clientId: string; fileName: string; data: Buffer }): Promise<EmployeeImportResult & { fileId: string }> {
  requirePermission(ctx, 'payroll.write');
  const client = await loadClientBasics(ctx, input.clientId);
  if (!input.data || input.data.length === 0) throw new ValidationError('빈 파일입니다. 파일을 다시 선택해 주세요.');
  if (input.data.length > 20 * 1024 * 1024) throw new ValidationError('직원 파일은 20MB 이하만 올릴 수 있습니다.');
  let file;
  try {
    file = await readTabularFile(input.data, input.fileName);
  } catch (e) {
    if (isAdapterError(e)) throw new ValidationError(e.message);
    throw e;
  }
  const sheet = file.sheets.find((s) => !s.hidden && s.rows.length > 0);
  if (!sheet) throw new ValidationError('파일에 표가 없습니다.');
  const aliasToField = new Map<string, keyof typeof EMPLOYEE_HEADER_ALIASES>();
  for (const [f, list] of Object.entries(EMPLOYEE_HEADER_ALIASES) as Array<[keyof typeof EMPLOYEE_HEADER_ALIASES, string[]]>) {
    for (const a of list) aliasToField.set(normalizeHeader(a), f);
  }
  let headerIdx = -1;
  let columns: Array<keyof typeof EMPLOYEE_HEADER_ALIASES | null> = [];
  for (let r = 0; r < Math.min(sheet.rows.length, 15); r++) {
    const cols = sheet.rows[r]!.map((c) => aliasToField.get(normalizeHeader(cellText(c))) ?? null);
    if (cols.includes('name') && cols.filter(Boolean).length >= 2) {
      headerIdx = r;
      columns = cols;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new ValidationError('직원 파일에서 제목행(성명·주민번호·입사일 등)을 찾지 못했습니다. WEHAGO 사원등록 엑셀이나 성명 열이 있는 표를 올려 주세요.');
  }
  const rows: EmployeeImportRow[] = [];
  for (let r = headerIdx + 1; r < sheet.rows.length; r++) {
    const cells = sheet.rows[r]!;
    if (isBlankRow(cells)) continue;
    const rec: Record<string, unknown> = {};
    columns.forEach((f, j) => {
      if (f) rec[f] = cells[j] ?? null;
    });
    rows.push({
      rowNumber: r + 1,
      name: cellText(rec.name),
      employeeCode: rec.employeeCode !== undefined && rec.employeeCode !== null ? cellText(rec.employeeCode) : null,
      idNumber: rec.idNumber ? cellText(rec.idNumber) : null,
      incomeType: rec.incomeType ? cellText(rec.incomeType) : null,
      hireDate: toDate(rec.hireDate),
      resignDate: toDate(rec.resignDate),
      baseSalary: toNumber(rec.baseSalary),
      dailyWage: toNumber(rec.dailyWage),
      businessIncomeCode: rec.businessIncomeCode ? cellText(rec.businessIncomeCode) : null,
      paymentDay: toNumber(rec.paymentDay),
      bankName: rec.bankName ? cellText(rec.bankName) : null,
      bankAccount: rec.bankAccount ? cellText(rec.bankAccount) : null,
      dependents: toNumber(rec.dependents),
    });
  }
  const stored = await storeFile(ctx, { data: input.data, originalName: input.fileName, purpose: 'import_source', clientId: client.id });
  const result = await importEmployees(ctx, { clientId: client.id, rows, sourceName: input.fileName });
  return { ...result, fileId: stored.id };
}
