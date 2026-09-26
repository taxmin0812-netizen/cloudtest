/**
 * 접속 IP 허용 대역 검사 (users.allowed_ip_ranges).
 * - IPv4 / IPv6 (:: 압축, 끝부분 IPv4 표기, zone id '%eth0', 대괄호 표기) 지원
 * - IPv4-mapped IPv6 ('::ffff:1.2.3.4') 는 IPv4 로 취급한다 (Node 듀얼스택 소켓이 이 형태로 준다)
 * - 허용 목록이 비어 있으면 제한 없음. 목록이 있는데 IP 가 없거나 형식이 틀리면 거부 (fail closed)
 */

export interface ParsedIp {
  version: 4 | 6;
  bytes: Uint8Array;
}

export interface ParsedCidr extends ParsedIp {
  prefix: number;
}

function parseIpv4(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = m[i + 1]!;
    // '010' 같은 선행 0 은 8진수 해석 혼동이 있어 거부
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(input: string): Uint8Array | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s === '' || /[^0-9a-fA-F:.]/.test(s)) return null;

  // 끝부분 IPv4 표기
  let tailV4: Uint8Array | null = null;
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    tailV4 = parseIpv4(s.slice(lastColon + 1));
    if (!tailV4) return null;
    // 마지막 32bit 를 임시 그룹 2개로 바꿔 그룹 수 계산을 통일한다
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(dbl[0]!);
  const tail = dbl.length === 2 ? parseGroups(dbl[1]!) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  if (tailV4) bytes.set(tailV4, 12);
  return bytes;
}

function isV4Mapped(b: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return false;
  return b[10] === 0xff && b[11] === 0xff;
}

function toMappedV6(v4: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  out.set(v4, 12);
  return out;
}

/** IP 문자열 파싱. IPv4-mapped IPv6 는 IPv4 로 변환. 형식 오류면 null */
export function parseIp(ip: string | null | undefined): ParsedIp | null {
  if (typeof ip !== 'string') return null;
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s === '') return null;
  if (!s.includes(':')) {
    const v4 = parseIpv4(s);
    return v4 ? { version: 4, bytes: v4 } : null;
  }
  const v6 = parseIpv6(s);
  if (!v6) return null;
  if (isV4Mapped(v6)) return { version: 4, bytes: v6.slice(12) };
  return { version: 6, bytes: v6 };
}

/** '10.0.0.0/8', '2001:db8::/32', 단일 IP('1.2.3.4' → /32). 형식 오류면 null */
export function parseCidr(cidr: string | null | undefined): ParsedCidr | null {
  if (typeof cidr !== 'string') return null;
  const s = cidr.trim();
  const slash = s.indexOf('/');
  const addr = slash >= 0 ? s.slice(0, slash) : s;
  const prefixStr = slash >= 0 ? s.slice(slash + 1) : null;
  if (prefixStr !== null && !/^\d{1,3}$/.test(prefixStr)) return null;

  // CIDR 는 mapped 변환 없이 원래 주소 체계로 보관 (::ffff:0:0/96 같은 표기 지원)
  let version: 4 | 6;
  let bytes: Uint8Array | null;
  if (addr.includes(':')) {
    version = 6;
    bytes = parseIpv6(addr.startsWith('[') && addr.endsWith(']') ? addr.slice(1, -1) : addr);
  } else {
    version = 4;
    bytes = parseIpv4(addr);
  }
  if (!bytes) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = prefixStr === null ? max : Number(prefixStr);
  if (prefix < 0 || prefix > max) return null;
  return { version, bytes, prefix };
}

function prefixMatch(a: Uint8Array, b: Uint8Array, prefix: number): boolean {
  const full = Math.floor(prefix / 8);
  for (let i = 0; i < full; i++) if (a[i] !== b[i]) return false;
  const rem = prefix % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (a[full]! & mask) === (b[full]! & mask);
}

function matches(ip: ParsedIp, cidr: ParsedCidr): boolean {
  if (ip.version === cidr.version) return prefixMatch(ip.bytes, cidr.bytes, cidr.prefix);
  // IPv4 클라이언트 vs IPv6 대역: mapped 주소로 비교 (예: ::ffff:10.0.0.0/104, ::/0)
  if (ip.version === 4 && cidr.version === 6) return prefixMatch(toMappedV6(ip.bytes), cidr.bytes, cidr.prefix);
  return false;
}

export function isIpInCidr(ip: string | null | undefined, cidr: string): boolean {
  const p = parseIp(ip);
  const c = parseCidr(cidr);
  return !!p && !!c && matches(p, c);
}

/**
 * 허용 여부. cidrs 가 비어 있으면(또는 null) 제한 없음 → true.
 * 목록이 있으면 IP 가 하나라도 일치해야 true. 잘못된 CIDR 항목은 무시(어떤 IP 와도 불일치).
 */
export function isIpAllowed(ip: string | null | undefined, cidrs: readonly string[] | null | undefined): boolean {
  if (cidrs === null || cidrs === undefined) return true;
  // jsonb 컬럼에 배열이 아닌 값이 들어간 경우: 예외(500) 대신 거부 (fail closed)
  if (!Array.isArray(cidrs)) return false;
  if (cidrs.length === 0) return true;
  const parsed = parseIp(ip);
  if (!parsed) return false;
  for (const c of cidrs) {
    const pc = parseCidr(c);
    if (pc && matches(parsed, pc)) return true;
  }
  return false;
}

/** 설정 화면 입력 검증 (한국어 사유) */
export function validateCidrList(cidrs: readonly string[]): { valid: string[]; errors: Array<{ value: string; message: string }> } {
  const valid: string[] = [];
  const errors: Array<{ value: string; message: string }> = [];
  for (const raw of cidrs) {
    const v = String(raw ?? '').trim();
    if (v === '') continue;
    if (parseCidr(v)) valid.push(v);
    else errors.push({ value: v, message: `'${v.slice(0, 60)}' 은(는) 올바른 IP 또는 대역(CIDR) 형식이 아닙니다. 예: 203.0.113.10 또는 203.0.113.0/24` });
  }
  return { valid, errors };
}
