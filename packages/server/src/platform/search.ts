/**
 * Ctrl+K 통합 검색 (docs/05 §6).
 *
 * 입력 해석: 10자리 숫자(하이픈 허용) → 사업자번호, 쉼표 숫자·"원" → 금액 일치, 2026-09·9월 → 기간, 나머지 → 부분 일치.
 * 그룹: 이동(화면) · 수임처 · 거래처(상대방, 수임처별 집계) · 거래 · 직원(payroll.read) · 계정과목 · 규칙(rules.read) · 명령
 * - 상대방 검색은 merchant_key(normalizeMerchantName) 로 한다: "스타벅스" → 수임처마다 건수·사용 계정·합계
 * - 주민번호·카드번호로는 검색하지 않는다 (입력이 그렇게 보이면 검색하지 않고 안내만)
 * - 그룹별 쿼리는 병렬 실행, 각 LIMIT. 트라이그램 없이 ILIKE / 접두 LIKE(C collation 인덱스) 사용.
 */
import { sql, type SQL } from 'drizzle-orm';
import { formatBusinessNumber } from '@mintax/core';
import type { Permission } from '@mintax/core';
import { requirePermission, type ServiceContext } from '../context';
import { EVIDENCE_LABELS, clampLimit, hrefs, likeContains, likePrefix, num, parseGlobalQuery } from './shared';

export interface ClientHit {
  id: string;
  code: string;
  name: string;
  businessNumber: string;
  representativeName: string | null;
  assigneeName: string | null;
  active: boolean;
  href: string;
}

export interface MerchantClientHit {
  clientId: string;
  clientName: string;
  count: number;
  totalAmount: number;
  /** 사용된 계정 ('830 소모품비') */
  accounts: string[];
  lastDate: string | null;
  href: string;
}

export interface MerchantHit {
  merchantKey: string;
  merchantName: string;
  businessNumber: string | null;
  clientCount: number;
  count: number;
  totalAmount: number;
  lastDate: string | null;
  clients: MerchantClientHit[];
}

export interface TransactionHit {
  id: string;
  clientId: string;
  clientName: string;
  period: string;
  date: string;
  merchantName: string;
  totalAmount: number;
  evidenceLabel: string;
  direction: string;
  accountCode: string | null;
  accountName: string | null;
  status: string;
  href: string;
}

export interface EmployeeHit {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  incomeType: string;
  /** 마스킹된 식별번호만 (원문 없음) */
  idNumberMasked: string | null;
  active: boolean;
  href: string;
}

export interface AccountHit {
  code: string;
  name: string;
  category: string;
  active: boolean;
  href: string;
}

export interface RuleHit {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  accountCode: string;
  accountName: string;
  clientId: string | null;
  clientName: string | null;
  appliedCount: number;
  href: string;
}

export interface NavigationHit {
  label: string;
  href: string;
}

export interface CommandHit {
  label: string;
  href: string;
}

export interface GlobalSearchResult {
  q: string;
  parsed: { amounts: number[]; businessNumber: string | null; period: string | null; text: string };
  navigation: NavigationHit[];
  clients: ClientHit[];
  merchants: MerchantHit[];
  transactions: TransactionHit[];
  employees: EmployeeHit[];
  accounts: AccountHit[];
  rules: RuleHit[];
  commands: CommandHit[];
  total: number;
  tookMs: number;
  notice: string | null;
}

const RULE_STATUS_LABELS: Record<string, string> = { active: '승인됨', suggested: '제안', disabled: '꺼짐', rejected: '거절' };

const SCREENS: Array<{ label: string; href: string; keywords: string[]; permission?: Permission }> = [
  { label: '대시보드', href: '/', keywords: ['대시보드', 'dashboard', '홈'] },
  { label: '예외 검토', href: '/inbox', keywords: ['예외', '검토', 'inbox', '예외함'] },
  { label: '빠른 검토', href: '/inbox/quick', keywords: ['빠른', 'quick'] },
  { label: 'WEHAGO 전송센터', href: '/transfer', keywords: ['전송', 'wehago', '위하고', '대사'], permission: 'export.create' },
  { label: '자료 수집', href: '/imports', keywords: ['수집', '업로드', 'import', '위멤버스'], permission: 'imports.create' },
  { label: '수임처', href: '/clients', keywords: ['수임처', '거래처', 'client'], permission: 'clients.read' },
  { label: '인건비', href: '/payroll', keywords: ['인건비', '급여', 'payroll'], permission: 'payroll.read' },
  { label: '원천세 신고', href: '/filing', keywords: ['원천세', '신고', 'filing', '지급명세서'], permission: 'filing.write' },
  { label: 'AI 장부검토', href: '/review', keywords: ['ai', '장부검토', '이상'] },
  { label: 'Rule Studio', href: '/rules', keywords: ['규칙', 'rule'], permission: 'rules.read' },
  { label: '자동화 KPI', href: '/kpi', keywords: ['kpi', '자동화', '지표'] },
  { label: '감사로그', href: '/audit', keywords: ['감사', 'audit', '로그'], permission: 'audit.read' },
  { label: '설정 · 연동', href: '/settings/integrations', keywords: ['설정', '연동', 'integration'] },
  { label: '보안 설정', href: '/settings/security', keywords: ['보안', 'otp', 'mfa', '비밀번호', '세션'] },
  { label: '사용자·권한', href: '/settings/users', keywords: ['사용자', '권한', 'user'], permission: 'users.manage' },
];

/** 통합 검색 */
export async function globalSearch(ctx: ServiceContext, input: { q: string; limit?: number }): Promise<GlobalSearchResult> {
  requirePermission(ctx, 'clients.read');
  const started = Date.now();
  const limit = clampLimit(input?.limit, 5, 20);
  const refYear = Number(new Date(ctx.now().getTime() + 9 * 3600_000).toISOString().slice(0, 4));
  const p = parseGlobalQuery(input?.q, refYear);
  const has = (perm: Permission) => ctx.actor.permissions.has(perm);
  const empty: GlobalSearchResult = {
    q: p.raw,
    parsed: { amounts: p.amounts, businessNumber: p.businessNumber, period: p.period, text: p.text },
    navigation: [],
    clients: [],
    merchants: [],
    transactions: [],
    employees: [],
    accounts: [],
    rules: [],
    commands: [],
    total: 0,
    tookMs: 0,
    notice: null,
  };
  if (p.raw === '') return empty;
  if (p.sensitive) {
    return { ...empty, notice: '주민등록번호·카드번호로는 검색하지 않습니다. 이름·상호·금액으로 검색해 주세요.', tookMs: Date.now() - started };
  }

  const lowerRaw = p.raw.toLowerCase();
  const navigation = SCREENS.filter((s) => (!s.permission || has(s.permission)) && (s.label.toLowerCase().includes(lowerRaw) || s.keywords.some((k) => lowerRaw.includes(k) || k.includes(lowerRaw))))
    .slice(0, limit)
    .map((s) => ({ label: s.label, href: s.href }));

  const text = p.text;
  const textAll = p.textAll;
  const key = p.merchantKey;
  const tasks: Array<Promise<void>> = [];
  const result: GlobalSearchResult = { ...empty };
  result.navigation = navigation;

  // ── 수임처
  if (has('clients.read') && (textAll || p.businessNumber)) {
    const ors: SQL[] = [];
    if (textAll) {
      ors.push(sql`c.name ilike ${likeContains(textAll)}`, sql`c.code ilike ${likePrefix(textAll)}`, sql`coalesce(c.representative_name, '') ilike ${likeContains(textAll)}`);
      const digits = textAll.replace(/\D/g, '');
      if (digits.length >= 3 && digits.length === textAll.replace(/[-\s]/g, '').length) ors.push(sql`c.business_number like ${likePrefix(digits)}`);
    }
    if (p.businessNumber) ors.push(sql`c.business_number = ${p.businessNumber}`);
    tasks.push(
      ctx.db
        .execute<{ id: string; code: string; name: string; business_number: string; representative_name: string | null; active: boolean; assignee_name: string | null }>(sql`
          select c.id, c.code, c.name, c.business_number, c.representative_name, c.active, u.name as assignee_name
          from clients c left join users u on u.id = c.assignee_id
          where ${sql.join(ors, sql` or `)}
          order by c.active desc, ${textAll ? sql`(c.name ilike ${likePrefix(textAll)})` : sql`false`} desc, c.name, c.id
          limit ${limit}
        `)
        .then((r) => {
          result.clients = r.rows.map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            businessNumber: formatBusinessNumber(c.business_number),
            representativeName: c.representative_name,
            assigneeName: c.assignee_name,
            active: c.active,
            href: hrefs.client(c.id),
          }));
        }),
    );
  }

  // ── 상대방 (수임처별 집계)
  if (has('transactions.read') && (key.length > 0 || p.businessNumber)) {
    const ors: SQL[] = [];
    if (key.length > 0) ors.push(sql`t.merchant_key like ${likeContains(key)}`);
    if (p.businessNumber) ors.push(sql`t.merchant_business_number = ${p.businessNumber}`);
    const periodCond = p.period ? sql`and t.period = ${p.period}` : sql``;
    tasks.push(
      ctx.db
        .execute<{ merchant_key: string; client_id: string; client_name: string; n: number; amount: number; last_date: string | null; display_name: string; accounts: string[] | null; bizno: string | null; key_total: number }>(sql`
          with m as (
            select t.merchant_key, t.client_id, count(*)::int as n, coalesce(sum(t.total_amount), 0)::bigint as amount,
              max(t.transaction_date) as last_date,
              (array_agg(t.merchant_name order by t.transaction_date desc, t.id))[1] as display_name,
              array_remove(array_agg(distinct case when t.account_code is not null then t.account_code || ' ' || coalesce(t.account_name, '') end), null) as accounts,
              max(t.merchant_business_number) as bizno
            from transactions t
            where t.status not in ('duplicate', 'failed') and (${sql.join(ors, sql` or `)}) ${periodCond}
            group by t.merchant_key, t.client_id
          ),
          k as (
            select merchant_key, sum(n)::int as key_total,
              ${key ? sql`((merchant_key = ${key})::int * 2 + (merchant_key like ${likePrefix(key)})::int)` : sql`0`} as closeness
            from m group by merchant_key
            order by closeness desc, key_total desc, merchant_key
            limit ${limit}
          )
          select m.*, c.name as client_name, k.key_total, k.closeness
          from m join k on k.merchant_key = m.merchant_key join clients c on c.id = m.client_id
          order by k.closeness desc, k.key_total desc, m.merchant_key, m.n desc, c.name
        `)
        .then((r) => {
          const byKey = new Map<string, MerchantHit>();
          for (const row of r.rows) {
            let h = byKey.get(row.merchant_key);
            if (!h) {
              h = { merchantKey: row.merchant_key, merchantName: row.display_name, businessNumber: row.bizno, clientCount: 0, count: 0, totalAmount: 0, lastDate: null, clients: [] };
              byKey.set(row.merchant_key, h);
            }
            h.clientCount += 1;
            h.count += num(row.n);
            h.totalAmount += num(row.amount);
            if (row.last_date && (!h.lastDate || row.last_date > h.lastDate)) h.lastDate = row.last_date;
            if (!h.businessNumber && row.bizno) h.businessNumber = row.bizno;
            if (h.clients.length < 10) {
              h.clients.push({
                clientId: row.client_id,
                clientName: row.client_name,
                count: num(row.n),
                totalAmount: num(row.amount),
                accounts: (row.accounts ?? []).map((a) => a.trim()).sort(),
                lastDate: row.last_date,
                href: hrefs.client(row.client_id, 'transactions', { merchant: row.merchant_key }),
              });
            }
          }
          result.merchants = [...byKey.values()];
        }),
    );
  }

  // ── 거래 (금액 일치 · 상호/적요 부분 일치)
  if (has('transactions.read') && (p.amounts.length > 0 || text.length > 0 || p.businessNumber)) {
    const conds: SQL[] = [sql`t.status not in ('duplicate', 'failed')`];
    if (p.amounts.length > 0) conds.push(sql`(t.total_amount = any(${sql.param(p.amounts)}::bigint[]) or t.supply_amount = any(${sql.param(p.amounts)}::bigint[]))`);
    if (text.length > 0) {
      const tors: SQL[] = [sql`t.description ilike ${likeContains(text)}`, sql`t.merchant_name ilike ${likeContains(text)}`];
      if (key.length > 0) tors.push(sql`t.merchant_key like ${likeContains(key)}`);
      conds.push(sql`(${sql.join(tors, sql` or `)})`);
    }
    if (p.businessNumber) conds.push(sql`t.merchant_business_number = ${p.businessNumber}`);
    if (p.period) conds.push(sql`t.period = ${p.period}`);
    tasks.push(
      ctx.db
        .execute<{ id: string; client_id: string; client_name: string; period: string; transaction_date: string; merchant_name: string; total_amount: number; evidence_type: string; direction: string; account_code: string | null; account_name: string | null; status: string }>(sql`
          select t.id, t.client_id, c.name as client_name, t.period, t.transaction_date, t.merchant_name, t.total_amount, t.evidence_type,
            t.direction, t.account_code, t.account_name, t.status
          from transactions t join clients c on c.id = t.client_id
          where ${sql.join(conds, sql` and `)}
          order by t.transaction_date desc, t.id
          limit ${limit}
        `)
        .then((r) => {
          result.transactions = r.rows.map((t) => ({
            id: t.id,
            clientId: t.client_id,
            clientName: t.client_name,
            period: t.period,
            date: t.transaction_date,
            merchantName: t.merchant_name,
            totalAmount: num(t.total_amount),
            evidenceLabel: EVIDENCE_LABELS[t.evidence_type] ?? t.evidence_type,
            direction: t.direction,
            accountCode: t.account_code,
            accountName: t.account_name,
            status: t.status,
            href: hrefs.inbox({ period: t.period, client: t.client_id, tx: t.id }),
          }));
        }),
    );
  }

  // ── 직원 (이름만, 마스킹 식별번호)
  if (has('payroll.read') && text.length > 0) {
    tasks.push(
      ctx.db
        .execute<{ id: string; client_id: string; client_name: string; name: string; income_type: string; id_number_masked: string | null; active: boolean }>(sql`
          select e.id, e.client_id, c.name as client_name, e.name, e.income_type, e.id_number_masked, e.active
          from employees e join clients c on c.id = e.client_id
          where e.name ilike ${likeContains(text)}
          order by e.active desc, e.name, c.name
          limit ${limit}
        `)
        .then((r) => {
          result.employees = r.rows.map((e) => ({
            id: e.id,
            clientId: e.client_id,
            clientName: e.client_name,
            name: e.name,
            incomeType: e.income_type,
            idNumberMasked: e.id_number_masked,
            active: e.active,
            href: hrefs.employee(e.client_id, e.id),
          }));
        }),
    );
  }

  // ── 계정과목
  if (textAll.length > 0) {
    tasks.push(
      ctx.db
        .execute<{ code: string; name: string; category: string; active: boolean }>(sql`
          select a.code, a.name, a.category, a.active from account_codes a
          where a.code = ${textAll} or a.code like ${likePrefix(textAll)} or a.name ilike ${likeContains(textAll)} or a.aliases::text ilike ${likeContains(textAll)}
          order by (a.code = ${textAll}) desc, a.active desc, a.code
          limit ${limit}
        `)
        .then((r) => {
          result.accounts = r.rows.map((a) => ({ code: a.code, name: a.name, category: a.category, active: a.active, href: hrefs.account(a.code) }));
        }),
    );
  }

  // ── 규칙
  if (has('rules.read') && textAll.length > 0) {
    tasks.push(
      ctx.db
        .execute<{ id: string; name: string; status: string; account_code: string; account_name: string; client_id: string | null; client_name: string | null; applied_count: number }>(sql`
          select m.id, m.name, m.status, m.account_code, m.account_name, m.client_id, c.name as client_name, m.applied_count
          from mapping_rules m left join clients c on c.id = m.client_id
          where m.status in ('active', 'suggested')
            and (m.name ilike ${likeContains(textAll)} or m.account_name ilike ${likeContains(textAll)} or m.account_code = ${textAll}
                 or m.condition::text ilike ${likeContains(textAll)} ${key ? sql`or m.condition::text like ${likeContains(key)}` : sql``})
          order by (m.status = 'suggested') desc, m.applied_count desc, m.name
          limit ${limit}
        `)
        .then((r) => {
          result.rules = r.rows.map((m) => ({
            id: m.id,
            name: m.name,
            status: m.status,
            statusLabel: RULE_STATUS_LABELS[m.status] ?? m.status,
            accountCode: m.account_code,
            accountName: m.account_name,
            clientId: m.client_id,
            clientName: m.client_name,
            appliedCount: num(m.applied_count),
            href: hrefs.rules({ rule: m.id }),
          }));
        }),
    );
  }

  await Promise.all(tasks);

  // ── 명령 (결과에서 바로 이어지는 행동)
  const commands: CommandHit[] = [];
  const topMerchant = result.merchants[0];
  if (topMerchant && has('rules.write')) {
    commands.push({ label: `"${topMerchant.merchantName}" 규칙 만들기`, href: `/rules/new?merchant=${encodeURIComponent(topMerchant.merchantKey)}` });
  }
  const topClient = result.clients[0];
  if (topClient && p.period && has('export.create')) {
    commands.push({ label: `${topClient.name} ${p.period} 전송센터 열기`, href: hrefs.transfer({ period: p.period, client: topClient.id }) });
  }
  if (topClient && p.period && has('transactions.read')) {
    commands.push({ label: `${topClient.name} ${p.period} 예외 검토`, href: hrefs.inbox({ period: p.period, client: topClient.id }) });
  }
  if (topClient && p.period && has('payroll.read')) {
    commands.push({ label: `${topClient.name} ${p.period} 급여 마법사`, href: hrefs.payrollWizard(topClient.id, p.period) });
  }
  result.commands = commands.slice(0, limit);
  result.total =
    result.navigation.length + result.clients.length + result.merchants.length + result.transactions.length + result.employees.length + result.accounts.length + result.rules.length + result.commands.length;
  result.tookMs = Date.now() - started;
  return result;
}
