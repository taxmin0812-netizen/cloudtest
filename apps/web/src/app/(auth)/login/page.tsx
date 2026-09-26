import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: '로그인' };

const REASONS: Record<string, string> = {
  idle: '일정 시간 사용하지 않아 자동 로그아웃되었습니다.',
  absolute: '로그인 유지 시간이 지나 자동 로그아웃되었습니다.',
  expired: '세션이 만료되었습니다. 다시 로그인해 주세요.',
  logout: '로그아웃되었습니다.',
  ip_blocked: '허용되지 않은 위치(IP)에서 접속했습니다.',
  inactive: '비활성화된 계정입니다.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string; next?: string }> }) {
  const sp = await searchParams;
  const notice = sp.reason ? REASONS[sp.reason] : undefined;
  const next = sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//') ? sp.next : '/';
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[360px]">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-navy text-sm font-bold text-white">M</div>
          <div>
            <div className="text-[15px] font-semibold">MIN TAX OPS</div>
            <div className="text-xs text-muted">세무회계 민 · 업무자동화 OS</div>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
          {notice ? <div className="mb-4 rounded bg-subtle px-3 py-2 text-xs text-muted">{notice}</div> : null}
          <LoginForm next={next} />
        </div>
        <p className="mt-4 text-center text-2xs text-muted">모든 접속·다운로드·변경은 감사로그에 기록됩니다.</p>
      </div>
    </div>
  );
}
