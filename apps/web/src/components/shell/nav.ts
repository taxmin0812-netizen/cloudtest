/**
 * 네비게이션 — "사람이 처리해야 할 일" 순서로 배치.
 * badgeKey: 서버에서 내려주는 미처리 건수 키 (0이면 배지 숨김)
 */
export interface NavItem {
  href: string;
  label: string;
  icon: string; // lucide icon name
  badgeKey?: string;
  permission?: string;
}

export const NAV_SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '업무',
    items: [
      { href: '/', label: '대시보드', icon: 'LayoutDashboard' },
      { href: '/inbox', label: '예외함', icon: 'Inbox', badgeKey: 'inbox' },
      { href: '/transfer', label: 'WEHAGO 전송센터', icon: 'Send', badgeKey: 'transfer' },
      { href: '/payroll', label: '인건비', icon: 'Users', badgeKey: 'payroll' },
      { href: '/filing', label: '원천세 신고', icon: 'FileCheck2', badgeKey: 'filing' },
    ],
  },
  {
    title: '자료',
    items: [
      { href: '/imports', label: '자료 수집', icon: 'Download', badgeKey: 'imports' },
      { href: '/clients', label: '거래처', icon: 'Building2' },
      { href: '/review', label: 'AI 장부검토', icon: 'ScanSearch', badgeKey: 'review' },
    ],
  },
  {
    title: '관리',
    items: [
      { href: '/rules', label: 'Rule Studio', icon: 'Workflow', badgeKey: 'rules' },
      { href: '/kpi', label: '자동화 KPI', icon: 'Gauge' },
      { href: '/audit', label: '감사 로그', icon: 'History', permission: 'audit.read' },
      { href: '/settings', label: '설정', icon: 'Settings' },
    ],
  },
];
