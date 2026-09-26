/**
 * 역할 기반 권한 (RBAC).
 *
 * 최소 권한 원칙 (docs/03-architecture.md §10.2 와 동기화 — 이 파일이 기준)
 * - admin   : 전체. 사용자·설정·연동(개발자) 관리는 admin 만 — 사무소 전체 보안 경계를 바꾸는 권한이기 때문.
 * - manager : 업무 전체 + 규칙 승인 + 주민번호 열람 + 감사로그/되돌리기 + 거래처 수정.
 *             사용자/설정/연동 관리는 제외 (계정 탈취 시 피해 범위를 업무 데이터로 한정).
 * - staff   : 일상 업무 (수집·검토·전송파일·인건비·신고). 규칙은 "초안/제안"만 만들고 승인은 manager 이상.
 *             자동분개 규칙은 전 거래에 영향을 주므로 4-eyes 원칙으로 승인을 분리한다.
 *             주민번호 원문 열람(payroll.sensitive), 거래처 마스터 수정, 감사로그는 불가.
 * - viewer  : 조회 전용 (거래·규칙·거래처). 급여는 개인 급여정보라 조회도 불가.
 *
 * 권한은 서버 서비스에서 강제한다. 화면은 숨김 처리만 한다.
 * 담당 수임처 제한(clients.assignee_id)은 권한과 별개인 행 수준 필터다.
 */
import type { Permission, Role } from '../../core/src/types';
import { ForbiddenError } from './errors';

export const ALL_ROLES = ['admin', 'manager', 'staff', 'viewer'] as const satisfies readonly Role[];

export const ALL_PERMISSIONS = [
  'transactions.read',
  'transactions.review',
  'rules.read',
  'rules.write',
  'rules.approve',
  'export.create',
  'export.download',
  'payroll.read',
  'payroll.write',
  'payroll.sensitive',
  'filing.write',
  'clients.read',
  'clients.write',
  'imports.create',
  'audit.read',
  'audit.revert',
  'settings.write',
  'users.manage',
  'integrations.developer',
] as const satisfies readonly Permission[];

// 컴파일 타임 검증: Permission 유니온에 새 값이 추가되면 여기서 타입 오류가 나서 누락을 막는다.
type MissingPermission = Exclude<Permission, (typeof ALL_PERMISSIONS)[number]>;
const _exhaustive: [MissingPermission] extends [never] ? true : MissingPermission = true;
void _exhaustive;

export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = Object.freeze({
  'transactions.read': '거래 조회',
  'transactions.review': '거래 검토·승인',
  'rules.read': '규칙 조회',
  'rules.write': '규칙 작성(초안)',
  'rules.approve': '규칙 승인',
  'export.create': 'WEHAGO 전송파일 생성',
  'export.download': '전송파일 다운로드',
  'payroll.read': '인건비 조회',
  'payroll.write': '인건비 입력·수정',
  'payroll.sensitive': '주민등록번호 등 민감정보 열람',
  'filing.write': '신고 진행 관리',
  'clients.read': '거래처 조회',
  'clients.write': '거래처 등록·수정',
  'imports.create': '자료 수집(업로드)',
  'audit.read': '감사로그 조회',
  'audit.revert': '변경 되돌리기',
  'settings.write': '시스템 설정 변경',
  'users.manage': '사용자·권한 관리',
  'integrations.developer': '연동 개발자 설정',
});

export const ROLE_LABELS: Readonly<Record<Role, string>> = Object.freeze({
  admin: '관리자',
  manager: '팀장',
  staff: '담당자',
  viewer: '조회 전용',
});

const ADMIN_ONLY: readonly Permission[] = ['settings.write', 'users.manage', 'integrations.developer'];

const STAFF: readonly Permission[] = [
  'transactions.read',
  'transactions.review',
  'rules.read',
  'rules.write',
  'export.create',
  'export.download',
  'payroll.read',
  'payroll.write',
  'filing.write',
  'clients.read',
  'imports.create',
];

const VIEWER: readonly Permission[] = ['transactions.read', 'rules.read', 'clients.read'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  admin: Object.freeze([...ALL_PERMISSIONS]),
  manager: Object.freeze(ALL_PERMISSIONS.filter((p) => !ADMIN_ONLY.includes(p))),
  staff: Object.freeze([...STAFF]),
  viewer: Object.freeze([...VIEWER]),
});

const ROLE_SETS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  admin: new Set(ROLE_PERMISSIONS.admin),
  manager: new Set(ROLE_PERMISSIONS.manager),
  staff: new Set(ROLE_PERMISSIONS.staff),
  viewer: new Set(ROLE_PERMISSIONS.viewer),
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ALL_ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/** 알 수 없는 역할·권한은 항상 false (fail closed) */
export function can(role: Role | string | null | undefined, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return ROLE_SETS[role].has(permission);
}

export function permissionsOf(role: Role | string | null | undefined): Permission[] {
  return isRole(role) ? [...ROLE_PERMISSIONS[role]] : [];
}

/** 권한이 없으면 ForbiddenError (403, 한국어 안내) */
export function assertCan(role: Role | string | null | undefined, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission, PERMISSION_LABELS[permission]);
}

/** 여러 권한 중 하나라도 있으면 통과 */
export function assertCanAny(role: Role | string | null | undefined, permissions: readonly Permission[]): void {
  if (permissions.some((p) => can(role, p))) return;
  const first = permissions[0];
  throw new ForbiddenError(permissions.join('|'), first ? permissions.map((p) => PERMISSION_LABELS[p]).join(' 또는 ') : undefined);
}
