/**
 * 暴雪炉石传说卡组代码（Deckstring）解码器。
 *
 * 支持两种输入：
 *   1. 游戏内「复制套牌」得到的完整分享文本（含 `### 套牌名`、`# 职业：...` 和代码行）；
 *   2. 裸 `AAEBA...` Base64 字符串。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cardClassesZh, cardClassZh, cardCostOf, cardName, cardNote } from './effects.ts';

export interface DecodedDeckCard {
  dbfId: number;
  cardId: string;
  name: string;
  cost: number;
  count: number;
  note: string;
}

export interface DecodedDeck {
  code: string;
  name: string;
  format: 'standard' | 'wild' | 'twist' | 'classic' | 'unknown';
  formatZh: string;
  heroCardId: string;
  heroClass: string;
  totalCards: number;
  cards: DecodedDeckCard[];
  unknownDbfIds: number[];
}

const FORMAT_MAP: Record<number, { format: DecodedDeck['format']; zh: string }> = {
  1: { format: 'wild', zh: '狂野' },
  2: { format: 'standard', zh: '标准' },
  3: { format: 'classic', zh: '经典' },
  4: { format: 'twist', zh: '幻变' },
};

const HERO_PREFIX_CLASS: Record<string, string> = {
  HERO_01: '战士', HERO_02: '萨满', HERO_03: '潜行者', HERO_04: '圣骑士', HERO_05: '猎人',
  HERO_06: '德鲁伊', HERO_07: '术士', HERO_08: '法师', HERO_09: '牧师', HERO_10: '恶魔猎手', HERO_11: '死亡骑士',
};

let dbfTable: Record<string, string> | null = null;

function loadDbfMap(): Record<string, string> {
  if (dbfTable) return dbfTable;
  try {
    const file = fileURLToPath(new URL('./data/dbf-map.json', import.meta.url));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cards?: Record<string, string> };
    dbfTable = raw.cards ?? {};
  } catch {
    dbfTable = {};
  }
  return dbfTable;
}

function readVarint(buf: Uint8Array, offset: { pos: number }): number {
  let result = 0;
  let shift = 0;
  while (offset.pos < buf.length) {
    const b = buf[offset.pos];
    offset.pos += 1;
    result += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) return result;
    shift += 7;
    if (shift > 49) throw new Error('卡组代码 varint 溢出');
  }
  throw new Error('卡组代码在 varint 中途截断');
}

function extractDeckCodeAndName(raw: string): { code: string; name: string; classHint: string } {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let name = '';
  let classHint = '';
  let code = '';

  for (const line of lines) {
    if (line.startsWith('###')) {
      name = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    const cls = /^#\s*(?:职业|Class)[:：]\s*(.+)$/i.exec(line);
    if (cls) {
      classHint = cls[1].trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^[A-Za-z0-9+/=]{12,}$/.test(line)) {
      code = line;
    }
  }

  if (!code) {
    // 允许同一行里混着文字和代码，提取最长合法 Base64 段
    const m = /(AAE[A-Za-z0-9+/=]{12,})/.exec(raw.trim());
    if (m) code = m[1];
  }
  return { code, name, classHint };
}

function resolveHeroClass(heroCardId: string, classHint: string, cards: DecodedDeckCard[]): string {
  if (heroCardId) {
    const prefix = HERO_PREFIX_CLASS[heroCardId.slice(0, 7).toUpperCase()];
    if (prefix) return prefix;
    const byTable = cardClassZh(heroCardId);
    if (byTable && byTable !== '中立') return byTable;
  }
  if (classHint) return classHint;
  for (const c of cards) {
    const classes = cardClassesZh(c.cardId).filter((cls) => cls !== '中立');
    if (classes.length === 1) return classes[0];
  }
  return '';
}

export function decodeDeckString(input: string): { ok: true; deck: DecodedDeck } | { ok: false; error: string } {
  const { code, name, classHint } = extractDeckCodeAndName(input);
  if (!code) {
    return { ok: false, error: '没在输入里找到卡组代码（形如 AAEBA...）。' };
  }

  let buf: Uint8Array;
  try {
    buf = Uint8Array.from(Buffer.from(code, 'base64'));
  } catch {
    return { ok: false, error: '卡组代码不是合法的 Base64 格式。' };
  }
  if (buf.length < 6) return { ok: false, error: '卡组代码太短，不完整。' };

  const off = { pos: 0 };
  try {
    const reserved = buf[off.pos];
    off.pos += 1;
    if (reserved !== 0) return { ok: false, error: '卡组代码头部字节不对（应为 0x00）。' };

    const version = readVarint(buf, off);
    if (version !== 1) return { ok: false, error: `不支持的卡组代码版本：${version}。` };

    const formatNum = readVarint(buf, off);
    const fmt = FORMAT_MAP[formatNum] ?? { format: 'unknown' as const, zh: '未知赛制' };

    const heroCount = readVarint(buf, off);
    const heroes: number[] = [];
    for (let i = 0; i < heroCount; i += 1) heroes.push(readVarint(buf, off));

    const counts = new Map<number, number>();
    const add = (dbfId: number, n: number) => {
      if (dbfId <= 0 || n <= 0) return;
      counts.set(dbfId, (counts.get(dbfId) ?? 0) + n);
    };

    const oneCount = readVarint(buf, off);
    for (let i = 0; i < oneCount; i += 1) add(readVarint(buf, off), 1);

    const twoCount = readVarint(buf, off);
    for (let i = 0; i < twoCount; i += 1) add(readVarint(buf, off), 2);

    const nCount = readVarint(buf, off);
    for (let i = 0; i < nCount; i += 1) {
      const dbfId = readVarint(buf, off);
      const cnt = readVarint(buf, off);
      add(dbfId, cnt);
    }

    // 尾部如有 sideboard（1 字节标记 = 1），仅做边界校验不抛错，暂不并入主牌库计数
    const dbfMap = loadDbfMap();
    const heroCardId = heroes[0] ? (dbfMap[String(heroes[0])] ?? '') : '';
    const cards: DecodedDeckCard[] = [];
    const unknownDbfIds: number[] = [];
    let totalCards = 0;

    for (const [dbfId, count] of counts) {
      totalCards += count;
      const cardId = dbfMap[String(dbfId)] ?? '';
      if (!cardId) {
        unknownDbfIds.push(dbfId);
        cards.push({
          dbfId,
          cardId: `DBF_${dbfId}`,
          name: `未知卡牌(#${dbfId})`,
          cost: 0,
          count,
          note: '',
        });
        continue;
      }
      cards.push({
        dbfId,
        cardId,
        name: cardName(cardId) || cardId,
        cost: cardCostOf(cardId) ?? 0,
        count,
        note: cardNote(cardId),
      });
    }

    cards.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh'));
    const heroClass = resolveHeroClass(heroCardId, classHint, cards);

    return {
      ok: true,
      deck: {
        code,
        name: name || (heroClass ? `${heroClass}套牌` : '导入的套牌'),
        format: fmt.format,
        formatZh: fmt.zh,
        heroCardId,
        heroClass,
        totalCards,
        cards,
        unknownDbfIds,
      },
    };
  } catch (err) {
    return { ok: false, error: `解析卡组代码失败：${(err as Error).message}` };
  }
}

/** 编码测试/构造用 Deckstring（单测或工具内部用）。 */
export function encodeDeckString(opts: {
  format?: number;
  heroes: number[];
  cards: readonly { dbfId: number; count: number }[];
}): string {
  const bytes: number[] = [0, 1];
  const pushVarint = (v: number) => {
    let n = Math.floor(v);
    while (n >= 0x80) {
      bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    bytes.push(n & 0x7f);
  };
  pushVarint(opts.format ?? 2);
  pushVarint(opts.heroes.length);
  for (const h of opts.heroes) pushVarint(h);
  const ones = opts.cards.filter((c) => c.count === 1).map((c) => c.dbfId);
  const twos = opts.cards.filter((c) => c.count === 2).map((c) => c.dbfId);
  const more = opts.cards.filter((c) => c.count > 2);
  pushVarint(ones.length);
  for (const id of ones) pushVarint(id);
  pushVarint(twos.length);
  for (const id of twos) pushVarint(id);
  pushVarint(more.length);
  for (const c of more) {
    pushVarint(c.dbfId);
    pushVarint(c.count);
  }
  return Buffer.from(bytes).toString('base64');
}

export function dbfIdToCardId(dbfId: number): string {
  return loadDbfMap()[String(dbfId)] ?? '';
}
