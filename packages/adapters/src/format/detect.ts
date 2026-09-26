/**
 * 헤더 행 탐지 · 형식 프로필 판정.
 *
 * 행 번호를 고정하지 않는다. 상위 N행(기본 30)을 훑어 프로필 앵커 조합이 모두 있는 행을 헤더 후보로 보고
 * 필수/선택 열 일치율·헤더 설명률·제목(파일명) 힌트로 점수를 매긴다.
 */
import { sha256Hex, type Direction } from '@mintax/core';
import { AdapterError } from '../errors';
import type { TabularFile } from '../file/read';
import { cellText, isBlankRow, looseHeader, normalizeHeader } from '../util/text';
import { fieldLabel, type CanonicalField } from './fields';
import { FORMAT_PROFILES, GENERIC_V1, type ColumnSpec, type FormatProfile } from './profiles';

export type ColumnMap = Partial<Record<CanonicalField, number>>;

export interface DetectionCandidate {
  profileId: string;
  headerRowIndex: number;
  confidence: number;
}

export interface FormatDetection {
  profile: FormatProfile;
  /** rows 기준 0-base 헤더 행 위치. 찾지 못하면 -1 */
  headerRowIndex: number;
  /** 0~100 */
  confidence: number;
  /** 누락된 필수 열 (한국어 표시명) */
  missingColumns: string[];
  missingFields: CanonicalField[];
  columnMap: ColumnMap;
  /** 정규화 헤더 목록의 sha256 (레이아웃 지문) */
  headerFingerprint: string | null;
  /** profile.knownHeaderFingerprints 에 등록된 지문인지 */
  fingerprintKnown: boolean;
  /** 사용자 열 매핑 확인이 필요한가 (generic 이거나 신뢰도 부족) */
  requiresUserMapping: boolean;
  /** 사용자가 열 매핑을 확인했는가 */
  userConfirmed: boolean;
  /** 제목행/파일명에서 읽은 매입·매출 힌트 */
  directionHint: Direction | null;
  candidates: DetectionCandidate[];
}

export interface DetectOptions {
  fileName?: string;
  profiles?: readonly FormatProfile[];
  /** 헤더 탐색 행 수 (기본: 프로필 값, 보통 30) */
  scanRows?: number;
  /** 이 신뢰도 미만이면 사용자 열 확인 요구 (기본 MIN_AUTO_CONFIDENCE=60, 사무소 설정으로 조정) */
  minAutoConfidence?: number;
}

/** 이 신뢰도 미만이면 자동 적재하지 않고 사용자 확인을 요구한다 */
export const MIN_AUTO_CONFIDENCE = 60;
const GENERIC_CONFIDENCE_CAP = 50;

// ────────────────────────────── 열 매핑 ──────────────────────────────

interface PreparedSpec {
  spec: ColumnSpec;
  aliases: Set<string>;
  ctxAliases: Set<string> | null;
}

const preparedCache = new WeakMap<FormatProfile, PreparedSpec[]>();

function prepare(profile: FormatProfile): PreparedSpec[] {
  let p = preparedCache.get(profile);
  if (!p) {
    p = profile.columns.map((spec) => ({
      spec,
      aliases: new Set(spec.aliases.map(normalizeHeader)),
      ctxAliases: spec.contextual ? new Set(spec.contextual.aliases.map(normalizeHeader)) : null,
    }));
    preparedCache.set(profile, p);
  }
  return p;
}

/** 헤더 행 하나를 프로필 열 정의로 매핑한다. */
export function resolveColumns(profile: FormatProfile, headerRow: readonly unknown[]): ColumnMap {
  const specs = prepare(profile);
  const exact = headerRow.map(normalizeHeader);
  const loose = headerRow.map(looseHeader);
  const used = new Set<number>();
  const map: ColumnMap = {};

  const find = (pred: (i: number) => boolean, lo = -1, hi = exact.length): number => {
    for (let i = Math.max(0, lo + 1); i < Math.min(hi, exact.length); i++) {
      if (!used.has(i) && exact[i] !== '' && pred(i)) return i;
    }
    return -1;
  };

  // 1차: 어디서든 유일하게 쓰이는 별칭 (정확 일치 → 괄호 제거 일치)
  for (const { spec, aliases } of specs) {
    let i = find((k) => aliases.has(exact[k]!));
    if (i < 0) i = find((k) => aliases.has(loose[k]!));
    if (i >= 0) {
      map[spec.field] = i;
      used.add(i);
    }
  }
  // 2차: 중복 제목 — 앞뒤 열 문맥 안에서만
  for (const { spec, ctxAliases } of specs) {
    if (!ctxAliases || map[spec.field] !== undefined) continue;
    const c = spec.contextual!;
    const lo = c.after !== undefined ? (map[c.after] ?? Number.NaN) : -1;
    const hi = c.before !== undefined ? (map[c.before] ?? exact.length) : exact.length;
    if (Number.isNaN(lo)) continue;
    let i = find((k) => ctxAliases.has(exact[k]!), lo, hi);
    if (i < 0) i = find((k) => ctxAliases.has(loose[k]!), lo, hi);
    if (i >= 0) {
      map[spec.field] = i;
      used.add(i);
    }
  }
  return map;
}

export function headerFingerprintOf(headerRow: readonly unknown[]): string {
  const cells = headerRow.map(normalizeHeader);
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return sha256Hex(cells.join('|'));
}

const rejectCache = new WeakMap<FormatProfile, Set<string>>();

/** 제목행에 이 형식이 아님을 뜻하는 제목(rejectHeaders)이 있는가 */
function rejectedByHeader(profile: FormatProfile, headerRow: readonly unknown[]): boolean {
  if (!profile.rejectHeaders || profile.rejectHeaders.length === 0) return false;
  let set = rejectCache.get(profile);
  if (!set) {
    set = new Set(profile.rejectHeaders.map(normalizeHeader));
    rejectCache.set(profile, set);
  }
  for (const c of headerRow) if (set.has(normalizeHeader(c))) return true;
  return false;
}

function anchorsSatisfied(profile: FormatProfile, map: ColumnMap): boolean {
  return profile.anchors.some((combo) => combo.every((f) => map[f] !== undefined));
}

function missingRequired(profile: FormatProfile, map: ColumnMap): CanonicalField[] {
  return profile.columns.filter((c) => c.required && map[c.field] === undefined).map((c) => c.field);
}

function hintMatched(profile: FormatProfile, text: string): boolean {
  return profile.hintPatterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return false;
    }
  });
}

/**
 * 점수 = 필수열 일치율 60 + 헤더 설명률(매핑된 열 / 비어있지 않은 제목 수) 30 + 제목·파일명 힌트 10.
 * 선택 열(변형 별칭)이 없다고 감점하지 않는다 — 위멤버스·홈택스 변형 별칭이 많기 때문.
 */
function scoreProfile(profile: FormatProfile, headerRow: readonly unknown[], map: ColumnMap, hint: boolean): number {
  const req = profile.columns.filter((c) => c.required);
  const reqRatio = req.length === 0 ? 1 : req.filter((c) => map[c.field] !== undefined).length / req.length;
  const nonEmpty = headerRow.filter((c) => cellText(c) !== '').length;
  const matched = Object.keys(map).length;
  const coverage = nonEmpty === 0 ? 0 : Math.min(1, matched / nonEmpty);
  let score = 60 * reqRatio + 30 * coverage + (hint ? 10 : 0);
  if (profile.requiresUserMapping) score = Math.min(score, GENERIC_CONFIDENCE_CAP);
  return Math.round(score * 10) / 10;
}

function directionOfText(text: string): Direction | null {
  const p = /매입/.test(text);
  const s = /매출/.test(text);
  if (p && !s) return 'purchase';
  if (s && !p) return 'sales';
  return null;
}

/** 제목(첫 비어있지 않은 행) → 파일명 → 헤더 위 전체 순으로 매입/매출 힌트를 찾는다 */
function directionHintOf(rows: readonly (readonly unknown[])[], headerRow: number, fileName: string): Direction | null {
  const titleIdx = rows.findIndex((r) => !isBlankRow(r));
  if (titleIdx >= 0 && titleIdx < headerRow) {
    const d = directionOfText(preambleText(rows.slice(titleIdx, titleIdx + 1), 1));
    if (d) return d;
  }
  return directionOfText(fileName) ?? directionOfText(preambleText(rows, headerRow));
}

function preambleText(rows: readonly (readonly unknown[])[], upto: number): string {
  const parts: string[] = [];
  for (let i = 0; i < Math.min(upto, rows.length); i++) {
    for (const c of rows[i] ?? []) {
      const t = cellText(c);
      if (t) parts.push(t);
    }
  }
  return parts.join(' ');
}

// ────────────────────────────── 판정 ──────────────────────────────

interface Scored {
  profile: FormatProfile;
  row: number;
  map: ColumnMap;
  score: number;
  hint: boolean;
  /** 2 = 필수 열 모두 있음, 1 = 필수 열 일부 누락, 0 = 사용자 매핑 전용(generic) */
  tier: number;
}

function tierOf(profile: FormatProfile, map: ColumnMap): number {
  if (profile.requiresUserMapping) return 0;
  return missingRequired(profile, map).length === 0 ? 2 : 1;
}

export function detectFormat(rows: readonly (readonly unknown[])[], opts: DetectOptions = {}): FormatDetection {
  const profiles = opts.profiles ?? FORMAT_PROFILES;
  const fileText = opts.fileName ?? '';
  const scored: Scored[] = [];

  for (const profile of profiles) {
    const limit = Math.min(rows.length, opts.scanRows ?? profile.headerScanRows);
    let best: Scored | null = null;
    for (let r = 0; r < limit; r++) {
      const row = rows[r];
      if (!row || isBlankRow(row)) continue;
      const map = resolveColumns(profile, row);
      if (!anchorsSatisfied(profile, map)) continue;
      if (rejectedByHeader(profile, row)) continue;
      const hint = hintMatched(profile, `${preambleText(rows, r)} ${fileText}`);
      const score = scoreProfile(profile, row, map, hint);
      const tier = tierOf(profile, map);
      if (!best || tier > best.tier || (tier === best.tier && score > best.score)) best = { profile, row: r, map, score, hint, tier };
    }
    if (best) scored.push(best);
  }

  // 구조(필수 열 완비)가 파일명·제목 힌트보다 우선한다 — 힌트 10점이 필수 열 누락을 뒤집지 못하게
  scored.sort(
    (a, b) =>
      b.tier - a.tier ||
      b.score - a.score ||
      Number(b.hint) - Number(a.hint) ||
      Object.keys(b.map).length - Object.keys(a.map).length ||
      b.profile.priority - a.profile.priority,
  );

  const candidates = scored.slice(0, 5).map((s) => ({ profileId: s.profile.id, headerRowIndex: s.row, confidence: Math.round(s.score) }));
  const top = scored[0];
  if (!top) {
    // 어떤 프로필도 앵커를 찾지 못함 → generic, 첫 비어있지 않은 행을 헤더로 가정
    const guess = rows.findIndex((r) => !isBlankRow(r));
    const headerRow = guess >= 0 ? rows[guess]! : [];
    const map = guess >= 0 ? resolveColumns(GENERIC_V1, headerRow) : {};
    const missing = missingRequired(GENERIC_V1, map);
    return {
      profile: GENERIC_V1,
      headerRowIndex: guess,
      confidence: 0,
      missingColumns: missing.map(fieldLabel),
      missingFields: missing,
      columnMap: map,
      headerFingerprint: guess >= 0 ? headerFingerprintOf(headerRow) : null,
      fingerprintKnown: false,
      requiresUserMapping: true,
      userConfirmed: false,
      directionHint: directionHintOf(rows, Math.max(guess, 0), fileText),
      candidates,
    };
  }

  const headerRow = rows[top.row]!;
  const fp = headerFingerprintOf(headerRow);
  const missing = missingRequired(top.profile, top.map);
  const confidence = Math.round(top.score);
  return {
    profile: top.profile,
    headerRowIndex: top.row,
    confidence,
    missingColumns: missing.map(fieldLabel),
    missingFields: missing,
    columnMap: top.map,
    headerFingerprint: fp,
    fingerprintKnown: top.profile.knownHeaderFingerprints.includes(fp),
    requiresUserMapping: top.profile.requiresUserMapping || confidence < (opts.minAutoConfidence ?? MIN_AUTO_CONFIDENCE) || missing.length > 0,
    userConfirmed: false,
    directionHint: directionHintOf(rows, top.row, fileText),
    candidates,
  };
}

/** 선택되지 않았지만 거래자료로 보이는 시트 (조용한 누락 방지용 안내) */
export interface OtherDataSheet {
  sheetIndex: number;
  sheetName: string;
  profileId: string;
  confidence: number;
  hidden: boolean;
}

export interface FileDetection {
  sheetIndex: number;
  sheetName: string;
  detection: FormatDetection;
  /** 선택 시트 외에 알려진 형식으로 판정되는 시트 — 이번 적재에서 빠지므로 반드시 사용자에게 알린다 */
  otherDataSheets: OtherDataSheet[];
}

/**
 * 여러 시트 중 가장 신뢰도 높은 시트를 고른다 (숨김 시트는 보이는 시트가 없을 때만).
 * opts.sheetIndex 를 주면 그 시트를 쓴다 (다른 시트를 따로 적재할 때).
 */
export function detectFormatInFile(file: TabularFile, opts: DetectOptions & { sheetIndex?: number } = {}): FileDetection {
  const { sheetIndex: forced, ...detectOpts } = opts;
  if (forced !== undefined && (!Number.isInteger(forced) || forced < 0 || forced >= file.sheets.length)) {
    throw new AdapterError('INVALID_CONTEXT', `시트 번호가 올바르지 않습니다 (${forced}). 파일의 시트는 ${file.sheets.length}개입니다.`);
  }
  const all = file.sheets.map((s, i) => ({ s, i, detection: detectFormat(s.rows, detectOpts) }));
  let best: (typeof all)[number] | null = null;
  if (forced !== undefined) {
    best = all[forced]!;
  } else {
    const visible = all.filter(({ s }) => !s.hidden);
    for (const x of visible.length > 0 ? visible : all) {
      const better =
        !best ||
        Number(!x.detection.requiresUserMapping) > Number(!best.detection.requiresUserMapping) ||
        (x.detection.requiresUserMapping === best.detection.requiresUserMapping && x.detection.confidence > best.detection.confidence);
      if (better) best = x;
    }
  }
  if (!best) {
    return { sheetIndex: -1, sheetName: '', detection: detectFormat([], detectOpts), otherDataSheets: [] };
  }
  const otherDataSheets: OtherDataSheet[] = [];
  for (const x of all) {
    if (x === best) continue;
    const known = x.detection.candidates.find((c) => c.profileId !== GENERIC_V1.id);
    if (known) otherDataSheets.push({ sheetIndex: x.i, sheetName: x.s.name, profileId: known.profileId, confidence: known.confidence, hidden: !!x.s.hidden });
  }
  return { sheetIndex: best.i, sheetName: best.s.name, detection: best.detection, otherDataSheets };
}

/**
 * 사용자가 지정한 열 매핑 (필드 → 열 번호 또는 헤더 제목)을 ColumnMap 으로 바꾼다.
 * 헤더 제목은 normalizeHeader 기준으로 비교한다.
 */
export function buildColumnMapFromHeaders(
  headerRow: readonly unknown[],
  mapping: Partial<Record<CanonicalField, string | number>>,
): { columnMap: ColumnMap; unresolved: CanonicalField[] } {
  const norm = headerRow.map(normalizeHeader);
  const columnMap: ColumnMap = {};
  const unresolved: CanonicalField[] = [];
  for (const [field, target] of Object.entries(mapping) as Array<[CanonicalField, string | number]>) {
    if (typeof target === 'number') {
      if (Number.isInteger(target) && target >= 0 && target < headerRow.length) columnMap[field] = target;
      else unresolved.push(field);
      continue;
    }
    const idx = norm.indexOf(normalizeHeader(target));
    if (idx >= 0) columnMap[field] = idx;
    else unresolved.push(field);
  }
  return { columnMap, unresolved };
}

/** 사용자가 확인한 열 매핑으로 판정 결과를 확정한다 (generic 형식 적재용). */
export function confirmColumnMapping(
  profile: FormatProfile,
  rows: readonly (readonly unknown[])[],
  headerRowIndex: number,
  columnMap: ColumnMap,
): FormatDetection {
  const headerRow = rows[headerRowIndex] ?? [];
  const missing = missingRequired(profile, columnMap);
  const fp = headerFingerprintOf(headerRow);
  return {
    profile,
    headerRowIndex,
    confidence: missing.length === 0 ? 100 : 0,
    missingColumns: missing.map(fieldLabel),
    missingFields: missing,
    columnMap: { ...columnMap },
    headerFingerprint: fp,
    fingerprintKnown: profile.knownHeaderFingerprints.includes(fp),
    requiresUserMapping: missing.length > 0,
    userConfirmed: missing.length === 0,
    directionHint: null,
    candidates: [],
  };
}
