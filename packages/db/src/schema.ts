/**
 * MIN TAX OPS — PostgreSQL 스키마 (Drizzle ORM).
 *
 * 원칙
 * - 금액: bigint(원 단위 정수, mode number)
 * - 민감정보(주민번호, 계좌, 외부 인증정보): *_enc 컬럼에 AES-256-GCM 암호문만 저장 + 마스킹 컬럼 별도
 * - 데이터는 삭제하지 않는다: duplicate / excluded / failed 상태로 남긴다
 * - 모든 사람 행동은 audit_logs 에 before/after 로 남긴다
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AccountClassification,
  ClassificationSource,
  Condition,
  ExceptionBucket,
  RiskFlag,
  VatClassification,
} from '@mintax/core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const won = (name: string) => bigint(name, { mode: 'number' });

// ═══════════════════════════════ 사용자 / 보안 ═══════════════════════════════

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** scrypt$N$r$p$salt$hash — 평문 저장 절대 금지 */
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<'admin' | 'manager' | 'staff' | 'viewer'>().notNull().default('staff'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** TOTP secret (암호화) */
    mfaSecretEnc: text('mfa_secret_enc'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** 허용 IP 대역 (CIDR). 비어있으면 제한 없음 */
    allowedIpRanges: jsonb('allowed_ip_ranges').$type<string[]>().notNull().default([]),
    active: boolean('active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** 세션 토큰의 SHA-256 해시 (원문 토큰은 쿠키에만) */
    tokenHash: text('token_hash').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    mfaVerified: boolean('mfa_verified').notNull().default(false),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** 절대 만료 */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const loginHistory = pgTable(
  'login_history',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    success: boolean('success').notNull(),
    /** password_ok_mfa_required | bad_password | locked | mfa_failed | ip_blocked | success */
    result: text('result').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('login_history_user_idx').on(t.userId, t.createdAt)],
);

// ═══════════════════════════════ 거래처 (고객사) ═══════════════════════════════

export const clients = pgTable(
  'clients',
  {
    id: id(),
    /** 사무소 내부 거래처 코드 (WEHAGO 회사코드와 매핑) */
    code: text('code').notNull(),
    name: text('name').notNull(),
    businessNumber: text('business_number').notNull(),
    representativeName: text('representative_name'),
    businessType: text('business_type').$type<'corporation' | 'individual'>().notNull(),
    /** 담당 직원 */
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    /** WEHAGO 회사코드 (Import 파일명/검증용) */
    wehagoCompanyCode: text('wehago_company_code'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('clients_code_uq').on(t.code),
    uniqueIndex('clients_bizno_uq').on(t.businessNumber),
    index('clients_assignee_idx').on(t.assigneeId),
  ],
);

export const clientBusinessProfiles = pgTable('client_business_profiles', {
  clientId: uuid('client_id')
    .primaryKey()
    .references(() => clients.id, { onDelete: 'cascade' }),
  industry: text('industry').notNull(), // IndustryKey
  industryCode: text('industry_code'),
  industryName: text('industry_name'),
  vatType: text('vat_type').$type<'general' | 'simplified' | 'exempt' | 'mixed'>().notNull(),
  deemedInputTaxEligible: boolean('deemed_input_tax_eligible').notNull().default(false),
  /** 비영업용 소형승용차 등 매입세액 불공제 차량번호 */
  nonDeductibleVehicles: jsonb('non_deductible_vehicles').$type<string[]>().notNull().default([]),
  /** 사업용 카드 목록 (마스킹) + 별칭 */
  businessCards: jsonb('business_cards').$type<Array<{ masked: string; alias?: string; holder?: string }>>().notNull().default([]),
  /** 거래처별 고액 기준 등 규칙 파라미터 override */
  ruleParams: jsonb('rule_params').$type<Record<string, number | string | boolean>>().notNull().default({}),
  withholdingSemiannual: boolean('withholding_semiannual').notNull().default(false),
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
  notes: text('notes'),
  updatedAt: updatedAt(),
});

// ═══════════════════════════════ 계정과목 ═══════════════════════════════

export const accountCodes = pgTable(
  'account_codes',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    category: text('category').$type<'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'cogs'>().notNull(),
    isFixedAsset: boolean('is_fixed_asset').notNull().default(false),
    vatNonDeductibleHint: boolean('vat_non_deductible_hint').notNull().default(false),
    active: boolean('active').notNull().default(true),
    /** 동의어 (검색/AI 매핑용) */
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  },
  (t) => [uniqueIndex('account_codes_code_uq').on(t.code)],
);

// ═══════════════════════════════ 파일 / 수집 ═══════════════════════════════

export const files = pgTable(
  'files',
  {
    id: id(),
    /** 저장소 키 (S3 key 또는 로컬 경로) */
    storageKey: text('storage_key').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    encrypted: boolean('encrypted').notNull().default(true),
    /** import_source | wehago_export | error_report | filing_receipt | payment_slip | review_excel | payroll_export */
    purpose: text('purpose').notNull(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('files_sha_idx').on(t.sha256), index('files_client_idx').on(t.clientId)],
);

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: id(),
    /** wemembers | wehago | hometax | wetax | desktop_bridge | cloud_folder | ai_provider */
    key: text('key').notNull(),
    name: text('name').notNull(),
    status: text('status').$type<'LIVE' | 'FILE_BASED' | 'RPA' | 'MOCK' | 'NOT_AVAILABLE'>().notNull(),
    statusReason: text('status_reason').notNull(),
    /** 비밀값은 암호화된 JSON 문자열로만 저장 */
    configEnc: text('config_enc'),
    /** 비밀이 아닌 설정 */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('integration_connections_key_uq').on(t.key)],
);

export const importJobs = pgTable(
  'import_jobs',
  {
    id: id(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'restrict' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(), // IngestChannel
    /** 감지된 파일 형식 프로필 키 (예: hometax_card_purchase_v1) */
    formatProfile: text('format_profile'),
    source: text('source').notNull(), // TransactionSource
    period: text('period'), // YYYY-MM
    status: text('status').$type<'queued' | 'running' | 'succeeded' | 'partial' | 'failed'>().notNull().default('queued'),
    totalRows: integer('total_rows').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),
    duplicateRows: integer('duplicate_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),
    /** 원본 합계 (대사 source stage) */
    sourceSupplyAmount: won('source_supply_amount').notNull().default(0),
    sourceVatAmount: won('source_vat_amount').notNull().default(0),
    sourceTotalAmount: won('source_total_amount').notNull().default(0),
    message: text('message'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('import_jobs_client_idx').on(t.clientId, t.createdAt)],
);

/** 원본 행 1개 = 1 record. 모든 수집행은 여기 남는다 (조용한 유실 방지). */
export const transactionSources = pgTable(
  'transaction_sources',
  {
    id: id(),
    importJobId: uuid('import_job_id')
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    rawData: jsonb('raw_data').$type<Record<string, unknown>>().notNull(),
    /** ok | duplicate | failed */
    outcome: text('outcome').$type<'ok' | 'duplicate' | 'failed'>().notNull(),
    errorReason: text('error_reason'),
    errorField: text('error_field'),
    transactionId: uuid('transaction_id'),
    /** 원본 금액 (파싱 가능한 경우) */
    supplyAmount: won('supply_amount'),
    vatAmount: won('vat_amount'),
    totalAmount: won('total_amount'),
    createdAt: createdAt(),
  },
  (t) => [
    index('transaction_sources_job_idx').on(t.importJobId, t.rowNumber),
    index('transaction_sources_tx_idx').on(t.transactionId),
  ],
);

// ═══════════════════════════════ 거래 ═══════════════════════════════

export const transactions = pgTable(
  'transactions',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    businessNumber: text('business_number').notNull(),
    importJobId: uuid('import_job_id').references(() => importJobs.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    channel: text('channel').notNull(),
    direction: text('direction').$type<'purchase' | 'sales'>().notNull(),
    /** YYYY-MM (월별 조회 인덱스) */
    period: text('period').notNull(),
    transactionDate: date('transaction_date', { mode: 'string' }).notNull(),
    evidenceType: text('evidence_type').notNull(),
    merchantName: text('merchant_name').notNull(),
    merchantKey: text('merchant_key').notNull(),
    merchantBusinessNumber: text('merchant_business_number'),
    merchantCategory: text('merchant_category'),
    merchantTaxType: text('merchant_tax_type').notNull().default('unknown'),
    description: text('description').notNull().default(''),
    supplyAmount: won('supply_amount').notNull(),
    vatAmount: won('vat_amount').notNull(),
    serviceCharge: won('service_charge').notNull().default(0),
    totalAmount: won('total_amount').notNull(),
    cardNumberMasked: text('card_number_masked'),
    approvalNumber: text('approval_number'),
    invoiceNumber: text('invoice_number'),
    originalSourceId: text('original_source_id'),
    currency: text('currency').notNull().default('KRW'),
    isForeign: boolean('is_foreign').notNull().default(false),
    sourceDeductibleHint: boolean('source_deductible_hint'),
    rawData: jsonb('raw_data').$type<Record<string, unknown>>().notNull().default({}),
    fingerprint: text('fingerprint').notNull(),
    duplicateOfId: uuid('duplicate_of_id'),
    duplicateReason: text('duplicate_reason'),

    // ── 현재 분류 결과 (최신 classification_results 의 비정규화 사본) ──
    accountCode: text('account_code'),
    accountName: text('account_name'),
    accountConfidence: integer('account_confidence'),
    classificationSource: text('classification_source').$type<ClassificationSource>(),
    classificationSummary: text('classification_summary'),
    vatType: text('vat_type'),
    deductible: boolean('deductible'),
    vatConfidence: integer('vat_confidence'),
    vatReasonCode: text('vat_reason_code'),
    /** 두 신뢰도 중 낮은 값 — 검토 정책 판단 기준 */
    confidenceScore: integer('confidence_score'),
    reviewLevel: text('review_level').$type<'auto' | 'quick_review' | 'must_review'>(),
    buckets: jsonb('buckets').$type<ExceptionBucket[]>().notNull().default([]),
    riskFlags: jsonb('risk_flags').$type<RiskFlag[]>().notNull().default([]),

    status: text('status').notNull().default('imported'),
    /** 사람이 이 거래를 만진 횟수 (Manual Touch KPI) */
    touchCount: integer('touch_count').notNull().default(0),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    excludedReason: text('excluded_reason'),
    exportJobId: uuid('export_job_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tx_client_period_idx').on(t.clientId, t.period, t.status),
    index('tx_client_date_idx').on(t.clientId, t.transactionDate),
    index('tx_client_merchant_bizno_idx').on(t.clientId, t.merchantBusinessNumber),
    index('tx_client_merchant_key_idx').on(t.clientId, t.merchantKey),
    index('tx_fingerprint_idx').on(t.clientId, t.fingerprint),
    index('tx_status_idx').on(t.status, t.period),
    index('tx_import_job_idx').on(t.importJobId),
    index('tx_export_job_idx').on(t.exportJobId),
    index('tx_merchant_key_global_idx').on(t.merchantKey),
    index('tx_buckets_gin').using('gin', t.buckets),
  ],
);

/** 분류 실행 이력 (엔진이 낸 판단 그대로 — 사람의 수정 전) */
export const classificationResults = pgTable(
  'classification_results',
  {
    id: id(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    engineVersion: text('engine_version').notNull(),
    account: jsonb('account').$type<AccountClassification>().notNull(),
    vat: jsonb('vat').$type<VatClassification>().notNull(),
    risks: jsonb('risks').$type<RiskFlag[]>().notNull().default([]),
    reviewLevel: text('review_level').notNull(),
    batchJobId: uuid('batch_job_id'),
    createdAt: createdAt(),
  },
  (t) => [index('classification_results_tx_idx').on(t.transactionId, t.createdAt)],
);

/** 사람의 수정 = 학습 데이터. 절대 버리지 않는다. */
export const classificationCorrections = pgTable(
  'classification_corrections',
  {
    id: id(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    merchantKey: text('merchant_key').notNull(),
    merchantBusinessNumber: text('merchant_business_number'),
    field: text('field').$type<'account' | 'vat'>().notNull(),
    beforeValue: text('before_value'),
    beforeLabel: text('before_label'),
    afterValue: text('after_value').notNull(),
    afterLabel: text('after_label'),
    /** 수정 당시 엔진 추천 출처 */
    beforeSource: text('before_source'),
    beforeConfidence: integer('before_confidence'),
    reason: text('reason'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 이 수정이 규칙 제안으로 이어졌는지 */
    suggestedRuleId: uuid('suggested_rule_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('corrections_client_merchant_idx').on(t.clientId, t.merchantKey, t.field),
    index('corrections_created_idx').on(t.createdAt),
  ],
);

// ═══════════════════════════════ 규칙 ═══════════════════════════════

export const mappingRules = pgTable(
  'mapping_rules',
  {
    id: id(),
    /** null = 전 거래처 공통 (system_default) */
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    condition: jsonb('condition').$type<Condition>().notNull(),
    accountCode: text('account_code').notNull(),
    accountName: text('account_name').notNull(),
    vatOverride: jsonb('vat_override').$type<{ deductible: boolean; reasonCode?: string } | null>(),
    confidence: integer('confidence').notNull().default(99),
    priority: integer('priority').notNull().default(100),
    /** suggested(System Suggested) | active(User Approved) | disabled | rejected */
    status: text('status').$type<'suggested' | 'active' | 'disabled' | 'rejected'>().notNull(),
    origin: text('origin').$type<'user' | 'system_suggested' | 'system_default'>().notNull(),
    /** 제안 근거 (예: 동일 수정 3회) */
    suggestionReason: text('suggestion_reason'),
    appliedCount: integer('applied_count').notNull().default(0),
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('mapping_rules_client_idx').on(t.clientId, t.status, t.priority)],
);

/** 부가세 공제/불공제 규칙 (관리자 수정 가능, 근거조문 포함) */
export const vatRules = pgTable(
  'vat_rules',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    condition: jsonb('condition').$type<Condition>().notNull(),
    /** non_deductible | deductible | review */
    outcome: text('outcome').$type<'non_deductible' | 'deductible' | 'review'>().notNull(),
    reasonText: text('reason_text').notNull(),
    legalBasis: text('legal_basis'),
    confidence: integer('confidence').notNull().default(90),
    priority: integer('priority').notNull().default(100),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    active: boolean('active').notNull().default(true),
    appliedCount: integer('applied_count').notNull().default(0),
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [unique('vat_rules_code_client_uq').on(t.code, t.clientId).nullsNotDistinct()],
);

/** 고위험 거래 규칙 (금액 기준 등 파라미터는 params 로 — 하드코딩 금지) */
export const reviewRules = pgTable(
  'review_rules',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** 평가기 종류: condition(DSL) | high_amount | new_merchant_high_amount | duplicate_amount | changed_from_history | account_spike | unbalanced | repeated_abnormal */
    kind: text('kind').notNull(),
    condition: jsonb('condition').$type<Condition | null>(),
    params: jsonb('params').$type<Record<string, number | string | boolean | string[]>>().notNull().default({}),
    bucket: text('bucket').$type<ExceptionBucket>().notNull(),
    severity: text('severity').$type<'info' | 'warning' | 'high'>().notNull(),
    blocksAutoApproval: boolean('blocks_auto_approval').notNull().default(true),
    messageTemplate: text('message_template').notNull(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    active: boolean('active').notNull().default(true),
    appliedCount: integer('applied_count').notNull().default(0),
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [unique('review_rules_code_client_uq').on(t.code, t.clientId).nullsNotDistinct()],
);

/** 사무소 설정 (신뢰도 정책, 임계치 등) */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

// ═══════════════════════════════ WEHAGO 전송 / 대사 ═══════════════════════════════

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    period: text('period').notNull(),
    /** wehago_purchase_sales | wehago_general_journal | payroll_earned | payroll_business | payroll_daily | review_excel */
    kind: text('kind').notNull(),
    templateKey: text('template_key').notNull(),
    templateVersion: text('template_version').notNull(),
    /** validating | blocked | ready | downloaded | uploaded_confirmed | failed */
    status: text('status').notNull(),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    /** 사전검증 결과: Source vs Export 합계 */
    validation: jsonb('validation').$type<Record<string, unknown>>().notNull().default({}),
    rowCount: integer('row_count').notNull().default(0),
    supplyAmount: won('supply_amount').notNull().default(0),
    vatAmount: won('vat_amount').notNull().default(0),
    totalAmount: won('total_amount').notNull().default(0),
    blockedReason: text('blocked_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    downloadedAt: timestamp('downloaded_at', { withTimezone: true }),
    uploadConfirmedAt: timestamp('upload_confirmed_at', { withTimezone: true }),
    uploadConfirmedBy: uuid('upload_confirmed_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('export_jobs_client_period_idx').on(t.clientId, t.period, t.kind)],
);

export const exportItems = pgTable(
  'export_items',
  {
    id: id(),
    exportJobId: uuid('export_job_id')
      .notNull()
      .references(() => exportJobs.id, { onDelete: 'cascade' }),
    transactionId: uuid('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
    rowNumber: integer('row_number').notNull(),
    supplyAmount: won('supply_amount').notNull(),
    vatAmount: won('vat_amount').notNull(),
    totalAmount: won('total_amount').notNull(),
    accountCode: text('account_code'),
  },
  (t) => [index('export_items_job_idx').on(t.exportJobId), index('export_items_tx_idx').on(t.transactionId)],
);

export const reconciliationJobs = pgTable(
  'reconciliation_jobs',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    period: text('period').notNull(),
    exportJobId: uuid('export_job_id').references(() => exportJobs.id, { onDelete: 'set null' }),
    /** pre_export (전송 전) | post_export (WEHAGO 역수입 비교) */
    phase: text('phase').$type<'pre_export' | 'post_export'>().notNull(),
    balanced: boolean('balanced').notNull(),
    exportAllowed: boolean('export_allowed').notNull(),
    report: jsonb('report').$type<Record<string, unknown>>().notNull(),
    summary: text('summary').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('recon_client_period_idx').on(t.clientId, t.period, t.createdAt)],
);

// ═══════════════════════════════ 인건비 ═══════════════════════════════

export const employees = pgTable(
  'employees',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    incomeType: text('income_type').$type<'earned' | 'business' | 'daily'>().notNull(),
    /** 주민(외국인)등록번호 — AES-256-GCM 암호문 */
    idNumberEnc: text('id_number_enc'),
    /** HMAC blind index (중복/검색용, 복호화 불가) */
    idNumberHash: text('id_number_hash'),
    idNumberMasked: text('id_number_masked'),
    isForeigner: boolean('is_foreigner').notNull().default(false),
    hireDate: date('hire_date', { mode: 'string' }),
    resignDate: date('resign_date', { mode: 'string' }),
    baseSalary: won('base_salary').notNull().default(0),
    /** 정기 수당 (항목명 → 금액) */
    allowances: jsonb('allowances').$type<Record<string, number>>().notNull().default({}),
    /** 비과세 (식대 등) 항목명 → 금액 */
    nonTaxable: jsonb('non_taxable').$type<Record<string, number>>().notNull().default({}),
    /** 일용직 일당 */
    dailyWage: won('daily_wage'),
    /** 사업소득 업종코드 (940909 등) */
    businessIncomeCode: text('business_income_code'),
    paymentDay: integer('payment_day'),
    bankName: text('bank_name'),
    bankAccountEnc: text('bank_account_enc'),
    bankAccountMasked: text('bank_account_masked'),
    dependents: integer('dependents').notNull().default(1),
    /** 신고상태 메모 (4대보험 취득/상실 등) */
    reportStatus: text('report_status'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('employees_client_idx').on(t.clientId, t.incomeType),
    index('employees_idhash_idx').on(t.clientId, t.idNumberHash),
  ],
);

export const payrollMonths = pgTable(
  'payroll_months',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    /** 귀속월 YYYY-MM */
    period: text('period').notNull(),
    /** 지급월 YYYY-MM */
    paymentPeriod: text('payment_period').notNull(),
    /** Wizard 단계 1~7 */
    wizardStep: integer('wizard_step').notNull().default(1),
    /** draft | reviewing | confirmed | exported | filed */
    status: text('status').notNull().default('draft'),
    diffSummary: jsonb('diff_summary').$type<Record<string, number>>().notNull().default({}),
    totals: jsonb('totals').$type<Record<string, unknown>>().notNull().default({}),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('payroll_months_client_period_uq').on(t.clientId, t.period)],
);

export const payrollItems = pgTable(
  'payroll_items',
  {
    id: id(),
    payrollMonthId: uuid('payroll_month_id')
      .notNull()
      .references(() => payrollMonths.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    incomeType: text('income_type').$type<'earned' | 'business' | 'daily'>().notNull(),
    taxablePay: won('taxable_pay').notNull(),
    nonTaxablePay: won('non_taxable_pay').notNull().default(0),
    grossPay: won('gross_pay').notNull(),
    allowances: jsonb('allowances').$type<Record<string, number>>().notNull().default({}),
    workDays: integer('work_days'),
    incomeTax: won('income_tax').notNull().default(0),
    localIncomeTax: won('local_income_tax').notNull().default(0),
    otherDeductions: won('other_deductions').notNull().default(0),
    netPay: won('net_pay').notNull().default(0),
    paymentDate: date('payment_date', { mode: 'string' }),
    /** 변동 분류 결과 */
    changeKinds: jsonb('change_kinds').$type<string[]>().notNull().default([]),
    needsReview: boolean('needs_review').notNull().default(false),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** carried_forward | imported | manual | calculated */
    origin: text('origin').notNull().default('carried_forward'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payroll_items_month_emp_uq').on(t.payrollMonthId, t.employeeId),
    index('payroll_items_emp_idx').on(t.employeeId),
  ],
);

// ═══════════════════════════════ 신고 ═══════════════════════════════

export const filingJobs = pgTable(
  'filing_jobs',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    /** 지급월 기준 신고 귀속 YYYY-MM */
    period: text('period').notNull(),
    /** withholding (원천세) | local_income_tax | simplified_statement_earned | simplified_statement_business | daily_statement | vat */
    kind: text('kind').notNull(),
    /** FilingStep 별 완료시각 */
    steps: jsonb('steps').$type<Record<string, string | null>>().notNull().default({}),
    currentStep: text('current_step').notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    /** 신고 데이터 요약 (인원/지급액/세액) */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** 신고 방식 — 실제 전자신고 API 없음: FILE_BASED(변환파일/WEHAGO) */
    channelStatus: text('channel_status').notNull().default('FILE_BASED'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('filing_jobs_client_period_kind_uq').on(t.clientId, t.period, t.kind)],
);

export const filingResults = pgTable(
  'filing_results',
  {
    id: id(),
    filingJobId: uuid('filing_job_id')
      .notNull()
      .references(() => filingJobs.id, { onDelete: 'cascade' }),
    /** receipt (접수증) | payment_slip (납부서) | filed_data */
    kind: text('kind').notNull(),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    receiptNumber: text('receipt_number'),
    amount: won('amount'),
    filedAt: timestamp('filed_at', { withTimezone: true }),
    collectedVia: text('collected_via').notNull(), // manual_upload | desktop_bridge | wemembers_file
    createdAt: createdAt(),
  },
  (t) => [index('filing_results_job_idx').on(t.filingJobId)],
);

// ═══════════════════════════════ Job Queue ═══════════════════════════════

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(), // JobType
    status: text('status').notNull().default('queued'), // JobStatus
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>(),
    /** 사용자에게 보여줄 오류 (500 금지 — 다음 행동 포함) */
    errorMessage: text('error_message'),
    progress: real('progress').notNull().default(0),
    totalItems: integer('total_items').notNull().default(0),
    processedItems: integer('processed_items').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    parentJobId: uuid('parent_job_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_queue_idx').on(t.status, t.runAfter),
    index('jobs_parent_idx').on(t.parentJobId),
    index('jobs_created_idx').on(t.createdAt),
  ],
);

// ═══════════════════════════════ 감사 / 운영 ═══════════════════════════════

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name').notNull(),
    /** transaction.approve | transaction.correct | transaction.exclude | rule.create | rule.approve | export.download | employee.view_sensitive | login | ... */
    action: text('action').notNull(),
    /** data_change | access | download | security | system */
    category: text('category').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    /** 사람이 읽는 요약: "쿠팡 72,300원 소모품비 → 공구와기구" */
    summary: text('summary').notNull(),
    beforeData: jsonb('before_data').$type<Record<string, unknown> | null>(),
    afterData: jsonb('after_data').$type<Record<string, unknown> | null>(),
    /** 되돌리기 가능 여부 / 되돌린 로그 */
    revertible: boolean('revertible').notNull().default(false),
    revertedById: uuid('reverted_by_id'),
    revertOfId: uuid('revert_of_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    sessionId: uuid('session_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt),
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_client_idx').on(t.clientId, t.createdAt),
    index('audit_actor_idx').on(t.actorId, t.createdAt),
  ],
);

export const systemErrors = pgTable(
  'system_errors',
  {
    id: id(),
    /** 오류 지문 (동일 원인 묶음) */
    fingerprint: text('fingerprint').notNull(),
    area: text('area').notNull(), // import | classify | export | payroll | web | worker
    message: text('message').notNull(), // 스크럽된 메시지
    userMessage: text('user_message'),
    stack: text('stack'),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    occurrences: integer('occurrences').notNull().default(1),
    /** Controlled Self-Improvement Loop 상태: new | analyzing | fix_proposed | verified | resolved | wont_fix */
    loopStatus: text('loop_status').notNull().default('new'),
    rootCause: text('root_cause'),
    fixProposal: text('fix_proposal'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('system_errors_fp_uq').on(t.fingerprint), index('system_errors_last_idx').on(t.lastSeenAt)],
);

export const aiReviews = pgTable(
  'ai_reviews',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    /** ledger | vat | anomaly */
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    findings: jsonb('findings').$type<Array<Record<string, unknown>>>().notNull().default([]),
    status: text('status').notNull().default('open'), // open | acknowledged | resolved
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('ai_reviews_client_period_idx').on(t.clientId, t.period, t.kind)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    /** null = 전체 */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    /** 문제 알림만: export_error | recon_mismatch | payroll_unreviewed | import_failed | job_failed | rule_suggested */
    kind: text('kind').notNull(),
    severity: text('severity').$type<'info' | 'warning' | 'high'>().notNull(),
    title: text('title').notNull(),
    body: text('body'),
    href: text('href'),
    /** 동일 문제 묶음 키 (중복 알림 방지) */
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.readAt),
    uniqueIndex('notifications_dedupe_uq').on(t.dedupeKey).where(sql`resolved_at is null`),
  ],
);

/** 월별 KPI 스냅샷 (거래처 × 월) */
export const systemMetrics = pgTable(
  'system_metrics',
  {
    id: id(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    totalTransactions: integer('total_transactions').notNull().default(0),
    autoApproved: integer('auto_approved').notNull().default(0),
    noTouch: integer('no_touch').notNull().default(0),
    reviewed: integer('reviewed').notNull().default(0),
    corrected: integer('corrected').notNull().default(0),
    exceptions: integer('exceptions').notNull().default(0),
    manualTouches: integer('manual_touches').notNull().default(0),
    payrollManualTouches: integer('payroll_manual_touches').notNull().default(0),
    reconErrors: integer('recon_errors').notNull().default(0),
    processingSeconds: integer('processing_seconds').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('system_metrics_client_period_uq').on(t.clientId, t.period)],
);
