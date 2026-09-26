import type { Permission, Role } from '@mintax/core';
import type { Actor } from '../context';
import type { Env, LoginResultCode } from './helpers';

/** 요청 메타 (감사로그·login_history 기록용) */
export interface AuthRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** 시각·환경 주입 (테스트) */
export interface AuthOptions {
  now?: () => Date;
  env?: Env;
}

export interface AuthUserDTO {
  id: string;
  email: string;
  name: string;
  role: Role;
  roleLabel: string;
  permissions: Permission[];
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
}

export interface LoginInput extends AuthRequestMeta {
  email: string;
  password: string;
}

export type LoginResult =
  | {
      status: 'ok';
      /** 쿠키에만 담을 원문 토큰 (DB 에는 해시만 저장) */
      sessionToken: string;
      sessionId: string;
      expiresAt: string;
      user: AuthUserDTO;
      /** 관리자 MFA 강제(MFA_REQUIRED_FOR_ADMIN)인데 미등록 → 등록 화면으로 보낸다 */
      mustEnrollMfa: boolean;
      /** 임시 비밀번호(관리자 발급) 상태 → 비밀번호 변경 화면으로 보낸다 */
      mustChangePassword: boolean;
    }
  | {
      status: 'mfa_required';
      /** OTP 입력 단계 토큰 (5분 유효, 원문 비밀번호 대신 사용) */
      challengeToken: string;
      expiresAt: string;
    };

export interface VerifyMfaInput extends AuthRequestMeta {
  challengeToken: string;
  /** OTP 6자리 또는 복구 코드 'XXXXX-XXXXX' */
  code: string;
}

export interface SessionDTO {
  id: string;
  ip: string | null;
  userAgent: string | null;
  mfaVerified: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** 유휴 만료 예정 시각 */
  idleExpiresAt: string;
  current: boolean;
}

export type SessionFailureReason = 'malformed' | 'not_found' | 'revoked' | 'idle' | 'absolute' | 'inactive' | 'ip_blocked' | 'mfa_pending';

export interface ValidatedSession {
  user: AuthUserDTO;
  actor: Actor;
  session: SessionDTO;
  mustEnrollMfa: boolean;
  mustChangePassword: boolean;
}

export type SessionCheck = ({ ok: true } & ValidatedSession) | { ok: false; reason: SessionFailureReason };

export interface LoginHistoryDTO {
  id: string;
  createdAt: string;
  userId: string | null;
  userName: string | null;
  email: string;
  success: boolean;
  result: LoginResultCode | string;
  resultLabel: string;
  ip: string | null;
  userAgent: string | null;
}

export interface UserAdminDTO {
  id: string;
  email: string;
  name: string;
  role: Role;
  roleLabel: string;
  active: boolean;
  mfaEnabled: boolean;
  /** 관리자 MFA 강제인데 미등록 */
  mfaMissing: boolean;
  lockedUntil: string | null;
  failedLoginCount: number;
  allowedIpRanges: string[];
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  /** 임시 비밀번호 상태 (최초 로그인 후 변경 필요) */
  temporaryPassword: boolean;
  activeSessions: number;
  createdAt: string;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: Role;
  allowedIpRanges?: string[];
}

export interface CreatedUserResult {
  user: UserAdminDTO;
  /** 한 번만 보여 주는 임시 비밀번호 (저장·로그 금지) */
  temporaryPassword: string;
}

export interface MfaEnrollmentDTO {
  /** 인증 앱에 수동 입력할 비밀 (이 응답에서만 제공) */
  secret: string;
  otpauthUri: string;
  issuer: string;
  account: string;
}
