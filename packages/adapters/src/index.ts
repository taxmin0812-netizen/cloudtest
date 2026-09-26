/**
 * @mintax/adapters — Integration Layer
 * 파일 읽기 · 형식 판정 · 정규화 · 수임처 판정 · WEHAGO 파일 생성/재검증 · 연동 레지스트리 · 오류 리포트
 */
export * from './errors';
export * from './file/read';
export * from './format/fields';
export * from './format/profiles';
export * from './format/detect';
export * from './normalize/normalize-rows';
export * from './client-match';
export * from './wehago/codes';
export * from './wehago/templates';
export * from './wehago/render';
export * from './wehago/export';
export * from './wehago/payroll';
export * from './wehago/sample';
export * from './integrations';
export * from './error-report';
export * from './pipeline';
export { luhnValid, looksLikeFullCardNumber, looksLikeResidentNumber, scrubFreeText } from './util/sensitive';
export { normalizeHeader, cellText, isBlankRow } from './util/text';
