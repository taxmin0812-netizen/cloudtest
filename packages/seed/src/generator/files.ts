import { formatBusinessNumber, totalsOf, type AmountTotals, type YearMonth } from '@mintax/core';
import { FILE_LAYOUTS, type FileLayout } from './layouts';
import type { SyntheticDataset, SyntheticFileKind, SyntheticTransaction } from './types';

export {
  CARD_SALES_HEADERS,
  CASH_RECEIPT_SALES_HEADERS,
  FILE_LAYOUTS,
  HOMETAX_CARD_HEADERS,
  HOMETAX_CASH_RECEIPT_HEADERS,
  HOMETAX_INVOICE_EXEMPT_HEADERS,
  HOMETAX_TAX_INVOICE_HEADERS,
} from './layouts';

/**
 * 2026-09 원천 파일 (헤더 + 행 배열). xlsx 쓰기는 로더/테스트가 adapters 로 한다.
 * 행 구성: [제목·조회조건 행…] + [헤더] + [데이터…]. headerRowIndex 가 헤더 위치(0-base).
 */
export interface SyntheticFile {
  kind: SyntheticFileKind;
  clientCode: string;
  period: YearMonth;
  fileName: string;
  sheetName: string;
  /** adapters FormatProfile id (없으면 null) */
  profileId: string | null;
  rows: unknown[][];
  headerRowIndex: number;
  header: string[];
  dataRowCount: number;
  /** 데이터 행 순서대로 거래 id (실패 행은 SyntheticFailureRow.id) */
  rowIds: string[];
  /** 파싱 가능한 거래 합계 (실패 행 제외) */
  totals: AmountTotals;
  failureRowIds: string[];
}

const FILE_LABEL: Record<SyntheticFileKind, string> = {
  card_purchase: '사업용카드매입',
  card_purchase_resend: '사업용카드재전송',
  cash_receipt_purchase: '현금영수증매입',
  tax_invoice_purchase: '전자세금계산서매입',
  tax_invoice_sales: '전자세금계산서매출',
  invoice_exempt_purchase: '전자계산서매입',
  invoice_exempt_sales: '전자계산서매출',
  card_sales: '카드매출',
  cash_receipt_sales: '현금영수증매출',
};

export const FILE_KINDS = Object.keys(FILE_LABEL) as SyntheticFileKind[];

/** 거래가 어떤 원천 파일에 실리는가 */
export function fileKindOf(t: SyntheticTransaction): SyntheticFileKind | null {
  if (t.channel === 'desktop_bridge') return t.evidenceType === 'card' && t.direction === 'purchase' ? 'card_purchase_resend' : null;
  const purchase = t.direction === 'purchase';
  switch (t.evidenceType) {
    case 'card':
      return purchase ? 'card_purchase' : 'card_sales';
    case 'cash_receipt':
      return purchase ? 'cash_receipt_purchase' : 'cash_receipt_sales';
    case 'tax_invoice':
      return purchase ? 'tax_invoice_purchase' : 'tax_invoice_sales';
    case 'invoice_exempt':
      return purchase ? 'invoice_exempt_purchase' : 'invoice_exempt_sales';
    default:
      return null;
  }
}

function preamble(kind: SyntheticFileKind, ds: SyntheticDataset, clientCode: string, txs: SyntheticTransaction[]): unknown[][] {
  const client = ds.clients.find((c) => c.code === clientCode)!;
  const [y, m] = ds.currentMonth.split('-').map(Number) as [number, number];
  const period = `${ds.currentMonth}-01 ~ ${ds.currentMonth}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const invoiceHead = (title: string): unknown[][] => [
    [title],
    ['조회기간', period],
    ['사업자등록번호', formatBusinessNumber(client.businessNumber)],
    ['상호', client.name],
    [],
  ];
  switch (kind) {
    case 'card_purchase':
      return [[`총 사용금액 : ${txs.reduce((a, t) => a + t.totalAmount, 0).toLocaleString('ko-KR')}`]];
    case 'card_purchase_resend':
      return [['사업용 신용카드 매입내역 재전송분 (합성)']];
    case 'cash_receipt_purchase':
      return [['현금영수증 매입내역(지출증빙) 조회']];
    case 'tax_invoice_purchase':
      return invoiceHead('전자세금계산서 목록조회 (매입)');
    case 'tax_invoice_sales':
      return invoiceHead('전자세금계산서 목록조회 (매출)');
    case 'invoice_exempt_purchase':
      return invoiceHead('전자계산서 목록조회 (매입)');
    case 'invoice_exempt_sales':
      return invoiceHead('전자계산서 목록조회 (매출)');
    case 'card_sales':
      return [['신용카드 매출내역']];
    case 'cash_receipt_sales':
      return [['현금영수증 매출내역']];
  }
}

function rowOf(layout: FileLayout, raw: Record<string, unknown>): unknown[] {
  return layout.keys.map((k) => {
    const v = raw[k];
    return v === undefined || v === null ? '' : v;
  });
}

/** 한 거래처·한 종류의 원천 파일. 해당 자료가 없으면 null */
export function buildSourceFile(ds: SyntheticDataset, clientCode: string, kind: SyntheticFileKind): SyntheticFile | null {
  const layout = FILE_LAYOUTS[kind];
  const txs = ds.current.filter((t) => t.clientCode === clientCode && fileKindOf(t) === kind);
  const fails = ds.failures.filter((f) => f.clientCode === clientCode && f.fileKind === kind);
  if (txs.length === 0 && fails.length === 0) return null;
  const items: Array<{ id: string; date: string; raw: Record<string, unknown> }> = [
    ...txs.map((t) => ({ id: t.id, date: t.transactionDate, raw: t.rawData })),
    ...fails.map((f) => ({ id: f.id, date: String(f.rawData['승인일자'] ?? f.rawData['작성일자'] ?? ''), raw: f.rawData })),
  ];
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pre = preamble(kind, ds, clientCode, txs);
  const header = [...layout.headers];
  return {
    kind,
    clientCode,
    period: ds.currentMonth,
    fileName: `${clientCode}_${FILE_LABEL[kind]}_${ds.currentMonth.replace('-', '')}.xlsx`,
    sheetName: FILE_LABEL[kind],
    profileId: layout.profileId,
    rows: [...pre, header, ...items.map((it) => rowOf(layout, it.raw))],
    headerRowIndex: pre.length,
    header,
    dataRowCount: items.length,
    rowIds: items.map((it) => it.id),
    totals: totalsOf(txs),
    failureRowIds: fails.map((f) => f.id),
  };
}

/** 사업용카드 매입 파일 (홈택스 14열) */
export function buildCardPurchaseFile(ds: SyntheticDataset, clientCode: string): SyntheticFile | null {
  return buildSourceFile(ds, clientCode, 'card_purchase');
}

/** 현금영수증 매입 파일 */
export function buildCashReceiptFile(ds: SyntheticDataset, clientCode: string): SyntheticFile | null {
  return buildSourceFile(ds, clientCode, 'cash_receipt_purchase');
}

/** 전자세금계산서 목록 (매입/매출) */
export function buildTaxInvoiceFile(ds: SyntheticDataset, clientCode: string, direction: 'purchase' | 'sales'): SyntheticFile | null {
  return buildSourceFile(ds, clientCode, direction === 'purchase' ? 'tax_invoice_purchase' : 'tax_invoice_sales');
}

/** 전자계산서(면세) 목록 (매입/매출) */
export function buildExemptInvoiceFile(ds: SyntheticDataset, clientCode: string, direction: 'purchase' | 'sales'): SyntheticFile | null {
  return buildSourceFile(ds, clientCode, direction === 'purchase' ? 'invoice_exempt_purchase' : 'invoice_exempt_sales');
}

/** 완전중복 재전송분 (승인번호 포함 변형) */
export function buildResendFile(ds: SyntheticDataset, clientCode: string): SyntheticFile | null {
  return buildSourceFile(ds, clientCode, 'card_purchase_resend');
}

/** 한 거래처의 모든 원천 파일 */
export function buildClientFiles(ds: SyntheticDataset, clientCode: string): SyntheticFile[] {
  return FILE_KINDS.map((k) => buildSourceFile(ds, clientCode, k)).filter((f): f is SyntheticFile => f !== null);
}

/** 전체 수임처의 2026-09 원천 파일 */
export function buildAllFiles(ds: SyntheticDataset): SyntheticFile[] {
  return ds.clients.flatMap((c) => buildClientFiles(ds, c.code));
}
