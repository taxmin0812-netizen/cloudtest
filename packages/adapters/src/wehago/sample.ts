/**
 * 사무소가 WEHAGO 에서 내려받은 실제 엑셀서식 → MIN TAX OPS 템플릿.
 *
 * 서식의 제목행을 읽어 각 열을 표준 항목(ExportField)에 매핑한다. 매핑되지 않은 열은 빈칸('blank')으로 두어
 * 서식의 열 순서·제목을 그대로 재현한다. 필수 항목이 빠지면 verified=false 로 두고 사람이 확인한다.
 */
import { AdapterError } from '../errors';
import { readTabularFile, type ReadOptions } from '../file/read';
import { cellText, isBlankRow, looseHeader, normalizeHeader } from '../util/text';
import { templateHeaderHash, WEHAGO_TEMPLATES, type ExportField, type TemplateColumn, type WehagoTemplate } from './templates';

export interface SampleColumnMatch {
  index: number;
  header: string;
  field: ExportField | null;
  matchedBy: 'header' | 'alias' | 'loose' | null;
}

export interface TemplateFromSampleResult {
  base: WehagoTemplate;
  template: WehagoTemplate;
  columns: SampleColumnMatch[];
  unmatchedHeaders: string[];
  /** 기본 서식의 필수 항목 중 서식에서 찾지 못한 것 */
  missingRequired: ExportField[];
  /** 0~100: 필수 항목 매칭률 */
  confidence: number;
  headerHash: string;
  warnings: string[];
}

export interface TemplateFromSampleOptions {
  /** 기준 템플릿 (키 또는 객체). 없으면 제목 일치도가 가장 높은 템플릿 */
  base?: WehagoTemplate | string;
  key?: string;
  /** 기본: 오늘 날짜 YYYYMMDD */
  version?: string;
  name?: string;
  preambleRows?: string[][];
  sampleRow?: Array<string | number | null> | null;
  sourceFileName?: string;
}

function matchColumns(headers: readonly unknown[], base: WehagoTemplate): SampleColumnMatch[] {
  const used = new Set<ExportField>();
  const byHeader = new Map<string, TemplateColumn>();
  const byAlias = new Map<string, TemplateColumn>();
  for (const c of base.columns) {
    byHeader.set(normalizeHeader(c.header), c);
    for (const a of c.aliases ?? []) if (!byAlias.has(normalizeHeader(a))) byAlias.set(normalizeHeader(a), c);
  }
  return headers.map((h, index) => {
    const header = cellText(h);
    const key = normalizeHeader(header);
    const loose = looseHeader(header);
    const tries: Array<[TemplateColumn | undefined, SampleColumnMatch['matchedBy']]> = [
      [byHeader.get(key), 'header'],
      [byAlias.get(key), 'alias'],
      [byHeader.get(loose) ?? byAlias.get(loose), 'loose'],
    ];
    for (const [col, how] of tries) {
      if (col && col.field !== 'blank' && !used.has(col.field)) {
        used.add(col.field);
        return { index, header, field: col.field, matchedBy: how };
      }
    }
    return { index, header, field: null, matchedBy: null };
  });
}

function resolveBase(base: TemplateFromSampleOptions['base']): WehagoTemplate | null {
  if (!base) return null;
  if (typeof base !== 'string') return base;
  const t = WEHAGO_TEMPLATES.find((x) => x.key === base || x.kind === base);
  if (!t) throw new AdapterError('TEMPLATE_INVALID', `알 수 없는 기준 서식입니다: ${base}`);
  return t;
}

function scoreBase(headers: readonly unknown[], t: WehagoTemplate): number {
  const m = matchColumns(headers, t);
  const matched = new Set(m.map((x) => x.field).filter(Boolean));
  const req = t.columns.filter((c) => c.required);
  const reqHit = req.filter((c) => matched.has(c.field)).length;
  return (req.length ? reqHit / req.length : 0) * 100 + matched.size;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** 제목행 하나로 템플릿 매핑을 만든다. */
export function buildTemplateFromSample(headerRow: readonly unknown[], opts: TemplateFromSampleOptions = {}): TemplateFromSampleResult {
  let trimmed = [...headerRow];
  while (trimmed.length > 0 && cellText(trimmed[trimmed.length - 1]) === '') trimmed.pop();
  if (trimmed.length === 0) throw new AdapterError('TEMPLATE_INVALID', '서식 제목행이 비어 있습니다.');

  const base = resolveBase(opts.base) ?? [...WEHAGO_TEMPLATES].sort((a, b) => scoreBase(trimmed, b) - scoreBase(trimmed, a))[0]!;
  const columns = matchColumns(trimmed, base);
  const matched = new Set(columns.map((c) => c.field).filter((f): f is ExportField => f !== null));
  const required = base.columns.filter((c) => c.required).map((c) => c.field);
  const missingRequired = required.filter((f) => !matched.has(f));
  const warnings: string[] = [];
  const unmatchedHeaders = columns.filter((c) => c.field === null && c.header !== '').map((c) => c.header);
  if (unmatchedHeaders.length > 0) warnings.push(`MIN TAX OPS 가 채우지 않는 열(빈칸 출력): ${unmatchedHeaders.join(', ')}`);
  if (missingRequired.length > 0) warnings.push(`필수 항목을 서식에서 찾지 못했습니다: ${missingRequired.join(', ')} — 열 매핑을 직접 지정해야 합니다.`);
  if (opts.sampleRow) {
    warnings.push('제목 아래 샘플 행을 그대로 유지합니다 (WEHAGO 가 첫 행 샘플을 반영하지 않는 서식으로 가정 — 확인 필요). 재검증은 샘플 행이 서식 원본과 같은지만 확인합니다.');
  }

  const baseCol = new Map(base.columns.map((c) => [c.field, c]));
  const templateColumns: TemplateColumn[] = columns.map((c) => {
    if (!c.field) return { header: c.header, field: 'blank', type: 'text' };
    const b = baseCol.get(c.field)!;
    return { ...b, header: c.header };
  });
  const template: WehagoTemplate = {
    ...base,
    key: opts.key ?? `${base.key}_office`,
    version: opts.version ?? today(),
    name: opts.name ?? `${base.name.replace(/\s*\(.*\)$/, '')} (사무소 서식${opts.sourceFileName ? `: ${opts.sourceFileName}` : ''})`,
    columns: templateColumns,
    preambleRows: opts.preambleRows ?? [],
    sampleRow: opts.sampleRow ?? null,
    status: 'office_sample',
    // 열 제목이 맞아도 유형코드 입력 형식(57 vs 카과)·전자여부 값·일자 형식·샘플행 처리는 아직 확인 전이다.
    // 자동으로 verified=true 로 올리지 않는다 — 첫 업로드 결과(WEHAGO 화면 건수·금액)를 사람이 확인한 뒤 바꾼다.
    verified: false,
    note:
      `사무소 WEHAGO 서식에서 생성 (${matched.size}/${trimmed.length}열 매핑). ` +
      (missingRequired.length ? `누락 필수: ${missingRequired.join(', ')}. ` : '') +
      '검증필요: 유형코드·전자여부·일자 입력 형식은 표준값을 쓴다. 첫 업로드 후 WEHAGO 화면의 건수·금액을 확인하고 verified 로 바꾸세요.',
    docsRef: base.docsRef,
  };
  const confidence = required.length === 0 ? 100 : Math.round(((required.length - missingRequired.length) / required.length) * 100);
  return { base, template, columns, unmatchedHeaders, missingRequired, confidence, headerHash: templateHeaderHash(template), warnings };
}

/** 사무소가 올린 서식 파일(xlsx/csv)에서 제목행을 찾아 템플릿을 만든다. */
export async function buildTemplateFromSampleFile(
  buffer: Buffer,
  fileName: string,
  opts: TemplateFromSampleOptions & { read?: ReadOptions } = {},
): Promise<TemplateFromSampleResult & { sheetName: string; headerRowIndex: number }> {
  const file = await readTabularFile(buffer, fileName, opts.read);
  const sheet = file.sheets.find((s) => !s.hidden) ?? file.sheets[0];
  if (!sheet) throw new AdapterError('TEMPLATE_INVALID', '서식 파일에 시트가 없습니다.');
  const base = resolveBase(opts.base);
  const candidates = base ? [base] : WEHAGO_TEMPLATES;

  let bestRow = -1;
  let bestScore = 0;
  for (let r = 0; r < Math.min(sheet.rows.length, 15); r++) {
    const row = sheet.rows[r]!;
    if (isBlankRow(row)) continue;
    const score = Math.max(...candidates.map((t) => matchColumns(row, t).filter((c) => c.field).length));
    if (score > bestScore) {
      bestScore = score;
      bestRow = r;
    }
  }
  if (bestRow < 0 || bestScore < 3) {
    throw new AdapterError('TEMPLATE_INVALID', '서식 파일에서 제목행을 찾지 못했습니다. WEHAGO "엑셀서식 내려받기" 원본 파일을 올려주세요.', { fileName });
  }
  const preambleRows = sheet.rows.slice(0, bestRow).map((r) => r.map((c) => cellText(c)));
  const next = sheet.rows[bestRow + 1];
  const sampleRow = next && !isBlankRow(next) ? next.map((c) => (c === null ? null : typeof c === 'number' ? c : cellText(c))) : null;
  const result = buildTemplateFromSample(sheet.rows[bestRow]!, {
    ...opts,
    preambleRows: opts.preambleRows ?? preambleRows,
    sampleRow: opts.sampleRow !== undefined ? opts.sampleRow : sampleRow,
    sourceFileName: opts.sourceFileName ?? fileName,
  });
  // 시트 이름도 서식 그대로 (WEHAGO 가 시트 이름을 확인하는지 미확인 — 원본을 따르는 쪽이 안전)
  if (sheet.name.trim()) result.template.sheetName = sheet.name;
  return { ...result, sheetName: sheet.name, headerRowIndex: bestRow };
}
