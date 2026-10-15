/** Longest client address kept; longer header values are cut so map keys and logs stay bounded. */
const MAX_ADDRESS_LENGTH = 64;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/i;

/**
 * The client's address: the proxy's header (`Fly-Client-IP`) when the deployment trusts it, the
 * socket peer otherwise. An untrusted header is ignored — any client could set it to dodge the
 * per-IP cap.
 */
export function clientAddress(
  header: string | readonly string[] | undefined,
  remoteAddress: string | undefined,
  trustHeader: boolean,
): string {
  if (trustHeader) {
    const value = (typeof header === 'string' ? header : header?.[0])?.trim();
    if (value !== undefined && value !== '') return value.slice(0, MAX_ADDRESS_LENGTH);
  }
  return remoteAddress ?? 'unknown';
}

function parseIpv4(text: string): number[] | undefined {
  const match = IPV4.exec(text);
  if (match === null) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** Hextets of one side of `::`, an embedded IPv4 counting as two; `undefined` when malformed. */
function parseHextets(part: string, allowIpv4: boolean): number[] | undefined {
  if (part === '') return [];
  const pieces = part.split(':');
  const groups: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (allowIpv4 && index === pieces.length - 1 && piece.includes('.')) {
      const octets = parseIpv4(piece);
      if (octets === undefined) return undefined;
      const [a = 0, b = 0, c = 0, d = 0] = octets;
      groups.push(a * 256 + b, c * 256 + d);
    } else if (HEXTET.test(piece)) {
      groups.push(Number.parseInt(piece, 16));
    } else {
      return undefined;
    }
  }
  return groups;
}

/** The eight hextets of an IPv6 address, or `undefined` when it is not one. */
export function expandIpv6(address: string): number[] | undefined {
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const [first = '', second] = halves;
  if (second === undefined) {
    const groups = parseHextets(first, true);
    return groups?.length === 8 ? groups : undefined;
  }
  const head = parseHextets(first, false);
  const tail = parseHextets(second, true);
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

/**
 * The key the per-IP connection cap counts: an IPv4 address as is (also when IPv4-mapped in IPv6),
 * an IPv6 address by its /64 prefix — one subscriber usually owns a whole /64, so counting single
 * addresses would let a client open a stream from every address of its network. Anything else is
 * used verbatim (lowercased).
 */
export function ipKey(address: string): string {
  const text = address
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  if (parseIpv4(text) !== undefined) return text;
  const groups = expandIpv6(text);
  if (groups === undefined) return text.slice(0, MAX_ADDRESS_LENGTH);
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return `${String(g >> 8)}.${String(g & 0xff)}.${String(h >> 8)}.${String(h & 0xff)}`;
  }
  return `${[a, b, c, d].map((group) => group.toString(16)).join(':')}::/64`;
}
