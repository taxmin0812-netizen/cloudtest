/**
 * Desktop Bridge 수집 입구 (Adapter C/D/E) — 토큰 발급·검증, 업로드, 준비된 WEHAGO 파일 목록·받기.
 *
 * 프로토타입 인증: 기기(토큰)별 무작위 비밀. 서버는 HMAC-SHA256(MINTAX_INDEX_KEY) 해시만
 * integration_connections(key='desktop_bridge').config.tokens 에 보관한다 (평문은 발급 시 한 번만 보여준다).
 * 운영용 기기별 Ed25519 서명(docs/desktop-bridge-design §5.2)은 bridge_devices 테이블이 생긴 뒤 교체한다.
 *
 * 폴더 감시(Adapter D 클라우드 동기화 폴더 포함)는 Bridge 가 한다. 서버는 입구만 제공한다.
 */
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { Permission } from '@mintax/core';
import { clients, exportJobs, files, integrationConnections, users, type Database } from '@mintax/db';
import { RateLimitError, SlidingWindowRateLimiter, ValidationError, NotFoundError, ConflictError, getIndexKey, hmacSha256Hex, timingSafeEqualString } from '@mintax/security';
import { createContext, requirePermission, systemActor, type Actor, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { readStoredFile } from '../infra/storage';
import { BridgeAuthError, DuplicateImportFileError, importHref } from './errors';
import { baseNameOf, channelForBridgeFolder, generateBridgeToken, parseBridgeToken, stripExtension, BRIDGE_TOKEN_PREFIX } from './helpers';
import { createImport } from './upload';
import type {
  BridgeResultFileDTO,
  BridgeTokenDTO,
  BridgeUploadInput,
  BridgeUploadResult,
  CreateBridgeTokenResult,
  ImportDownloadFile,
} from './types';

export const BRIDGE_CONNECTION_KEY = 'desktop_bridge';
/** Bridge 행위자 권한 (최소 권한: 올리기·받기·수임처 조회) */
export const BRIDGE_PERMISSIONS: readonly Permission[] = ['imports.create', 'export.download', 'clients.read'];

interface StoredBridgeToken {
  id: string;
  name: string;
  /** HMAC-SHA256(index key, 'desktop_bridge_token\0' + token) — 평문 토큰은 저장하지 않는다 */
  hash: string;
  createdAt: string;
  createdBy: string | null;
  createdByName: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface BridgeConfig {
  tokens?: StoredBridgeToken[];
}

// ────────────────────────────── 속도 제한 (토큰별) ──────────────────────────────

export const BRIDGE_RATE_LIMITS = Object.freeze({ requestsPerMinute: 120, uploadsPerMinute: 30 });
let requestLimiter = new SlidingWindowRateLimiter({ limit: BRIDGE_RATE_LIMITS.requestsPerMinute, windowMs: 60_000 });
let uploadLimiter = new SlidingWindowRateLimiter({ limit: BRIDGE_RATE_LIMITS.uploadsPerMinute, windowMs: 60_000 });

/** 테스트용: 속도 제한 상태 초기화 (한도 조정 가능) */
export function resetBridgeRateLimits(opts: { requestsPerMinute?: number; uploadsPerMinute?: number } = {}): void {
  requestLimiter = new SlidingWindowRateLimiter({ limit: opts.requestsPerMinute ?? BRIDGE_RATE_LIMITS.requestsPerMinute, windowMs: 60_000 });
  uploadLimiter = new SlidingWindowRateLimiter({ limit: opts.uploadsPerMinute ?? BRIDGE_RATE_LIMITS.uploadsPerMinute, windowMs: 60_000 });
}

function hit(limiter: SlidingWindowRateLimiter, key: string, what: string): void {
  const r = limiter.hit(key);
  if (!r.allowed) {
    throw new RateLimitError(r.retryAfterMs / 1000, `Bridge ${what}요청이 너무 많습니다. ${Math.max(1, Math.ceil(r.retryAfterMs / 1000))}초 후 다시 시도합니다.`);
  }
}

// ────────────────────────────── 토큰 저장소 ──────────────────────────────

function hashBridgeToken(token: string): string {
  return hmacSha256Hex(getIndexKey(), `desktop_bridge_token\u0000${token.trim()}`);
}

function tokenDTO(t: StoredBridgeToken): BridgeTokenDTO {
  return {
    id: t.id,
    name: t.name,
    prefix: `${BRIDGE_TOKEN_PREFIX}.${t.id}`,
    createdAt: t.createdAt,
    createdByName: t.createdByName,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    active: !t.revokedAt,
  };
}

function statusFor(tokens: StoredBridgeToken[]): { status: 'FILE_BASED' | 'NOT_AVAILABLE'; statusReason: string } {
  const active = tokens.filter((t) => !t.revokedAt);
  return active.length > 0
    ? {
        status: 'FILE_BASED',
        statusReason: `Desktop Bridge 토큰 ${active.length}개 활성 — 사무소 PC 폴더 ↔ 서버 파일 전달(프로토타입, 파일 기반). 실시간 API 연동이 아닙니다.`,
      }
    : { status: 'NOT_AVAILABLE', statusReason: '연결된 Desktop Bridge 가 없습니다. 설정 > 연동에서 토큰을 발급해 Bridge 에 입력하세요.' };
}

async function loadConnection(db: Pick<Database, 'select'>, forUpdate = false) {
  const q = db.select().from(integrationConnections).where(eq(integrationConnections.key, BRIDGE_CONNECTION_KEY));
  const [row] = forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

function tokensOf(row: { config: Record<string, unknown> } | null): StoredBridgeToken[] {
  const cfg = (row?.config ?? {}) as BridgeConfig;
  return Array.isArray(cfg.tokens) ? cfg.tokens : [];
}

/**
 * Bridge 토큰 발급 — 평문 토큰은 이 응답에서 한 번만 돌려준다. 권한: settings.write (관리자)
 */
export async function createBridgeToken(ctx: ServiceContext, input: { name: string }): Promise<CreateBridgeTokenResult> {
  requirePermission(ctx, 'settings.write');
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 60) {
    throw new ValidationError('기기 이름을 1~60자로 입력하세요 (예: PC-회계1).', [{ field: 'name', message: '1~60자' }]);
  }
  const { id, token } = generateBridgeToken();
  const entry: StoredBridgeToken = {
    id,
    name,
    hash: hashBridgeToken(token),
    createdAt: ctx.now().toISOString(),
    createdBy: ctx.actor.userId,
    createdByName: ctx.actor.name,
    lastUsedAt: null,
    revokedAt: null,
  };
  await ctx.db.transaction(async (tx) => {
    const row = await loadConnection(tx, true);
    const tokens = [...tokensOf(row), entry];
    const st = statusFor(tokens);
    if (row) {
      await tx
        .update(integrationConnections)
        .set({ config: { ...row.config, tokens }, status: st.status, statusReason: st.statusReason, updatedAt: ctx.now() })
        .where(eq(integrationConnections.id, row.id));
    } else {
      await tx.insert(integrationConnections).values({
        key: BRIDGE_CONNECTION_KEY,
        name: 'Desktop Bridge',
        status: st.status,
        statusReason: st.statusReason,
        config: { tokens },
        updatedAt: ctx.now(),
      });
    }
    await writeAudit(
      { ...ctx, db: tx as unknown as Database },
      {
        action: 'bridge.token.create',
        category: 'security',
        entityType: 'integration',
        entityId: BRIDGE_CONNECTION_KEY,
        summary: `Desktop Bridge 토큰 발급: ${name} (${BRIDGE_TOKEN_PREFIX}.${id})`,
        before: { status: row?.status ?? null },
        // 토큰 원문·해시는 절대 기록하지 않는다
        after: { tokenId: id, name, status: st.status },
      },
    );
  });
  return { ...tokenDTO(entry), token };
}

/** Bridge 토큰 목록 (비밀 없음 — 자료 수집 화면의 "Bridge 연결됨" 표시용). 권한: imports.create */
export async function listBridgeTokens(ctx: ServiceContext): Promise<BridgeTokenDTO[]> {
  requirePermission(ctx, 'imports.create');
  const row = await loadConnection(ctx.db);
  return tokensOf(row).map(tokenDTO);
}

/** Bridge 토큰 폐기 — 다음 요청부터 401. 권한: settings.write */
export async function revokeBridgeToken(ctx: ServiceContext, tokenId: string): Promise<BridgeTokenDTO> {
  requirePermission(ctx, 'settings.write');
  return ctx.db.transaction(async (tx) => {
    const row = await loadConnection(tx, true);
    const tokens = tokensOf(row);
    const idx = tokens.findIndex((t) => t.id === tokenId);
    if (!row || idx < 0) throw new NotFoundError('Bridge 토큰');
    if (tokens[idx]!.revokedAt) throw new ConflictError('이미 폐기된 토큰입니다. 목록을 새로고침해 주세요.');
    const updated = { ...tokens[idx]!, revokedAt: ctx.now().toISOString() };
    tokens[idx] = updated;
    const st = statusFor(tokens);
    await tx
      .update(integrationConnections)
      .set({ config: { ...row.config, tokens }, status: st.status, statusReason: st.statusReason, updatedAt: ctx.now() })
      .where(eq(integrationConnections.id, row.id));
    await writeAudit(
      { ...ctx, db: tx as unknown as Database },
      {
        action: 'bridge.token.revoke',
        category: 'security',
        entityType: 'integration',
        entityId: BRIDGE_CONNECTION_KEY,
        summary: `Desktop Bridge 토큰 폐기: ${updated.name} (${BRIDGE_TOKEN_PREFIX}.${updated.id})`,
        before: { tokenId, active: true, status: row.status },
        after: { tokenId, active: false, status: st.status },
      },
    );
    return tokenDTO(updated);
  });
}

// ────────────────────────────── 인증 ──────────────────────────────

const INVALID_TOKEN_MESSAGE =
  'Bridge 토큰이 올바르지 않습니다. 웹의 설정 > 연동 > Desktop Bridge 에서 토큰을 새로 발급해 Bridge 에 입력하세요.';

async function authenticate(db: Database, token: string, bucket: 'request' | 'upload'): Promise<{ actor: Actor; entry: StoredBridgeToken }> {
  const parsed = parseBridgeToken(token);
  hit(requestLimiter, parsed?.id ?? 'malformed', '');
  if (bucket === 'upload' && parsed) hit(uploadLimiter, parsed.id, '업로드 ');
  if (!parsed) throw new BridgeAuthError('bridge_token_invalid', INVALID_TOKEN_MESSAGE);

  const row = await loadConnection(db);
  const entry = tokensOf(row).find((t) => t.id === parsed.id);
  const hash = hashBridgeToken(token);
  if (!entry || !timingSafeEqualString(entry.hash, hash)) throw new BridgeAuthError('bridge_token_invalid', INVALID_TOKEN_MESSAGE);
  if (entry.revokedAt) {
    throw new BridgeAuthError('device_revoked', '이 Bridge 의 연결이 해제되었습니다. 필요하면 관리자에게 새 토큰 발급을 요청하세요.');
  }
  if (entry.createdBy) {
    const [owner] = await db.select({ active: users.active }).from(users).where(eq(users.id, entry.createdBy));
    if (owner && !owner.active) {
      throw new BridgeAuthError('bridge_owner_inactive', '이 Bridge 토큰을 발급한 사용자가 비활성화되어 사용할 수 없습니다. 관리자에게 새 토큰 발급을 요청하세요.');
    }
  }
  // 마지막 사용 시각 (5분에 한 번만 기록 — 요청마다 쓰지 않는다)
  const last = entry.lastUsedAt ? Date.parse(entry.lastUsedAt) : 0;
  if (Date.now() - last > 5 * 60_000) {
    const nowIso = new Date().toISOString();
    await db.execute(sql`
      update integration_connections
      set config = jsonb_set(config, '{tokens}', (
            select coalesce(jsonb_agg(case when e.t->>'id' = ${entry.id} then jsonb_set(e.t, '{lastUsedAt}', to_jsonb(${nowIso}::text)) else e.t end order by e.ord), '[]'::jsonb)
            from jsonb_array_elements(config->'tokens') with ordinality as e(t, ord))),
          last_sync_at = now()
      where key = ${BRIDGE_CONNECTION_KEY}
    `);
  }
  const base = systemActor(`Desktop Bridge (${entry.name})`);
  const actor: Actor = { ...base, permissions: new Set(BRIDGE_PERMISSIONS) };
  return { actor, entry };
}

/** 토큰 검증 → Bridge 행위자 (시스템 행위자, 최소 권한). 실패 시 BridgeAuthError(401) / RateLimitError(429) */
export async function verifyBridgeToken(db: Database, token: string): Promise<Actor> {
  return (await authenticate(db, token, 'request')).actor;
}

// ────────────────────────────── 업로드 ──────────────────────────────

/**
 * Bridge 업로드 = uploadImportFile(channel: desktop_bridge | download_watch).
 * 같은 파일을 다시 보내면 오류 대신 duplicate(성공 취급)와 기존 결과 링크를 돌려준다 (Bridge 재시도 멱등).
 */
export async function bridgeUpload(db: Database, token: string, input: BridgeUploadInput): Promise<BridgeUploadResult> {
  const { actor, entry } = await authenticate(db, token, 'upload');
  const ctx = createContext(db, actor);
  requirePermission(ctx, 'imports.create');
  const channel = channelForBridgeFolder(input.sourceFolder);
  try {
    const r = await createImport(
      ctx,
      { fileName: input.fileName, data: input.data, clientId: input.clientId ?? null, channel, period: input.period ?? null },
      { bridge: { tokenName: entry.name, sourceFileName: baseNameOf(input.sourcePath), sourceFolder: input.sourceFolder ?? null } },
    );
    return {
      status: r.status === 'queued' ? 'accepted' : r.status,
      importJobId: r.importJobId,
      jobId: r.jobId,
      message: r.message,
      href: r.href,
      detected: r.detected,
    };
  } catch (e) {
    if (e instanceof DuplicateImportFileError) {
      return { status: 'duplicate', importJobId: e.previousImportJobId, jobId: null, message: e.userMessage, href: importHref(e.previousImportJobId), detected: null };
    }
    throw e;
  }
}

// ────────────────────────────── 결과 받기 (outbox) ──────────────────────────────

function parseSince(since: string | Date | null | undefined): Date | null {
  if (since === null || since === undefined || since === '') return null;
  const d = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(d.getTime())) throw new ValidationError('since 는 ISO 시각이어야 합니다.', [{ field: 'since', message: '형식 오류' }]);
  return d;
}

function templateFlags(templateVersion: string, validation: Record<string, unknown>): { mock: boolean; verified: boolean; supersededBy: string | null } {
  const status = typeof validation.templateStatus === 'string' ? validation.templateStatus : null;
  const mock = validation.mock === true || status === 'mock' || /mock/i.test(templateVersion);
  const verified = !mock && (validation.verified === true || validation.templateVerified === true);
  const sup = validation.supersededBy;
  return { mock, verified, supersededBy: typeof sup === 'string' || typeof sup === 'number' ? String(sup) : null };
}

/**
 * 받을 WEHAGO 파일 목록 (export_jobs.status = 'ready'), 생성순. since 이후 생성분만 (없으면 전부) —
 * 다음 호출의 since 는 마지막 항목의 createdAt 을 쓰면 된다. 권한: export.download
 * Bridge 는 suggestedFileName 으로 WEHAGO 업로드용 폴더에 저장한다 (MOCK_ / _검증필요 표시 유지).
 */
export async function bridgeResults(db: Database, token: string, since?: string | Date | null): Promise<BridgeResultFileDTO[]> {
  const { actor } = await authenticate(db, token, 'request');
  const ctx = createContext(db, actor);
  requirePermission(ctx, 'export.download');
  const sinceDate = parseSince(since);
  const conds: SQL[] = [eq(exportJobs.status, 'ready')];
  if (sinceDate) conds.push(gt(exportJobs.createdAt, sinceDate));
  const rows = await db
    .select({
      id: exportJobs.id,
      clientId: exportJobs.clientId,
      clientName: clients.name,
      clientCode: clients.code,
      period: exportJobs.period,
      kind: exportJobs.kind,
      templateKey: exportJobs.templateKey,
      templateVersion: exportJobs.templateVersion,
      validation: exportJobs.validation,
      rowCount: exportJobs.rowCount,
      totalAmount: exportJobs.totalAmount,
      createdAt: exportJobs.createdAt,
      fileId: files.id,
      fileName: files.originalName,
      sha256: files.sha256,
      sizeBytes: files.sizeBytes,
    })
    .from(exportJobs)
    .innerJoin(clients, eq(clients.id, exportJobs.clientId))
    .innerJoin(files, eq(files.id, exportJobs.fileId))
    .where(and(...conds))
    .orderBy(asc(exportJobs.createdAt))
    .limit(200);
  return rows.map((r): BridgeResultFileDTO => {
    const f = templateFlags(r.templateVersion, r.validation ?? {});
    const base = stripExtension(r.fileName);
    const ext = /\.[^.]+$/.exec(r.fileName)?.[0] ?? '.xlsx';
    return {
      exportJobId: r.id,
      clientId: r.clientId,
      clientName: r.clientName,
      clientCode: r.clientCode,
      period: r.period,
      kind: r.kind,
      templateKey: r.templateKey,
      templateVersion: r.templateVersion,
      fileId: r.fileId,
      fileName: r.fileName,
      sha256: r.sha256,
      sizeBytes: r.sizeBytes,
      rowCount: r.rowCount,
      totalAmount: r.totalAmount,
      createdAt: r.createdAt.toISOString(),
      mock: f.mock,
      verified: f.verified,
      supersededBy: f.supersededBy,
      suggestedFileName: `${f.mock ? 'MOCK_' : ''}${base}${f.verified ? '' : '_검증필요'}${ext}`,
      downloadHref: `/api/bridge/outbox/${r.id}/file`,
    };
  });
}

/**
 * 준비된 WEHAGO 파일 받기 — 사람이 받은 것과 같게 downloaded 로 기록하고 감사로그(export.download)를 남긴다.
 * 권한: export.download
 */
export async function bridgeDownloadResult(db: Database, token: string, exportJobId: string): Promise<ImportDownloadFile & { sha256: string }> {
  const { actor, entry } = await authenticate(db, token, 'request');
  const ctx = createContext(db, actor);
  requirePermission(ctx, 'export.download');
  const [job] = await db
    .select({ id: exportJobs.id, status: exportJobs.status, fileId: exportJobs.fileId, clientId: exportJobs.clientId, period: exportJobs.period, kind: exportJobs.kind, templateVersion: exportJobs.templateVersion, validation: exportJobs.validation, clientName: clients.name })
    .from(exportJobs)
    .innerJoin(clients, eq(clients.id, exportJobs.clientId))
    .where(eq(exportJobs.id, exportJobId));
  if (!job || !job.fileId) throw new NotFoundError('WEHAGO 전송파일');
  const flags = templateFlags(job.templateVersion, job.validation ?? {});
  if (flags.supersededBy) throw new ConflictError('새 버전으로 대체된 파일이라 받을 수 없습니다. 최신 파일을 받으세요.');
  if (job.status !== 'ready' && job.status !== 'downloaded') {
    throw new ConflictError(`지금은 받을 수 없는 파일입니다 (상태: ${job.status}). 전송센터에서 상태를 확인하세요.`);
  }
  const { data, row } = await readStoredFile(ctx, job.fileId);
  await db.transaction(async (tx) => {
    if (job.status === 'ready') {
      await tx.update(exportJobs).set({ status: 'downloaded', downloadedAt: ctx.now() }).where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, 'ready')));
    }
    await writeAudit(
      { ...ctx, db: tx as unknown as Database },
      {
        action: 'export.download',
        category: 'download',
        entityType: 'export_job',
        entityId: job.id,
        clientId: job.clientId,
        summary: `${job.clientName} ${job.period} WEHAGO 파일 받기 (Bridge: ${entry.name}) — ${row.originalName}`,
        before: { status: job.status },
        after: { status: job.status === 'ready' ? 'downloaded' : job.status, fileId: job.fileId, sha256: row.sha256 },
      },
    );
  });
  return { fileName: row.originalName, data, mimeType: row.mimeType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: row.sha256 };
}

