import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { files } from '@mintax/db';
import { ConfigurationError, NotFoundError, getKeyring } from '@mintax/security';
import type { ServiceContext } from '../context';

/**
 * 파일 저장소 — 모든 파일은 AES-256-GCM 으로 암호화해서 저장한다 (at-rest encryption).
 * 형식: "MTX1" | version-len(1) | version | iv(12) | tag(16) | ciphertext
 *
 * 드라이버: local (기본). s3 는 인터페이스만 정의되어 있고, 자격증명이 없으면 명확히 오류를 낸다 (가짜 성공 금지).
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

class LocalDriver implements StorageDriver {
  constructor(private readonly root: string) {}
  private resolve(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('잘못된 저장소 경로');
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, data, { mode: 0o600 });
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
}

let driver: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  if (driver) return driver;
  const kind = process.env.STORAGE_DRIVER ?? 'local';
  if (kind === 'local') {
    driver = new LocalDriver(path.resolve(process.env.STORAGE_LOCAL_DIR ?? './storage'));
    return driver;
  }
  throw new ConfigurationError(`STORAGE_DRIVER=${kind} 는 아직 지원되지 않습니다 (local 만 구현됨, S3 드라이버는 docs/USER_ACTIONS.md 참고).`);
}

/** 테스트용 드라이버 교체 */
export function setStorageDriver(d: StorageDriver | null): void {
  driver = d;
}

const MAGIC = Buffer.from('MTX1');

export function encryptBuffer(plain: Buffer): Buffer {
  const ring = getKeyring();
  const version = ring.currentVersion;
  const key = ring.keys.get(version)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`mintax-file:${version}`));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const v = Buffer.from(version, 'utf8');
  return Buffer.concat([MAGIC, Buffer.from([v.length]), v, iv, cipher.getAuthTag(), ct]);
}

export function decryptBuffer(blob: Buffer): Buffer {
  if (!blob.subarray(0, 4).equals(MAGIC)) return blob; // 평문(레거시) 파일
  const vlen = blob[4]!;
  const version = blob.subarray(5, 5 + vlen).toString('utf8');
  const key = getKeyring().keys.get(version);
  if (!key) throw new Error(`파일 암호화 키 버전(${version})을 찾을 수 없습니다.`);
  let o = 5 + vlen;
  const iv = blob.subarray(o, o + 12);
  o += 12;
  const tag = blob.subarray(o, o + 16);
  o += 16;
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`mintax-file:${version}`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(o)), decipher.final()]);
}

export type FilePurpose =
  | 'import_source'
  | 'wehago_export'
  | 'error_report'
  | 'filing_receipt'
  | 'payment_slip'
  | 'review_excel'
  | 'payroll_export'
  | 'wehago_reimport'
  | 'wehago_template';

export interface StoredFile {
  id: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  originalName: string;
}

export function sha256OfBuffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 파일 저장 + files 레코드 생성 */
export async function storeFile(
  ctx: ServiceContext,
  input: { data: Buffer; originalName: string; mimeType?: string | null; purpose: FilePurpose; clientId?: string | null },
): Promise<StoredFile> {
  const sha256 = sha256OfBuffer(input.data);
  const now = ctx.now();
  const key = `${input.purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.bin`;
  await getStorageDriver().put(key, encryptBuffer(input.data));
  const [row] = await ctx.db
    .insert(files)
    .values({
      storageKey: key,
      originalName: sanitizeFileName(input.originalName),
      mimeType: input.mimeType ?? null,
      sizeBytes: input.data.length,
      sha256,
      encrypted: true,
      purpose: input.purpose,
      clientId: input.clientId ?? null,
      uploadedBy: ctx.actor.userId,
      createdAt: now,
    })
    .returning({ id: files.id });
  return { id: row!.id, storageKey: key, sha256, sizeBytes: input.data.length, originalName: input.originalName };
}

export async function readStoredFile(ctx: ServiceContext, fileId: string): Promise<{ data: Buffer; row: typeof files.$inferSelect }> {
  const { eq } = await import('drizzle-orm');
  const [row] = await ctx.db.select().from(files).where(eq(files.id, fileId));
  if (!row) throw new NotFoundError('파일');
  const blob = await getStorageDriver().get(row.storageKey);
  const data = row.encrypted ? decryptBuffer(blob) : blob;
  if (sha256OfBuffer(data) !== row.sha256) throw new Error('저장된 파일의 무결성 검증에 실패했습니다.');
  return { data, row };
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
}
