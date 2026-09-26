/**
 * 급여대장 검토용 엑셀 (사무소 내부 검토·보관용 — WEHAGO 업로드 파일 아님).
 * 시트: 요약 · 급여대장 · 변동 내역 · 원천세 요약. 주민번호는 마스킹본만 넣고, 저장 전에 원문 형태가 없는지 다시 검사한다.
 */
import { exportJobs } from '@mintax/db';
import { formatDiffSummary } from '@mintax/core/payroll/index';
import { AppError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { storeFile } from '../infra/storage';
import { loadExcelJS, type XWorksheet } from '../payroll/excel';
import { CHANGE_KIND_LABELS, PAYROLL_STATUS_LABELS, XLSX_MIME, assertUuid, containsRawRrn, incomeTypeLabel, sumLines } from '../payroll/helpers';
import { computeMonthState, nameOf } from '../payroll/month-engine';
import { loadEmployeeCodes, loadMonthContext, totalsOf } from '../payroll/store';
import { runPayrollValidation } from '../payroll/validation';
import { computeWithholding } from '../payroll/withholding';
import type { ReviewExcelResult } from './types';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

function header(ws: XWorksheet, rowNo: number, titles: string[], widths?: number[]): void {
  const row = ws.getRow(rowNo);
  titles.forEach((h, i) => {
    const c = row.getCell(i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = HEADER_FILL;
    if (widths?.[i]) ws.getColumn(i + 1).width = widths[i];
  });
}

function put(ws: XWorksheet, rowNo: number, values: unknown[], moneyCols: number[] = []): void {
  const row = ws.getRow(rowNo);
  values.forEach((v, i) => {
    const c = row.getCell(i + 1);
    c.value = v === undefined ? null : v;
    if (moneyCols.includes(i + 1)) c.numFmt = '#,##0';
  });
}

/** 검토용 엑셀 생성 → 암호화 저장 + export_jobs(kind=review_excel) + 다운로드 감사 */
export async function generateReviewExcel(ctx: ServiceContext, input: { payrollMonthId: string }): Promise<ReviewExcelResult> {
  requirePermission(ctx, 'payroll.read');
  const id = assertUuid(input?.payrollMonthId, 'payrollMonthId', '급여 월');
  const mc = await loadMonthContext(ctx, id);
  const m = mc.month;
  const [s, w, v, codes] = await Promise.all([
    computeMonthState(ctx, id, mc),
    computeWithholding(ctx, id, mc),
    runPayrollValidation(ctx, id, { persist: false, mc }),
    loadEmployeeCodes(ctx, m.clientId),
  ]);
  const t = totalsOf(m);
  const sums = sumLines(s.currLines);
  const ExcelJS = loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MIN TAX OPS';
  wb.created = ctx.now();
  wb.modified = ctx.now();

  // ── 요약
  const sum = wb.addWorksheet('요약');
  sum.getColumn(1).width = 26;
  sum.getColumn(2).width = 46;
  sum.getCell('A1').value = `${mc.clientName} ${m.period} 급여 검토표 (검토용 — WEHAGO 업로드 파일 아님)`;
  sum.getCell('A1').font = { bold: true, size: 13 };
  const info: Array<[string, unknown]> = [
    ['수임처', `${mc.clientName} (${mc.clientCode})`],
    ['귀속월 / 지급월', `${m.period} / ${m.paymentPeriod}`],
    ['상태', `${PAYROLL_STATUS_LABELS[m.status] ?? m.status} (마법사 ${m.wizardStep}단계)`],
    ['원천세 납부 주기', mc.semiannual ? '반기납부' : '매월'],
    ['인원', sums.headcount],
    ['과세 합계', sums.taxablePay],
    ['비과세 합계', sums.nonTaxablePay],
    ['지급총액', sums.grossPay],
    ['소득세', sums.incomeTax],
    ['지방소득세', sums.localIncomeTax],
    ['기타공제', sums.otherDeductions],
    ['차인지급액', sums.netPay],
    ['전월 대비', formatDiffSummary(s.diff.summary)],
    ['검산', v.summary],
    ['원천세 기한', `${w.dto.dueDate}${w.dto.dueNote ? ` (${w.dto.dueNote})` : ''}`],
    ['신고 요약 = 급여 행 합계', w.dto.consistency.ok ? '일치 (1원 단위)' : `불일치: ${w.dto.consistency.mismatches.join(' / ')}`],
    ['인건비 수동 터치', t.manualTouches ?? 0],
    ['생성', `${ctx.now().toISOString()} · ${ctx.actor.name}`],
  ];
  info.forEach(([k, val], i) => put(sum, i + 3, [k, val], typeof val === 'number' && i >= 5 && i <= 11 ? [2] : []));
  const byTypeRow = info.length + 5;
  header(sum, byTypeRow, ['소득구분', '인원', '지급총액', '소득세', '지방소득세', '차인지급액'], [26, 10, 16, 14, 14, 16]);
  (['earned', 'business', 'daily'] as const).forEach((tp, i) => {
    const x = sums.byIncomeType[tp];
    put(sum, byTypeRow + 1 + i, [incomeTypeLabel(tp), x.headcount, x.grossPay, x.incomeTax, x.localIncomeTax, x.netPay], [3, 4, 5, 6]);
  });

  // ── 급여대장
  const ledger = wb.addWorksheet('급여대장');
  header(
    ledger,
    1,
    ['사원코드', '성명', '소득구분', '주민번호(마스킹)', '지급일', '근무일수', '과세', '비과세', '지급총액', '소득세', '지방소득세', '기타공제', '차인지급액', '변동', '검토', '출처'],
    [10, 10, 10, 16, 12, 8, 14, 12, 14, 12, 12, 12, 14, 22, 8, 12],
  );
  ledger.views = [{ state: 'frozen', ySplit: 1 }];
  const items = [...s.items].sort((a, b) => a.incomeType.localeCompare(b.incomeType) || nameOf(s.empById, a.employeeId).localeCompare(nameOf(s.empById, b.employeeId), 'ko'));
  items.forEach((it, i) => {
    const emp = s.empById.get(it.employeeId);
    const kinds = (it.changeKinds ?? []).map((k) => CHANGE_KIND_LABELS[k as keyof typeof CHANGE_KIND_LABELS] ?? k).join('·');
    put(
      ledger,
      i + 2,
      [
        codes[it.employeeId]?.code ?? '',
        emp?.name ?? '',
        incomeTypeLabel(it.incomeType),
        emp?.idNumberMasked ?? '미등록',
        it.paymentDate ?? '',
        it.workDays ?? null,
        it.taxablePay,
        it.nonTaxablePay,
        it.grossPay,
        it.incomeTax,
        it.localIncomeTax,
        it.otherDeductions,
        it.netPay,
        kinds,
        it.needsReview ? (it.reviewedAt ? '확인' : '대기') : '-',
        it.origin,
      ],
      [7, 8, 9, 10, 11, 12, 13],
    );
  });
  const totalRow = items.length + 2;
  put(ledger, totalRow, ['합계', `${sums.headcount}명`, '', '', '', null, sums.taxablePay, sums.nonTaxablePay, sums.grossPay, sums.incomeTax, sums.localIncomeTax, sums.otherDeductions, sums.netPay], [7, 8, 9, 10, 11, 12, 13]);
  ledger.getRow(totalRow).font = { bold: true };

  // ── 변동 내역 (검토 대상만)
  const ch = wb.addWorksheet('변동 내역');
  header(ch, 1, ['성명', '변동', '심각도', '전월 지급총액', '이번 달 지급총액', '증감률(%)', '메시지', '확인'], [10, 22, 8, 16, 16, 10, 60, 8]);
  const changes = s.diff.changes.filter((c) => c.needsReview || s.reviewedOf(c.employeeId).decision);
  changes.forEach((c, i) => {
    const r = s.reviewedOf(c.employeeId);
    put(
      ch,
      i + 2,
      [c.name, c.kinds.map((k) => CHANGE_KIND_LABELS[k]).join('·'), c.severity, c.previous?.grossPay ?? null, c.current?.grossPay ?? null, c.changeRate, c.messages.join(' / '), r.reviewed ? r.decision ?? '확인' : '대기'],
      [4, 5],
    );
  });
  if (changes.length === 0) put(ch, 2, ['변동 없음 — 전월과 같습니다.']);

  // ── 원천세 요약
  const wh = wb.addWorksheet('원천세 요약');
  header(wh, 1, ['코드', '구분', '인원', '총지급액', '징수세액'], [8, 22, 8, 16, 14]);
  w.dto.rows.forEach((r, i) => put(wh, i + 2, [r.code, r.label, r.persons, r.totalPay, r.incomeTax], [4, 5]));
  let rr = w.dto.rows.length + 3;
  put(wh, rr++, ['지방소득세', '특별징수 (소득세의 10%)', null, null, w.dto.localIncomeTax.declared], [5]);
  put(wh, rr++, ['기한', `${w.dto.dueDate}${w.dto.dueNote ? ` (${w.dto.dueNote})` : ''}`]);
  rr++;
  header(wh, rr++, ['지급명세서', '제출주기', '인원', '지급액', '기한']);
  for (const st of w.dto.statements) put(wh, rr++, [st.label, st.cycle === 'semiannual' ? `반기 (${st.submissionPeriod.from}~${st.submissionPeriod.to})` : '매월', st.persons, st.paidAmount, st.dueDate], [4]);
  rr++;
  put(wh, rr++, ['안내', w.dto.note]);
  for (const note of w.dto.notCovered) put(wh, rr++, ['미포함', note]);
  for (const warn of w.dto.warnings) put(wh, rr++, ['경고', warn]);

  // 민감정보 방어 점검: 원문 주민번호 형태가 있으면 저장하지 않는다
  for (const sheet of wb.worksheets) {
    sheet.eachRow((row) => {
      for (const cell of row.values) {
        if (typeof cell === 'string' && containsRawRrn(cell)) {
          throw new AppError({ code: 'SENSITIVE_IN_REPORT', httpStatus: 500, userMessage: '검토용 엑셀에 주민번호 원문이 들어갈 뻔해 생성을 중단했습니다. 관리자에게 알려 주세요.' });
        }
      }
    });
  }
  const data = Buffer.from(await wb.xlsx.writeBuffer());
  const clean = (x: string) => x.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const fileName = `${clean(mc.clientCode)}_${clean(mc.clientName)}_${m.period}_급여검토표.xlsx`;
  const stored = await storeFile(ctx, { data, originalName: fileName, mimeType: XLSX_MIME, purpose: 'review_excel', clientId: m.clientId });
  const [job] = await ctx.db
    .insert(exportJobs)
    .values({
      clientId: m.clientId,
      period: m.period,
      kind: 'review_excel',
      templateKey: 'mintax_payroll_review',
      templateVersion: 'v1',
      status: 'ready',
      fileId: stored.id,
      validation: { payrollMonthId: m.id, fileName, purpose: 'payroll_review', note: '검토용 — WEHAGO 업로드 파일 아님' },
      rowCount: items.length,
      totalAmount: sums.grossPay,
      createdBy: ctx.actor.userId,
      createdAt: ctx.now(),
      downloadedAt: ctx.now(),
    })
    .returning({ id: exportJobs.id });
  await writeAudit(ctx, {
    action: 'export.review_excel',
    category: 'download',
    entityType: 'payroll_month',
    entityId: m.id,
    clientId: m.clientId,
    summary: `${mc.clientName} ${m.period} 급여 검토표 엑셀 받음 (${items.length}명, 지급총액 ${sums.grossPay.toLocaleString('ko-KR')}원, 주민번호 마스킹)`,
    after: { fileId: stored.id, exportJobId: job!.id, rows: items.length },
  });
  return {
    exportJobId: job!.id,
    fileId: stored.id,
    fileName,
    mimeType: XLSX_MIME,
    data,
    sizeBytes: data.length,
    sha256: stored.sha256,
    sheets: wb.worksheets.map((x) => x.name),
  };
}
