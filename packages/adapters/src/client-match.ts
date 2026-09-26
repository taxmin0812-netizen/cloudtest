/**
 * 파일 → 수임처(거래처) 판정.
 *
 * 근거 우선순위 (integration-architecture §4.2 "수임처 판정")
 *  1. 파일 안 수임처 사업자번호 — 세금계산서의 공급받는자/공급자 열에서 모든 행에 반복되는 번호
 *  2. 제목행(헤더 위)에 적힌 사업자번호·상호
 *  3. 파일명 속 사업자번호·상호
 * 결과는 후보 목록(신뢰도 포함)이며, 최종 확정은 사람이 한다 (불일치 시 적재 금지).
 */
import { formatBusinessNumber, normalizeBusinessNumber, normalizeMerchantName } from '@mintax/core';
import { detectFormat, type FormatDetection } from './format/detect';
import { cellText, isBlankRow } from './util/text';

export interface ClientRef {
  id: string;
  businessNumber: string;
  name: string;
}

export interface ClientCandidate {
  clientId: string;
  name: string;
  businessNumber: string;
  /** 0~100 */
  confidence: number;
  reasons: string[];
}

export interface ClientMatchInput {
  rows?: readonly (readonly unknown[])[];
  fileName?: string;
  /** 이미 판정한 형식 (없으면 rows 로 판정) */
  detection?: FormatDetection | null;
}

export interface ClientMatchResult {
  candidates: ClientCandidate[];
  best: ClientCandidate | null;
  /** 후보가 없거나, 1·2위 차이가 작거나, 신뢰도가 낮아 사람이 골라야 함 */
  ambiguous: boolean;
}

const BIZNO_IN_TEXT = /(?<!\d)(\d{3})[-\s]?(\d{2})[-\s]?(\d{5})(?!\d)/g;
const MAX_SCAN_ROWS = 5000;

export function detectClientFromFile(input: ClientMatchInput, clients: readonly ClientRef[]): ClientMatchResult {
  const byBizNo = new Map<string, ClientRef>();
  for (const c of clients) {
    const b = normalizeBusinessNumber(c.businessNumber);
    if (b) byBizNo.set(b, c);
  }
  const acc = new Map<string, { client: ClientRef; score: number; reasons: string[]; sources: Set<string> }>();
  const add = (client: ClientRef, score: number, reason: string, source: string) => {
    const cur = acc.get(client.id) ?? { client, score: 0, reasons: [], sources: new Set<string>() };
    cur.score = Math.max(cur.score, score);
    cur.reasons.push(reason);
    cur.sources.add(source);
    acc.set(client.id, cur);
  };

  const rows = input.rows ?? [];
  const detection = input.detection ?? (rows.length > 0 ? detectFormat(rows, { fileName: input.fileName }) : null);
  const headerRow = detection && detection.headerRowIndex >= 0 ? detection.headerRowIndex : Math.min(rows.length, 10);

  // 1) 데이터 열: 세금계산서 공급자/공급받는자 사업자번호
  if (detection && detection.headerRowIndex >= 0) {
    const cols = [detection.columnMap.buyerBusinessNumber, detection.columnMap.supplierBusinessNumber].filter((x): x is number => x !== undefined);
    if (cols.length > 0) {
      const hits = new Map<string, number>();
      let considered = 0;
      for (let r = detection.headerRowIndex + 1; r < rows.length && considered < MAX_SCAN_ROWS; r++) {
        const row = rows[r];
        if (!row || isBlankRow(row)) continue;
        const nums = new Set(cols.map((i) => normalizeBusinessNumber(cellText(row[i]))).filter((x): x is string => !!x));
        if (nums.size === 0) continue;
        considered++;
        for (const n of nums) if (byBizNo.has(n)) hits.set(n, (hits.get(n) ?? 0) + 1);
      }
      for (const [n, count] of hits) {
        const ratio = considered === 0 ? 0 : count / considered;
        // 모든 행에 나오면 98, 절반이면 69 — 거래 상대방으로 가끔 등장하는 다른 수임처는 낮게
        const score = Math.round(40 + 58 * ratio);
        add(byBizNo.get(n)!, score, `자료 ${considered}행 중 ${count}행에 사업자번호 ${formatBusinessNumber(n)} (공급자/공급받는자)`, 'data');
      }
    }
  }

  // 2) 제목행(헤더 위)
  const preamble: string[] = [];
  for (let r = 0; r < Math.min(headerRow, rows.length); r++) for (const c of rows[r] ?? []) if (cellText(c)) preamble.push(cellText(c));
  const preText = preamble.join(' ');
  for (const n of biznosIn(preText)) {
    const c = byBizNo.get(n);
    if (c) add(c, 95, `제목행에 사업자번호 ${formatBusinessNumber(n)}`, 'preamble');
  }
  for (const c of nameMatches(preText, clients)) add(c, 75, `제목행에 상호 "${c.name}"`, 'preamble');

  // 3) 파일명
  if (input.fileName) {
    const base = input.fileName.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    for (const n of biznosIn(base)) {
      const c = byBizNo.get(n);
      if (c) add(c, 90, `파일명에 사업자번호 ${formatBusinessNumber(n)}`, 'filename');
    }
    for (const c of nameMatches(base, clients)) add(c, 70, `파일명에 상호 "${c.name}"`, 'filename');
  }

  const candidates: ClientCandidate[] = [...acc.values()]
    .map(({ client, score, reasons, sources }) => ({
      clientId: client.id,
      name: client.name,
      businessNumber: client.businessNumber,
      // 서로 다른 근거가 일치하면 가산 (최대 99)
      confidence: Math.min(99, score + (sources.size - 1) * 3),
      reasons,
    }))
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name, 'ko'));

  const best = candidates[0] ?? null;
  const second = candidates[1];
  const ambiguous = !best || best.confidence < 70 || (second !== undefined && best.confidence - second.confidence < 10);
  return { candidates, best, ambiguous };
}

function biznosIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(BIZNO_IN_TEXT)) out.add(`${m[1]}${m[2]}${m[3]}`);
  return [...out];
}

/** 정규화 상호가 텍스트에 포함되는 거래처 (짧은 이름은 오탐 방지 위해 2자 이상, 포함관계면 긴 이름 우선) */
function nameMatches(text: string, clients: readonly ClientRef[]): ClientRef[] {
  const key = normalizeMerchantName(text);
  if (!key) return [];
  const hits = clients.filter((c) => {
    const k = normalizeMerchantName(c.name);
    return k.length >= 2 && key.includes(k);
  });
  return hits.filter((c) => {
    const k = normalizeMerchantName(c.name);
    return !hits.some((o) => o !== c && normalizeMerchantName(o.name).length > k.length && normalizeMerchantName(o.name).includes(k));
  });
}
