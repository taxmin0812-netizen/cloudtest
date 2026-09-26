import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionError, AuthenticationError, BadRequestError, InternalServerError, RateLimitError } from '@anthropic-ai/sdk';
import type { AIClassificationInput } from '@mintax/core';
import {
  ABSTAIN_CODE,
  AnthropicProvider,
  buildClassifyRequest,
  classifyAnthropicError,
  CLASSIFY_TOOL_NAME,
  DEFAULT_AI_MODEL,
  parseClassificationResponse,
  type AnthropicProviderEvent,
  type MessagesClient,
  type RequestOptionsLike,
} from './anthropic';
import type { LedgerReviewInput } from './types';

const CANDIDATES = [
  { code: '811', name: '복리후생비' },
  { code: '822', name: '차량유지비' },
  { code: '830', name: '소모품비' },
];

function input(over: Partial<AIClassificationInput> = {}): AIClassificationInput {
  return {
    merchantName: 'SK에너지',
    merchantCategory: '주유소',
    description: '법인차 주유',
    totalAmount: 55_000,
    evidenceType: 'card',
    direction: 'purchase',
    industry: 'service',
    candidateAccounts: CANDIDATES,
    similarExamples: [{ merchantName: 'GS칼텍스', accountCode: '822', accountName: '차량유지비', count: 3 }],
    ...over,
  };
}

function message(content: unknown[], stop_reason: Anthropic.Message['stop_reason'] = 'tool_use'): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_AI_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Anthropic.Message;
}

function toolUse(inputObj: Record<string, unknown>, name = CLASSIFY_TOOL_NAME): unknown {
  return { type: 'tool_use', id: 'toolu_1', name, input: inputObj };
}

type Responder = (body: Anthropic.MessageCreateParamsNonStreaming, opts?: RequestOptionsLike) => PromiseLike<Anthropic.Message>;

function fakeClient(...responders: Responder[]) {
  const calls: Array<{ body: Anthropic.MessageCreateParamsNonStreaming; opts?: RequestOptionsLike }> = [];
  const client: MessagesClient = {
    messages: {
      create(body, opts) {
        calls.push({ body, opts });
        const r = responders[Math.min(calls.length - 1, responders.length - 1)]!;
        return r(body, opts);
      },
    },
  };
  return { client, calls };
}

const reply = (m: Anthropic.Message): Responder => () => Promise.resolve(m);
const fail = (e: unknown): Responder => () => Promise.reject(e);
const hang: Responder = () => new Promise<Anthropic.Message>(() => {});

function provider(client: MessagesClient, extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  const events: AnthropicProviderEvent[] = [];
  const p = new AnthropicProvider({ client, retryDelayMs: 0, timeoutMs: 50, onEvent: (e) => events.push(e), ...extra });
  return { p, events };
}

describe('buildClassifyRequest', () => {
  it('strict 도구 + 후보 코드 enum + auto tool_choice + effort low', () => {
    const req = buildClassifyRequest(input(), 'claude-sonnet-5');
    expect(req.model).toBe('claude-sonnet-5');
    expect(req.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(req.output_config).toEqual({ effort: 'low' });
    expect(req.tools).toHaveLength(1);
    const tool = req.tools![0] as Anthropic.Tool;
    expect(tool.name).toBe(CLASSIFY_TOOL_NAME);
    expect(tool.strict).toBe(true);
    const props = tool.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.accountCode!.enum).toEqual(['811', '822', '830', ABSTAIN_CODE]);
    expect(tool.input_schema.additionalProperties).toBe(false);
    const content = req.messages[0]!.content as string;
    expect(content).toContain('"상호":"SK에너지"');
    expect(content).toContain('822 차량유지비');
    expect(content).toContain('"GS칼텍스" → 822 차량유지비 (3회)');
    expect(content).toContain('"합계금액":"55,000원"');
  });

  it('Haiku 는 effort 를 보내지 않는다, null 이면 생략', () => {
    expect(buildClassifyRequest(input(), 'claude-haiku-4-5').output_config).toBeUndefined();
    expect(buildClassifyRequest(input(), 'claude-opus-5', { effort: null }).output_config).toBeUndefined();
    expect(buildClassifyRequest(input(), 'claude-opus-5', { effort: 'medium' }).output_config).toEqual({ effort: 'medium' });
  });
});

describe('parseClassificationResponse', () => {
  it('정상 응답 파싱 + 상한 85', () => {
    const r = parseClassificationResponse(message([{ type: 'text', text: '분류합니다' }, toolUse({ accountCode: '822', confidence: 97, rationale: '주유소 결제' })]), CANDIDATES);
    expect(r).toEqual({ ok: true, suggestion: { accountCode: '822', accountName: '차량유지비', confidence: 85, rationale: '주유소 결제' } });
  });

  it.each<[string, Anthropic.Message, string]>([
    ['후보에 없는 코드', message([toolUse({ accountCode: '999', confidence: 80, rationale: 'x' })]), 'invalid_code'],
    ['NONE', message([toolUse({ accountCode: 'NONE', confidence: 10, rationale: '근거 부족' })]), 'abstained'],
    ['refusal', message([], 'refusal'), 'refusal'],
    ['도구 호출 없음', message([{ type: 'text', text: '822 입니다' }], 'end_turn'), 'no_tool_use'],
    ['다른 도구', message([toolUse({ accountCode: '822', confidence: 80, rationale: 'x' }, 'other_tool')]), 'no_tool_use'],
    ['형식 오류', message([toolUse({ accountCode: 822, confidence: 'high' })]), 'malformed'],
  ])('%s → %s', (_l, m, reason) => {
    expect(parseClassificationResponse(m, CANDIDATES)).toEqual({ ok: false, reason });
  });

  it('음수·소수 신뢰도 보정, 빈 근거 대체, 근거 속 카드번호 스크럽', () => {
    const neg = parseClassificationResponse(message([toolUse({ accountCode: '830', confidence: -5.4, rationale: '' })]), CANDIDATES);
    expect(neg).toEqual({ ok: true, suggestion: { accountCode: '830', accountName: '소모품비', confidence: 0, rationale: 'AI 추천: 소모품비' } });
    const scrub = parseClassificationResponse(message([toolUse({ accountCode: '830', confidence: 61.6, rationale: '카드 1234-5678-9012-3456' })]), CANDIDATES);
    expect(scrub.ok && scrub.suggestion.rationale).toBe('카드 1234-****-****-3456');
    expect(scrub.ok && scrub.suggestion.confidence).toBe(62);
  });
});

describe('AnthropicProvider.classifyTransaction', () => {
  it('도구 응답 → 추천 (provider·model 표기, 상한 85)', async () => {
    const { client, calls } = fakeClient(reply(message([toolUse({ accountCode: '822', confidence: 95, rationale: '주유소 결제로 차량유지비' })])));
    const { p, events } = provider(client);
    const r = await p.classifyTransaction(input());
    expect(r).toEqual({ accountCode: '822', accountName: '차량유지비', confidence: 85, rationale: '주유소 결제로 차량유지비', provider: 'anthropic', model: DEFAULT_AI_MODEL });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toMatchObject({ timeout: 50, maxRetries: 0 });
    expect(calls[0]!.opts?.signal).toBeInstanceOf(AbortSignal);
    expect(events.map((e) => e.type)).toEqual(['request', 'success']);
  });

  it('후보에 없는 코드는 버리고 null', async () => {
    const { client } = fakeClient(reply(message([toolUse({ accountCode: '813', confidence: 80, rationale: '접대' })])));
    const { p, events } = provider(client);
    expect(await p.classifyTransaction(input())).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'invalid_output', op: 'classify', reason: 'invalid_code' });
  });

  it('타임아웃 → 1회 재시도 후 null (파이프라인을 막지 않음)', async () => {
    const { client, calls } = fakeClient(hang);
    const { p, events } = provider(client, { timeoutMs: 20 });
    const started = Date.now();
    expect(await p.classifyTransaction(input())).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.opts?.signal?.aborted).toBe(true);
    expect(events.filter((e) => e.type !== 'request')).toEqual([
      { type: 'retry', op: 'classify', attempt: 1, reason: 'timeout' },
      { type: 'failure', op: 'classify', attempt: 2, reason: 'timeout' },
    ]);
  });

  it('연결 오류 후 재시도 성공', async () => {
    const { client, calls } = fakeClient(
      fail(new APIConnectionError({ message: 'socket hang up' })),
      reply(message([toolUse({ accountCode: '811', confidence: 60, rationale: '식대' })])),
    );
    const { p } = provider(client);
    expect((await p.classifyTransaction(input()))?.accountCode).toBe('811');
    expect(calls).toHaveLength(2);
  });

  it('429·5xx 는 재시도, 400 은 재시도하지 않음', async () => {
    const rl = fakeClient(fail(new RateLimitError(429, {}, 'rate', new Headers())));
    expect(await provider(rl.client).p.classifyTransaction(input())).toBeNull();
    expect(rl.calls).toHaveLength(2);
    const bad = fakeClient(fail(new BadRequestError(400, {}, 'bad', new Headers())));
    const b = provider(bad.client);
    expect(await b.p.classifyTransaction(input())).toBeNull();
    expect(bad.calls).toHaveLength(1);
    expect(b.events.at(-1)).toEqual({ type: 'failure', op: 'classify', attempt: 1, reason: 'http_400' });
  });

  it('maxRetries 0 이면 한 번만 시도', async () => {
    const { client, calls } = fakeClient(fail(new InternalServerError(529, {}, 'overloaded', new Headers())));
    expect(await provider(client, { maxRetries: 0 }).p.classifyTransaction(input())).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('인증 실패 → 이후 호출 중단, 상태 NOT_AVAILABLE', async () => {
    const { client, calls } = fakeClient(fail(new AuthenticationError(401, {}, 'invalid x-api-key', new Headers())));
    const { p } = provider(client);
    expect(p.status().status).toBe('LIVE');
    expect(await p.classifyTransaction(input())).toBeNull();
    expect(await p.classifyTransaction(input())).toBeNull();
    expect(calls).toHaveLength(1);
    expect(p.enabled).toBe(false);
    expect(p.status()).toMatchObject({ status: 'NOT_AVAILABLE', statusReason: 'ANTHROPIC_API_KEY 인증 실패 — 키를 확인하세요' });
  });

  it.each<[string, Partial<AIClassificationInput>, string, string]>([
    ['주민번호(적요)', { description: '대표 900101-1234567 환급' }, 'input.description', 'resident_number'],
    ['카드번호(상호)', { merchantName: 'SK에너지 1234-5678-9012-3456' }, 'input.merchantName', 'card_number'],
    ['계좌번호(적요)', { description: '입금 110-123-456789' }, 'input.description', 'account_number'],
    [
      '예시 상호',
      { similarExamples: [{ merchantName: '010-1234-5678', accountCode: '822', accountName: '차량유지비', count: 1 }] },
      'input.similarExamples[0].merchantName',
      'mobile_phone',
    ],
  ])('PII 차단: %s → 전송하지 않고 null', async (_l, over, path, kind) => {
    const { client, calls } = fakeClient(reply(message([toolUse({ accountCode: '822', confidence: 80, rationale: 'x' })])));
    const { p, events } = provider(client);
    expect(await p.classifyTransaction(input(over))).toBeNull();
    expect(calls).toHaveLength(0);
    expect(events).toEqual([{ type: 'pii_blocked', op: 'classify', findings: [{ kind, path }] }]);
  });

  it('후보가 없으면 호출하지 않음', async () => {
    const { client, calls } = fakeClient(hang);
    expect(await provider(client).p.classifyTransaction(input({ candidateAccounts: [] }))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('관측 콜백이 오류를 내도 분류는 계속된다', async () => {
    const { client } = fakeClient(reply(message([toolUse({ accountCode: '822', confidence: 70, rationale: 'x' })])));
    const p = new AnthropicProvider({ client, onEvent: () => { throw new Error('logger down'); } });
    expect((await p.classifyTransaction(input()))?.accountCode).toBe('822');
  });
});

describe('AnthropicProvider 상태·키', () => {
  it('키 없음 → NOT_AVAILABLE, 호출 없이 null', async () => {
    const p = new AnthropicProvider({});
    expect(p.status()).toMatchObject({ key: 'ai_provider.anthropic', status: 'NOT_AVAILABLE', statusReason: 'ANTHROPIC_API_KEY 미설정' });
    expect(p.enabled).toBe(false);
    expect(await p.classifyTransaction(input())).toBeNull();
  });

  it('키 있음 → LIVE, 모델 표기 (네트워크 호출 없음)', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-opus-5' });
    expect(p.model).toBe('claude-opus-5');
    expect(p.status().status).toBe('LIVE');
    expect(p.status().statusReason).toContain('claude-opus-5');
    expect(p.status().statusReason).not.toContain('sk-ant-test');
  });
});

describe('AnthropicProvider.reviewLedger', () => {
  const ledger: LedgerReviewInput = {
    clientId: 'c1',
    clientName: '홍길동치과',
    industry: 'clinic',
    period: '2026-09',
    monthly: [
      { period: '2026-08', sales: 50_000_000, purchases: 32_000_000, byAccount: {} },
      { period: '2026-09', sales: 56_000_000, purchases: 47_040_000, byAccount: {} },
    ],
  };

  it('휴리스틱 결과 + LLM 요약(참고용)을 붙인다, 수임처명·ID 는 보내지 않는다', async () => {
    const { client, calls } = fakeClient(reply(message([{ type: 'text', text: '매입이 매출보다 크게 늘어 확인이 필요합니다.' }], 'end_turn')));
    const { p } = provider(client);
    const r = await p.reviewLedger(ledger);
    expect(r.map((a) => a.code)).toEqual(['REV-PURCHASE-SPIKE', 'AI-NARRATIVE']);
    expect(r[1]).toEqual({ code: 'AI-NARRATIVE', clientId: 'c1', title: 'AI 검토 요약 (참고용)', detail: '매입이 매출보다 크게 늘어 확인이 필요합니다.', severity: 'info' });
    const sent = JSON.stringify(calls[0]!.body);
    expect(sent).not.toContain('홍길동치과');
    expect(sent).not.toContain('"c1"');
    expect(sent).toContain('매입 급증 확인');
    expect(calls[0]!.body.tools).toBeUndefined();
  });

  it('요약 실패·거절 시 휴리스틱 결과만 반환', async () => {
    const failing = fakeClient(fail(new BadRequestError(400, {}, 'bad', new Headers())));
    expect((await provider(failing.client).p.reviewLedger(ledger)).map((a) => a.code)).toEqual(['REV-PURCHASE-SPIKE']);
    const refused = fakeClient(reply(message([], 'refusal')));
    expect((await provider(refused.client).p.reviewLedger(ledger)).map((a) => a.code)).toEqual(['REV-PURCHASE-SPIKE']);
  });

  it('이상징후가 없거나 요약 옵션이 꺼져 있으면 호출하지 않음', async () => {
    const { client, calls } = fakeClient(hang);
    const quiet = { ...ledger, monthly: [ledger.monthly[0]!, { ...ledger.monthly[0]!, period: '2026-09' }] };
    expect(await provider(client).p.reviewLedger(quiet)).toEqual([]);
    expect((await provider(client, { ledgerNarrative: false }).p.reviewLedger(ledger)).map((a) => a.code)).toEqual(['REV-PURCHASE-SPIKE']);
    expect(calls).toHaveLength(0);
  });

  it('탐지·설명·규칙 제안은 결정적 휴리스틱에 위임 (네트워크 없음)', async () => {
    const { client, calls } = fakeClient(hang);
    const { p } = provider(client);
    const anomalies = await p.detectAnomaly({ clientId: 'c1', period: '2026-09', sourceCounts: { wemembers: { card: 3 }, processed: { card: 2 } } });
    expect(anomalies.map((a) => a.code)).toEqual(['REV-SOURCE-GAP']);
    expect(await p.suggestRule({ corrections: [] })).toEqual([]);
    const fallbackExplain = vi.fn(async () => '설명');
    const withFallback = new AnthropicProvider({
      client,
      fallback: {
        name: 'stub',
        model: null,
        status: () => ({ key: 's', name: 's', status: 'MOCK', statusReason: '', capabilities: [] }),
        classifyTransaction: async () => null,
        reviewLedger: async () => [],
        detectAnomaly: async () => [],
        explainClassification: fallbackExplain,
        suggestRule: async () => [],
      },
    });
    expect(await withFallback.explainClassification({} as never)).toBe('설명');
    expect(calls).toHaveLength(0);
  });
});

describe('classifyAnthropicError', () => {
  it('재시도 가능 여부 분류', () => {
    expect(classifyAnthropicError(new APIConnectionError({ message: 'x' }))).toEqual({ retryable: true, reason: 'connection' });
    expect(classifyAnthropicError(new InternalServerError(500, {}, 'x', new Headers()))).toEqual({ retryable: true, reason: 'http_500' });
    expect(classifyAnthropicError(new AuthenticationError(401, {}, 'x', new Headers()))).toEqual({ retryable: false, reason: 'auth_401' });
    expect(classifyAnthropicError(new TypeError('boom'))).toEqual({ retryable: false, reason: 'unexpected_error' });
  });
});
