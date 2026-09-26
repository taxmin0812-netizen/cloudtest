'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { ApiError, apiFetch } from '@/lib/client/api';

export function LoginForm({ next }: { next: string }) {
  const [step, setStep] = React.useState<'password' | 'mfa'>('password');
  const [challenge, setChallenge] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<{ status: string; next?: string; challengeToken?: string }>('/api/auth/login', {
        method: 'POST',
        json: { email: fd.get('email'), password: fd.get('password') },
      });
      if (r.status === 'mfa_required' && r.challengeToken) {
        setChallenge(r.challengeToken);
        setStep('mfa');
      } else {
        window.location.href = r.next && r.next !== '/' ? r.next : next;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '로그인하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function onMfa(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<{ next?: string }>('/api/auth/mfa', { method: 'POST', json: { challengeToken: challenge, code: fd.get('code') } });
      window.location.href = r.next && r.next !== '/' ? r.next : next;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'OTP 인증에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  if (step === 'mfa') {
    return (
      <form onSubmit={onMfa} className="space-y-3">
        <div>
          <Label htmlFor="code">OTP 6자리 (또는 복구 코드)</Label>
          <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required />
        </div>
        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        <Button type="submit" variant="primary" className="w-full justify-center" loading={loading}>
          확인
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={onPassword} className="space-y-3">
      <div>
        <Label htmlFor="email">이메일</Label>
        <Input id="email" name="email" type="email" autoComplete="username" autoFocus required />
      </div>
      <div>
        <Label htmlFor="password">비밀번호</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      <Button type="submit" variant="primary" className="w-full justify-center" loading={loading}>
        로그인
      </Button>
    </form>
  );
}
