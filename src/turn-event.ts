/**
 * 回合事件的内容拼装。
 *
 * 单独拎出来是因为这部分最容易出错,而且**没法靠日志重放稳定地测**:
 * 一条事件里有两句话(局面 + 建议),它们必须来自同一份快照;而快照什么时候算得出、
 * 水晶有没有刷新,取决于日志批次的切法。把它做成纯函数,输入输出都能直接断言。
 *
 * 踩过的三个坑,都写在这里:
 *
 * 1. **两句话来自不同时刻。** 局面取「回合开始那一刻」、建议现取当前解析器状态,
 *    结果文字说「对手 9 血、场面 1 个」,建议说「对面场攻 9」——自相矛盾。
 * 2. **回合刚变那一刻水晶还是 0。** 上一回合的消耗还没归零,拿这份状态算建议,
 *    会得出「没牌可打也沒随从能动」,而他手上八张牌、场上三个随从。
 * 3. **等不到就硬发。** 与其发一句错的,不如只报局面(甚至晚一批再发)。
 */
import type { GameSnapshot, TurnPoint } from './parser.ts';
import { briefAdvice, type AdviceOptions } from './advice.ts';
import { turnPointText, turnText } from './alerts.ts';

export interface ComposedTurn {
  /** 推送正文;defer 为 true 时为空串。 */
  text: string;
  /** 是否附了建议。 */
  hasAdvice: boolean;
  /** 局面还不可用(水晶没刷新),建议下一批再试。 */
  defer: boolean;
}

/**
 * 把「回合点 + 最新局面」拼成一条推送。
 *
 * @param point   待推送的回合点(解析器在轮到我时记下的)
 * @param latest  当前最新的完整局面(可能是别的回合的,会被丢弃)
 * @param advice  是否附建议
 */
/**
 * 这一帧算不算「我已经能动手」。
 *
 * 只看 mana > 0 不够 —— 实测抓到过好几帧过渡态:第 18 回合 mana=1(上一回合的
 * RESOURCES_USED 还没归零)、第 4 回合 manaMax 还停在 1。那一帧满手牌却被算成
 * 「没牌可打」,而真相是水晶还没刷新。
 *
 * 判据换成「水晶上限到没到这一回合该有的值」:炉石里我方第 k 个回合就是 k 水晶,
 * 全局回合数是 2k(对手先手)或 2k-1(我先手),所以期望上限 = ceil(turn / 2)。
 * 拿不到这个值就说明还在吃上一回合的残值,该再等一批。
 */
function isActionable(s: GameSnapshot): boolean {
  if (s.turn === 1) return true;
  if (s.me.mana <= 0) return false;
  const expectedMax = Math.ceil(s.turn / 2);
  return s.me.manaMax >= expectedMax;
}

export function composeTurnEvent(
  point: TurnPoint,
  latest: GameSnapshot | null,
  advice: boolean,
  /** 核心牌名单,透传给 `briefAdvice` —— 它需要用这个把 combo 核心从「按费打」里摘出来。 */
  keepCards: string | string[] = [],
  /**
   * 这回合要避开的牌名（上一张连推了两次、他没打的）。透传给 `briefAdvice`。
   * 判据在 `world.ts` 里算 —— 这里只负责传，不判断「该不该避」。
   */
  avoid: string[] = [],
  /** 记牌器与对手主流卡组匹配等额外上下文。 */
  extra?: Pick<AdviceOptions, 'tracker' | 'matchupHint'>,
): ComposedTurn {
  // 只认同一回合:跨回合的数字绝不能混进同一句话
  const sameTurn = latest && latest.turn === point.turn ? latest : null;
  const usable = sameTurn && isActionable(sameTurn) ? sameTurn : null;

  if (usable) {
    const base = turnText(usable);
    if (!advice) return { text: base, hasAdvice: false, defer: false };
    const brief = briefAdvice(usable, { keepCards, avoid, ...extra });
    // `建议[scared]:` —— 方括号里是表情 id。她在 `pet_say` 里写成 `<scared>`;
    // 直接写在 `建议:` 后面是为了不占额外一行,也避免被当成正文念出来。
    const face = brief.face ? `[${brief.face}]` : '';
    return { text: `${base}\n建议${face}:${brief.text}`, hasAdvice: true, defer: false };
  }

  // 还是同一回合、只是资源没刷新 —— 等下一批
  if (sameTurn && !point.waited) {
    return { text: '', hasAdvice: false, defer: true };
  }

  // 追不上了(回合已过)或者已经等过一次:只报局面
  return { text: turnPointText(point), hasAdvice: false, defer: false };
}

/**
 * 换局时把回合水位清零。
 *
 * **这是「打着打着她不说话了」的真凶。** 水位（`lastAnnouncedTurn`）是严格递增的:
 * 这一局推到第 16 回合,下一局从第 1 回合开始,`1 > 16` 是假命题 —— 于是整局一句都不出,
 * 要等新局的回合数爬过 16 才突然恢复。用户看到的就是「前几局好好的,后来就不推荐了」。
 *
 * 判据用「回合号掉回去了」而不是只靠 `CREATE_GAME`:启动补历史、炉石断线重连时,
 * 第一批进来往往已经在一局的中段,那次 CREATE_GAME 根本不在这一批里。
 * 回合号变小是逃不掉的。
 */
export function settleTurnWatermark(lastAnnounced: number, turn: number): number {
  return turn < lastAnnounced ? -1 : lastAnnounced;
}

/** 这一批该不该开口报回合。 */
export function shouldAnnounceTurn(
  s: { turn: number; isMyTurn: boolean; ended: boolean },
  lastAnnounced: number,
): boolean {
  return !s.ended && s.isMyTurn && s.turn > lastAnnounced;
}

/**
 * 从建议行里抠出「它让你打的那张牌」。
 *
 * 用途只有一个：判断**这一回合推的牌是不是和上回合同一张**。
 * 2026-10-30 实测：一局里连着五个回合都推「大力扣杀」，她也跟着说了五遍
 * （21:47 / 21:48 / 21:49 / 21:50 / 21:50）。根因不在她 —— `briefAdvice`
 * 每回合独立算，压根不知道上回合推过什么。所以要在事件正文里把「这是第几遍」告诉她，
 * 让「换个说法或者别提」有一个具体的、可执行的依据。
 *
 * 抠不出来就返回空串：宁可不禁重复，也别瞎猜一个牌名出来。
 */
export function advicePick(text: string): string {
  if (!text) return '';
  // 主要形态：「按费打:大力扣杀(6费 …)」「按费打:星界翔龙(4费 …)、时序光环(5费 …)」
  //
  // **牌名里可能有逗号。** 传说牌的全名带逗号：「诺兹多姆，青铜守护巨龙」。
  // 原来把 `，,` 当分隔符，抠出来只剩「诺兹多姆」—— 归档里那回合就记成
  // 「她推诺兹多姆、他打诺兹多姆，青铜守护巨龙」，看起来像没听建议，其实听了。
  // 2026-11-03 那 8 局里有 2 处是这么被冤枉的。
  //
  // 分隔符只认「( 」「、」「空白」和分号 —— 这几个不会出现在牌名里。
  const play = /按费打[:：]\s*([^()\s、;；]+)/.exec(text);
  if (play) return asPickName(play[1]);
  // 换牌形态：「先换:xxx」
  const trade = /先换[:：]\s*([^()\s、;；]+)/.exec(text);
  if (trade) return asPickName(trade[1]);
  // 清场形态：「清场:xxx(...)」
  const clear = /清场[:：]\s*([^()\s、;；]+)/.exec(text);
  if (clear) return asPickName(clear[1]);
  return '';
}

/**
 * 抓出来的是不是「牌名」。
 *
 * 2026-11-20 补。`先换:` 后面原来接的是随从**身材**（`8/8 打 滑行者巨怪…`），
 * 于是这一句被记成「她推了『8/8』这张牌」，写进日记是
 * 「T17：我说『8/8』，他打了『谦恭审判』」，再被算进「推了他没听」的分歧。
 * 历史上同型还有 4 处（「2/3」「2/1圣盾」「2/2」「3/3」），全在 `先换` 分支上。
 *
 * 现在文本侧已经改成「随从名(身材)」（见 advice.ts 的 myLabel），
 * 这里再兜一层：纯数字身材 / 身材+关键词，一律不算牌名，宁可不参与去重统计。
 */
function asPickName(raw: string): string {
  const name = raw.trim();
  // 「8/8」「5/4」「2/1圣盾」—— 前半截是 a/b 的都算身材，不是牌名
  if (/^\d+\s*\/\s*\d+/.test(name)) return '';
  return name;
}

/**
 * 她推的那张，和他打的那张，是不是同一张。
 *
 * 为什么要单独判：归档里这两个字段都是**牌名字符串**，而牌名在两处来源里长度不同 ——
 * 建议里给的是卡表全名（「诺兹多姆，青铜守护巨龙」），动作记录里给的是场上实体名
 * （常常是简称「诺兹多姆」）。直接 `===` 比会把「听了建议」记成「没听」。
 *
 * 2026-11-03 那 8 局里就有两处这么被冤枉的：T11、T8 明明打的就是推的那张。
 * 这类假差异会污染「她推的和他差的多少」这个唯一能拿来看趋势的指标，
 * 所以判据放在这里由代码给结论，不留给读 json 的人自己比字符串。
 *
 * 两边有一边为空（那回合没建议 / 没出牌）时返回 null，不返回 false ——
 * 「没得比」和「没听」是两件事，混在一起统计就废了。
 */
export function sameCardName(advised: string | null, played: string | null): boolean | null {
  const norm = (s: string) => s.replace(/[\s，,。.;；、:：()（）·]/g, '');
  const a = advised ? norm(advised) : '';
  const b = played ? norm(played) : '';
  if (!a || !b) return null;
  if (a === b) return true;
  // 简称 / 全名的关系：一方是另一方的前缀就算同一张。
  // 反过来不成立的部分（同名前缀的另一张牌）在实战里没见过，先按同一张算。
  return b.startsWith(a) || a.startsWith(b);
}

/**
 * 从动作记录里抠出「他打出的第一张牌」。
 * 动作文本有两种形态：`打出 正义保护者` / `打出 大力扣杀 → 拨号机器人`（带目标的法术）。
 * 只取牌名，目标不要 —— 归档是为了回答「她推的和实际打的是不是同一张」。
 */
export function playedCardName(text: string): string | null {
  if (!text) return null;
  const m = /^打出\s+(.+?)(?:\s*→|$)/.exec(text.trim());
  return m ? m[1].trim() : null;
}
