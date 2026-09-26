import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'MIN TAX OPS', template: '%s · MIN TAX OPS' },
  description: '세무회계 민 — 업무자동화 OS',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
