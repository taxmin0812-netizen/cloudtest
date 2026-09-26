/**
 * 자료 수집 — 내부 공용 (판정 DTO, 열 매핑 확정, 수임처 판정, 이전 가져오기 조회).
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { formatBusinessNumber, normalizeBusinessNumber } from '@mintax/core';
import { clients, files, importJobs, type DbOrTx } from '@mintax/db';
import {
  buildColumnMapFromHeaders,
  cellText,
  confirmColumnMapping,
  fieldLabel,
  getFormatProfile,
  GENERIC_V1,
  type ClientMatchResult,
  type ClientRef,
  type FormatDetection,
  type ImportPreview,
} from '@mintax/adapters';
import { ValidationError } from '@mintax/security';
import { ImportRejectedError, importHref } from './errors';
import { CLIENT_AUTO_CONFIDENCE, NEEDS_MAPPING_TAG, buildImportSummary, deriveImportState, formatCount } from './helpers';
import type { ImportClientCandidateDTO, ImportDetectionDTO, ImportMappingInput } from './types';

/** 활성 수임처 목록 (수임처 판정용 — 사무소 규모에서 수백 건) */
export async function loadClientRefs(db: DbOrTx): Promise<Array<ClientRef & { code: string }>> {
  return db.select({ id: clients.id, businessNumber: clients.businessNumber, name: clients.name, code: clients.code }).from(clients).where(eq(clients.active, true));
}

export function toCandidateDTO(match: ClientMatchResult | null): ImportClientCandidateDTO[] {
  return (match?.candidates ?? []).map((c) => ({
    clientId: c.clientId,
    name: c.name,
    businessNumber: formatBusinessNumber(normalizeBusinessNumber(c.businessNumber) ?? c.businessNumber),
    confidence: c.confidence,
    reasons: c.reasons,
  }));
}

/** "파일 내용으로 확신할 수 있는 수임처가 정확히 하나"일 때만 자동 확정 (그 외에는 한 번 묻는다) */
export function autoClientOf(match: ClientMatchResult | null): string | null {
  if (!match || match.ambiguous || !match.best) return null;
  const confident = match.candidates.filter((c) => c.confidence >= CLIENT_AUTO_CONFIDENCE);
  return confident.length === 1 && confident[0]!.clientId === match.best.clientId ? match.best.clientId : null;
}

/** 선택한 수임처와 파일 속 수임처가 다르면(근거 확실) 적재하지 않는다 */
export function assertNoClientConflict(match: ClientMatchResult | null, clientId: string, clientName: string, allow: boolean | undefined): void {
  const best = match?.best;
  if (allow || !best || match!.ambiguous || best.confidence < 90 || best.clientId === clientId) return;
  throw new ImportRejectedError(
    'IMPORT_CLIENT_MISMATCH',
    `파일 속 수임처는 ${best.name}(${formatBusinessNumber(normalizeBusinessNumber(best.businessNumber) ?? best.businessNumber)})로 보이는데, 선택한 수임처는 ${clientName}입니다. 수임처를 다시 선택하거나, 맞다면 "그래도 가져오기"를 선택하세요.`,
    { details: { detectedClientId: best.clientId, reasons: best.reasons } },
  );
}

export function detectionDTO(preview: ImportPreview | null, detection: FormatDetection | null, clientId: string | null, auto: boolean): ImportDetectionDTO {
  const d = detection ?? preview?.detection ?? null;
  const known = d && d.headerRowIndex >= 0 && d.profile.id !== GENERIC_V1.id;
  return {
    profileKey: known ? d.profile.id : null,
    profileName: known ? d.profile.name : null,
    confidence: d?.confidence ?? 0,
    requiresUserMapping: d ? d.requiresUserMapping && !d.userConfirmed : true,
    missingColumns: d?.missingColumns ?? [],
    profileVerified: d?.profile.verified ?? false,
    clientCandidates: toCandidateDTO(preview?.client ?? null),
    clientId,
    clientAutoDetected: auto,
  };
}

/** 알 수 없는 서식 안내: "알 수 없는 서식입니다. 첫 줄 제목: 승인일자, 카드사, 카드번호 …" */
export function needsMappingMessage(preview: ImportPreview): string {
  const d = preview.detection;
  const headerRow = d.headerRowIndex >= 0 ? (preview.rows[d.headerRowIndex] ?? []) : (preview.rows.find((r) => r && r.length > 0) ?? []);
  const titles = headerRow.map((c) => cellText(c)).filter(Boolean);
  const shown = titles.slice(0, 6).join(', ') + (titles.length > 6 ? ' …' : '');
  const known = d.profile.id !== GENERIC_V1.id && d.headerRowIndex >= 0;
  const head = known
    ? `${d.profile.name} 형식으로 보이지만 필수 열${d.missingColumns.length > 0 ? `(${d.missingColumns.join(', ')})` : ''}을 확인해야 합니다.`
    : '알 수 없는 서식입니다.';
  return `${NEEDS_MAPPING_TAG} ${head}${shown ? ` 첫 줄 제목: ${shown}` : ''} — 수임처·서식(열)을 직접 지정하세요.`;
}

/**
 * 사용자 열 매핑 → 확정된 FormatDetection. 해결되지 않은 열·필수 열 누락은 ValidationError.
 */
export function detectionFromMapping(preview: ImportPreview, mapping: ImportMappingInput): FormatDetection {
  const profile = (mapping.profileKey ? getFormatProfile(mapping.profileKey) : undefined) ?? preview.detection.profile ?? GENERIC_V1;
  if (mapping.profileKey && !getFormatProfile(mapping.profileKey)) {
    throw new ValidationError(`알 수 없는 서식입니다: ${mapping.profileKey}. 목록에서 서식을 다시 선택하세요.`, [{ field: 'mapping.profileKey', message: '알 수 없는 서식' }]);
  }
  if (profile.purpose !== 'transactions') {
    throw new ValidationError('이 서식은 거래 자료가 아닙니다(WEHAGO 역수입 대사용). 전송센터의 대사 화면에서 올려 주세요.');
  }
  const headerRowIndex = mapping.headerRowIndex ?? preview.detection.headerRowIndex;
  if (!Number.isInteger(headerRowIndex) || headerRowIndex < 0 || headerRowIndex >= preview.rows.length) {
    throw new ValidationError('제목(헤더) 행 위치가 올바르지 않습니다. 제목 행을 다시 선택하세요.', [{ field: 'mapping.headerRowIndex', message: '범위 밖' }]);
  }
  const { columnMap, unresolved } = buildColumnMapFromHeaders(preview.rows[headerRowIndex] ?? [], mapping.columns ?? {});
  if (unresolved.length > 0) {
    throw new ValidationError(
      `지정한 열을 제목 행에서 찾지 못했습니다: ${unresolved.map(fieldLabel).join(', ')}. 열을 다시 선택하세요.`,
      unresolved.map((f) => ({ field: `mapping.columns.${f}`, message: '열을 찾지 못함' })),
    );
  }
  const detection = confirmColumnMapping(profile, preview.rows, headerRowIndex, columnMap);
  if (detection.requiresUserMapping) {
    throw new ValidationError(
      `필수 열이 지정되지 않았습니다: ${detection.missingColumns.join(', ')}. 해당 열을 지정하세요.`,
      detection.missingFields.map((f) => ({ field: `mapping.columns.${f}`, message: '필수' })),
    );
  }
  if (profile.direction === null && !mapping.direction) {
    throw new ValidationError('이 서식은 매입/매출 구분을 직접 지정해야 합니다.', [{ field: 'mapping.direction', message: '필수' }]);
  }
  return detection;
}

/**
 * 같은 파일(sha256)을 같은 수임처에 이미 가져온 기록 (실패 제외).
 * clientId: 특정 수임처 / null = 수임처 미정 가져오기 / 'any' = 수임처 무관 (수임처를 모를 때 — 이미 어느 수임처로 가져온 파일이면 그것이 답이다)
 */
export async function findPreviousImport(
  db: DbOrTx,
  sha256: string,
  clientId: string | null | 'any',
  excludeImportJobId?: string,
): Promise<{ id: string; createdAt: Date; status: string; totalRows: number; importedRows: number; duplicateRows: number; failedRows: number; message: string | null; clientId: string | null } | null> {
  const rows = await db
    .select({
      id: importJobs.id,
      createdAt: importJobs.createdAt,
      status: importJobs.status,
      totalRows: importJobs.totalRows,
      importedRows: importJobs.importedRows,
      duplicateRows: importJobs.duplicateRows,
      failedRows: importJobs.failedRows,
      message: importJobs.message,
      clientId: importJobs.clientId,
    })
    .from(importJobs)
    .innerJoin(files, eq(files.id, importJobs.fileId))
    .where(
      and(
        eq(files.sha256, sha256),
        clientId === 'any' ? undefined : clientId ? eq(importJobs.clientId, clientId) : isNull(importJobs.clientId),
        inArray(importJobs.status, ['queued', 'running', 'succeeded', 'partial']),
      ),
    )
    .orderBy(desc(importJobs.createdAt))
    .limit(5);
  const hit = rows.find((r) => r.id !== excludeImportJobId && !(r.message ?? '').startsWith(NEEDS_MAPPING_TAG));
  return hit ?? null;
}

/** "09-26 09:10" (KST) */
export function kstShort(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

export function previousImportSummary(prev: { status: string; clientId: string | null; message: string | null; totalRows: number; importedRows: number; duplicateRows: number; failedRows: number }): string {
  const state = deriveImportState(prev.status, prev.clientId, prev.message);
  return buildImportSummary(prev, state);
}

export { importHref, formatCount };
