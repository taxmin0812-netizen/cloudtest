import { describe, expect, it } from 'vitest';
import type { Permission, Role } from '../../core/src/types';
import { ForbiddenError, toUserError } from './errors';
import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  PERMISSION_LABELS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  assertCan,
  assertCanAny,
  can,
  isPermission,
  isRole,
  permissionsOf,
} from './rbac';

/** docs/03-architecture.md §10.2 권한표 (A=admin, M=manager, S=staff, V=viewer) */
const MATRIX: Record<Permission, string> = {
  'transactions.read': 'AMSV',
  'transactions.review': 'AMS',
  'rules.read': 'AMSV',
  'rules.write': 'AMS',
  'rules.approve': 'AM',
  'export.create': 'AMS',
  'export.download': 'AMS',
  'payroll.read': 'AMS',
  'payroll.write': 'AMS',
  'payroll.sensitive': 'AM',
  'filing.write': 'AMS',
  'clients.read': 'AMSV',
  'clients.write': 'AM',
  'imports.create': 'AMS',
  'audit.read': 'AM',
  'audit.revert': 'AM',
  'settings.write': 'A',
  'users.manage': 'A',
  'integrations.developer': 'A',
};
const LETTER: Record<Role, string> = { admin: 'A', manager: 'M', staff: 'S', viewer: 'V' };

describe('RBAC 권한표', () => {
  it('권한 19개 / 역할 4개 전부 정의', () => {
    expect(ALL_PERMISSIONS).toHaveLength(19);
    expect(new Set(ALL_PERMISSIONS).size).toBe(19);
    expect(Object.keys(MATRIX).sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(ALL_ROLES).toEqual(['admin', 'manager', 'staff', 'viewer']);
    for (const p of ALL_PERMISSIONS) expect(PERMISSION_LABELS[p]).toBeTruthy();
    for (const r of ALL_ROLES) expect(ROLE_LABELS[r]).toBeTruthy();
  });

  it.each(ALL_ROLES)('%s 역할의 전체 권한 매트릭스', (role) => {
    for (const perm of ALL_PERMISSIONS) {
      expect({ role, perm, allowed: can(role, perm) }).toEqual({ role, perm, allowed: MATRIX[perm].includes(LETTER[role]) });
    }
  });

  it('admin 은 전부, viewer 는 조회만', () => {
    expect(permissionsOf('admin').sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(permissionsOf('viewer').every((p) => p.endsWith('.read'))).toBe(true);
    expect(can('viewer', 'payroll.read')).toBe(false); // 급여는 조회도 불가
  });

  it('staff 는 규칙 초안만, 승인·민감정보 열람 불가', () => {
    expect(can('staff', 'rules.write')).toBe(true);
    expect(can('staff', 'rules.approve')).toBe(false);
    expect(can('staff', 'payroll.sensitive')).toBe(false);
  });

  it('manager 는 사용자·설정·연동 관리 불가', () => {
    for (const p of ['users.manage', 'settings.write', 'integrations.developer'] as const) expect(can('manager', p)).toBe(false);
    expect(can('manager', 'rules.approve')).toBe(true);
  });

  it('권한은 역할 간 포함 관계 (viewer ⊂ staff ⊂ manager ⊂ admin)', () => {
    const chain: Role[] = ['viewer', 'staff', 'manager', 'admin'];
    for (let i = 0; i < chain.length - 1; i++) {
      const lower = permissionsOf(chain[i]);
      const higher = new Set(permissionsOf(chain[i + 1]));
      expect(lower.every((p) => higher.has(p))).toBe(true);
    }
  });

  it('알 수 없는 역할은 fail closed', () => {
    expect(can('root', 'transactions.read')).toBe(false);
    expect(can(undefined, 'transactions.read')).toBe(false);
    expect(can(null, 'transactions.read')).toBe(false);
    expect(can('__proto__', 'transactions.read')).toBe(false);
    expect(permissionsOf('superuser')).toEqual([]);
    expect(isRole('admin')).toBe(true);
    expect(isRole('Admin')).toBe(false);
    expect(isPermission('rules.approve')).toBe(true);
    expect(isPermission('rules.delete')).toBe(false);
  });

  it('ROLE_PERMISSIONS 는 변경 불가', () => {
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ROLE_PERMISSIONS.staff)).toBe(true);
    expect(() => (ROLE_PERMISSIONS.staff as Permission[]).push('users.manage')).toThrow();
    expect(can('staff', 'users.manage')).toBe(false);
  });
});

describe('assertCan', () => {
  it('허용이면 통과', () => {
    expect(() => assertCan('staff', 'imports.create')).not.toThrow();
  });

  it('거부면 ForbiddenError(403) + 한국어 안내', () => {
    try {
      assertCan('staff', 'rules.approve');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      const fe = e as ForbiddenError;
      expect(fe.httpStatus).toBe(403);
      expect(fe.permission).toBe('rules.approve');
      expect(fe.userMessage).toContain('규칙 승인');
      expect(fe.userMessage).toContain('권한');
      const u = toUserError(fe);
      expect(u.httpStatus).toBe(403);
      expect(u.message).toBe(fe.userMessage);
    }
  });

  it('assertCanAny', () => {
    expect(() => assertCanAny('staff', ['rules.approve', 'rules.write'])).not.toThrow();
    try {
      assertCanAny('viewer', ['rules.approve', 'rules.write']);
      expect.unreachable();
    } catch (e) {
      expect((e as ForbiddenError).userMessage).toContain('규칙 승인 또는 규칙 작성(초안)');
    }
    expect(() => assertCanAny('admin', [])).toThrow(ForbiddenError);
  });
});
