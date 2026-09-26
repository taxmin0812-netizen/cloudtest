/**
 * 인증·보안 서비스 공개 API.
 * - login / verifyMfa : 로그인 전 단계라 ServiceContext 대신 db 를 받는다 (행위자 없음)
 * - 세션: createSession · validateSession(checkSession) · logout · revokeAllSessions · revokeSession · listSessions
 * - 비밀번호: changePassword · resetUserPassword
 * - MFA: enrollMfa · confirmMfa · disableMfa(관리자 초기화)
 * - 사용자 관리(users.manage): listUsers · createUser · updateUserRole · deactivateUser · reactivateUser · unlockUser · updateUserAllowedIps
 * - buildActor(user, session) → Actor (권한 = permissionsOf(role))
 */
export { login, verifyMfa } from './login';
export { checkSession, createSession, listSessions, logout, revokeAllSessions, revokeSession, validateSession } from './sessions';
export { changePassword, resetUserPassword } from './password';
export { confirmMfa, disableMfa, enrollMfa } from './mfa';
export { createUser, deactivateUser, listUsers, reactivateUser, unlockUser, updateUserAllowedIps, updateUserRole } from './users';
export {
  LOGIN_RESULTS,
  LOGIN_RESULT_LABELS,
  MFA_CHALLENGE_TTL_MS,
  buildActor,
  isMfaRequiredForAdmin,
  normalizeEmail,
  resetLoginRateLimits,
  type LoginResultCode,
} from './helpers';
export type * from './types';
