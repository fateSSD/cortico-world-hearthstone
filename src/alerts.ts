/**
 * 告警判定与「把局面说成一句话」的渲染。
 *
 * 原则:只说事实,不写建议。「生命值 6 血,对方场攻 11」是事实;「你该清场了」是判断,
 * 那一步留给 bot 自己说。这样子才不会被固定话术绑住,也能随对局语气变。
 *
 * 每一条告警都在一局里只报一次(firedAlerts,由解析器持有并在换局时清空);
 * 否则一回合里血量抖动会把同一件事反复推过去。
 */
import type { ActionRecord, GameSnapshot, SideState, TurnPoint } from './parser.ts';
import { cardBody, cardClassZh, cardName, isLegendary } from './effects.ts';
import { planLethal, worstCaseFaceAttack } from './lethal.ts';

export interface AlertContext {
  before: GameSnapshot | null;
  now: GameSnapshot;
  alertHealth: number;
  swarmCount: number;
}

export interface Alert {
  /** 一局内唯一,用于去重。 */
  id: string;
  /** 中文事实陈述。 */
  text: string;
  /** 紧迫度。决定她用多重的口吻说这句话,见 ENV_PROMPT。 */
  tone?: AlertTone;
  /**
   * 指定表情。不给就按 id 查 `FACE` 表。
   *
   * 为什么需要:`surprise` 这条的 id 是按牌生成的(`surprise:A_123`),查表查不到,
   * 会退回 neutral —— 那就白做了。所以让这类动态 id 自己带脸。
   */
  face?: FaceId;
}
/** 三种紧迫度,对应三种反应强度。 */
export type AlertTone = 'calm' | 'tense' | 'danger';

/**
 * 每条告警的紧迫度。
 *
 * 按 id 查而不是写在每处 push 里:告警的措辞会改,紧迫度很少改;
 * 而且集中在一张表里,一眼能看出「哪些算危险」。
 */
const TONE: Record<string, AlertTone> = {
  'critical-health': 'danger',
  'lethal-threat': 'danger',
  'fatigue': 'danger',
  // 卡片效果扣的疲劳:还没到牌库见底那种绝境,但也不是小事
  'fatigue-effect': 'tense',
  'low-health': 'tense',
  'swarmed': 'tense',
  'empty-board': 'tense',
  'empty-hand': 'tense',
  'deck-low': 'tense',
  'momentum': 'tense',
  'reversal': 'tense',
  'foe-low': 'calm',
  'board-lethal': 'calm',
  'near-lethal': 'calm',
  'mana-flooded': 'calm',
  'foe-hoarding': 'calm',
  'surprise': 'calm',
};

export function toneOf(alert: Alert): AlertTone {
  return alert.tone ?? TONE[alert.id] ?? 'calm';
}

/**
 * 表情 id。用的是桌宠立绘包自带的那套词表(coo 和 whale 两个包完全相同)。
 *
 * 为什么要在事件里给表情:光靠文字分三档「提醒/紧张/危险」,她说话还是同一个语气;
 * 真正让局势变化被看见的是**脸变了**。桌宠的 `pet_say` 支持在话里插 `<表情>` 标记,
 * 但那个标记该用哪个词,得由事件告诉她 —— 她自己猜会写成不存在的词,被静默丢弃。
 */
export type FaceId =
  | 'neutral' | 'happy' | 'wink' | 'love' | 'shy' | 'surprised' | 'angry'
  | 'sad' | 'sleepy' | 'thinking' | 'smug' | 'pout' | 'worried' | 'determined'
  | 'flustered' | 'scared' | 'excited' | 'cry' | 'confused';

/**
 * 告警 → 表情。
 *
 * 分档原则:**脸比嘴快**。快死了必须是 scared/flustered 这类"一眼看出不对"的,
 * 不能是 worried 这种温吞的;优势局面才给 excited/determined。
 */
const FACE: Record<string, FaceId> = {
  'critical-health': 'scared',
  'lethal-threat': 'scared',
  'fatigue': 'sad',
  'fatigue-effect': 'worried',
  'low-health': 'worried',
  'swarmed': 'worried',
  'empty-board': 'worried',
  'empty-hand': 'thinking',
  'deck-low': 'worried',
  // 一回合掉 8 血、场面被翻 —— 那是"被打懵了",不是单纯的担心
  'momentum': 'flustered',
  'reversal': 'flustered',
  // 优势:该收人头了
  'foe-low': 'determined',
  'board-lethal': 'excited',
  'near-lethal': 'determined',
  'mana-flooded': 'smug',
  'foe-hoarding': 'thinking',
  // 惊讶:不是担心,是「这牌你怎么弄来的」
  'surprise': 'surprised',
};

export function faceOf(alert: Alert): FaceId {
  return alert.face ?? FACE[alert.id] ?? 'neutral';
}

const combined = (s: SideState): number => s.health + s.armor;

/**
 * 「还剩多少」的统一说法。
 *
 * 坑(2026-10-28 实测):`foeHp` 是 `combined()` = 生命 + 护甲,可 `near-lethal`
 * 直接写成「对面 21 血」。那一局对手是 9 血 + 12 护甲 —— 她照念「他血量又回上来了,
 * 现在 21」,而对手一滴血都没回,只是刚叠了甲。
 *
 * 血量会掉也会回,护甲只增不减,这两件事在牌局里的意思完全不同(回血说明他在续航,
 * 叠甲说明他在拖),不能共用「血」一个字。
 */
const poolText = (s: SideState): string =>
  s.armor ? `${s.health} 血 + ${s.armor} 护甲` : `${s.health} 血`;

const boardText = (s: SideState): string => {
  if (!s.minions.length) return '空场';
  // 攻击力要给**两个口径**,因为它们是两个数、意思不同:
  //   · 身材和 —— 每只的 atk 直接相加,交换价值用它;
  //   · 能打出 —— 风怒按两刀、不能攻击的不算,「他这回合能打我多少」用它。
  //
  // 2026-11-03 第 20 回合同一个时刻报了两个数:回合事件写「5 个随从(攻 22 …)」,
  // 相邻的危险告警写「对手当前场攻合计 29」—— 差的那 7 点是一只风怒随从的第二刀。
  // 两个数各自都对,可摆在一起就是矛盾,她照着念,还顺手编出「里面还有 14 点吸血」。
  const raw = s.minions.reduce((sum, m) => sum + m.atk, 0);
  const real = s.minions.reduce((sum, m) => (m.cantAttack ? sum : sum + m.atk * (m.windfury ? 2 : 1)), 0);
  const atk = real === raw ? `攻 ${raw}` : `攻 ${raw}、风怒算两刀 ${real}`;
  const hp = s.minions.reduce((sum, m) => sum + m.health, 0);
  // 嘲讽要单独标出来:它不影响「对面打我多少」,但决定「我能不能打进去」。
  // 只报「2 个随从(攻 0 / 血 6 合计)」会让人以为这局没事,其实是两道墙。
  const taunts = s.minions.filter((m) => m.taunt).length;
  const tauntNote = taunts ? `,${taunts} 个嘲讽` : '';
  return `${s.minions.length} 个随从(${atk} / 血 ${hp} 合计${tauntNote})`;
};

/** 算出这一批里新出现的关键节点。返回的每条都还没报过。 */
export function detectAlerts(ctx: AlertContext): Alert[] {
  const { before, now } = ctx;
  const out: Alert[] = [];
  if (now.ended) return out;

  const me = now.me;
  const foe = now.opponent;
  const myHp = combined(me);
  const foeHp = combined(foe);

  // 残血:跨过阈值的那一刻报一次
  if (myHp <= ctx.alertHealth && (!before || combined(before.me) > ctx.alertHealth)) {
    out.push({ id: 'low-health', text: `我的生命值降到 ${poolText(me)},对手是 ${poolText(foe)}。` });
  }
  // 濒死:和残血分开,更硬的一条
  if (myHp <= 5 && (!before || combined(before.me) > 5)) {
    out.push({ id: 'critical-health', text: `我只剩 ${poolText(me)}了。对面场上${boardText(foe)}。` });
  }
  // 对面够得着斩杀
  if (now.boardAttack.theirs >= myHp && now.boardAttack.theirs > 0 && (!before || before.boardAttack.theirs < combined(before.me))) {
    out.push({ id: 'lethal-threat', text: `对手当前场攻合计 ${now.boardAttack.theirs},我的生命值加护甲是 ${myHp}——他下回合够得着斩杀。` });
  }
  // 自己被压场
  if (foe.minions.length >= ctx.swarmCount && (!before || before.opponent.minions.length < ctx.swarmCount)) {
    out.push({ id: 'swarmed', text: `对手铺到 ${foe.minions.length} 个随从,场攻 ${now.boardAttack.theirs};我这边${boardText(me)}。` });
  }
  // 我空场且手上没货
  if (me.minions.length === 0 && me.handCount <= 2 && (!before || before.me.handCount > 2 || before.me.minions.length > 0)) {
    out.push({ id: 'empty-board', text: `我场上空了,手牌 ${me.handCount} 张,牌库还剩 ${me.deckCount} 张。` });
  }
  // 手牌打空
  if (me.handCount === 0 && (!before || before.me.handCount > 0)) {
    out.push({ id: 'empty-hand', text: '我的手牌打空了。' });
  }
  // 牌库告急
  if (me.deckCount > 0 && me.deckCount <= 5 && (!before || before.me.deckCount > 5)) {
    out.push({ id: 'deck-low', text: `牌库只剩 ${me.deckCount} 张。` });
  }
  // 疲劳层数上涨有两种来源,**不能一律说成「牌库抽干了」**:
  //   1. 抽到空牌库 → 真的抽干了
  //   2. 卡片效果直接拿疲劳打人 → 实测 2026-10-24 13:25 那局,牧师挂上黑暗帝国之刃(0/3),
  //      每回合给敌方英雄一次疲劳伤害,我的层数从 1 一路涨到 8,可牌库还有二十多张。
  // 那时候说「牌库抽干了」是硬错 —— 他会以为牌库没了,实际上是对面在扣他。
  // 牌库到底空没空,看 deckCount,不看疲劳层数。
  if (me.fatigue > 0 && (!before || before.me.fatigue === 0)) {
    if (me.deckCount === 0) {
      out.push({ id: 'fatigue', text: `牌库抽干了,疲劳伤害到第 ${me.fatigue} 层。` });
    } else {
      out.push({
        id: 'fatigue-effect',
        text: `我的疲劳层数到第 ${me.fatigue} 层了,可牌库还有 ${me.deckCount} 张 —— 这不是抽干的,是对面有牌在拿疲劳伤我。`,
      });
    }
  }
  // 对面进入斩杀线
  if (foeHp > 0 && foeHp <= 10 && (!before || combined(before.opponent) > 10)) {
    out.push({ id: 'foe-low', text: `对手只剩 ${poolText(foe)}。我场攻 ${now.boardAttack.mine}。` });
  }
  // 场上够斩杀(只算这回合真能打出去的攻击,不含手牌;含手牌的完整判断在 lethalText 里)
  //
  // **只在轮到我的时候报。** 对手回合里「我场攻 17」是个还没兑现的数 —— 对面会先动手,
  // 把场上最贵的几只换掉,轮到我的时候可能只剩 6 点。那时候说「这一轮够斩杀了」是假的。
  //
  // ## 2026-10-24 修:不能用「场上随从攻击力合计」当「这回合能打出的伤害」
  //
  // `boardAttack.mine` 是把场上每只随从的攻击力加起来 —— 刚下场的随从(召唤失调)、
  // 这回合已经动过的随从,全都算在里面。于是它恰好在**他刚铺完场**的那一刻越过阈值,
  // 报出「我场攻 12,对手 12——这一轮够斩杀了」,而这一轮其实一点都打不出去。
  //
  // 用真实日志数过:6 份 Power.log 里 `board-lethal` 一共只触发 4 次,**4 次全是假的**
  // (两次全场召唤失调、两次大半已动过)。这不是边角,这是它唯一的触发场景。
  //
  // 改用 `planLethal().faceAtk`:它按「还能动的随从」算,并且先扣掉过嘲讽的代价。
  const plan = planLethal(now);
  if (now.isMyTurn && plan.faceAtk >= foeHp && plan.faceAtk > 0) {
    const wall = now.opponent.minions.some((m) => m.taunt) ? '(已经算过对面嘲讽墙,有多只随从合力过墙)' : '';
    out.push({ id: 'board-lethal', text: `这回合能打出的攻击 ${plan.faceAtk}${wall},对手生命加护甲 ${foeHp}——够斩杀。` });
  }
  // 水晶溢出
  if (me.manaMax >= 7 && me.mana >= me.manaMax - 1 && me.handCount >= 5 && (!before || before.me.handCount < 5)) {
    out.push({ id: 'mana-flooded', text: `我还有 ${me.mana} 个水晶没用,手牌 ${me.handCount} 张。` });
  }

  /* ---------- 局势转向:不是跨过某个阈值,而是「风向变了」 ---------- */

  // 一直在挨打:两回合内净掉 8 血以上,说明对面在稳定输出而不是偶尔碰一下
  if (before) {
    const beforeHp = combined(before.me);
    const drop = beforeHp - myHp;
    if (drop >= 8 && myHp > 0) {
      out.push({ id: 'momentum', text: `这一回合掉了 ${drop} 血(从 ${beforeHp} 到 ${myHp}),对面压得住了。` });
    }
  }

  // 场面翻转:之前我压着,现在被反压
  if (before) {
    const mineBefore = before.boardAttack.mine;
    const theirsBefore = before.boardAttack.theirs;
    const mineNow = now.boardAttack.mine;
    const theirsNow = now.boardAttack.theirs;
    if (mineBefore > theirsBefore + 3 && theirsNow > mineNow + 3) {
      out.push({ id: 'reversal', text: `场面翻了:刚才我场攻 ${mineBefore} 压着对面 ${theirsBefore},现在他 ${theirsNow}、我 ${mineNow}。` });
    }
  }

  // 逼近斩杀:这回合合计差 1–5 点。
  //
  // 同样只在轮到我的时候报。原来在对手回合也会推 —— 而「我场攻 17,只差 8 点」
  // 这句话在他动手之后可能变成「只差 19 点」。
  //
  // 数字用 `plan.total`(= 还能动的攻击 + 手上直伤 + buff,已经扣过嘲讽墙),
  // 和 briefAdvice 那条「能斩杀」用同一本账 —— 两条出口的数不能互相打脸。
  const gap = foeHp - plan.total;
  if (now.isMyTurn && foeHp > 0 && gap >= 1 && gap <= 5) {
    out.push({ id: 'near-lethal', text: `对面 ${poolText(foe)},这回合合计能打 ${plan.total} 点——还差 ${gap} 点。` });
  }

  // 对面在囤牌:手牌堆到 8 张以上,通常意味着手里有组合
  if (foe.handCount >= 8 && (!before || before.opponent.handCount < 8)) {
    out.push({ id: 'foe-hoarding', text: `对手手牌攒到 ${foe.handCount} 张了,可能在等一套连招。` });
  }

  return out;
}

/**
 * 对手打出一张**出乎意料**的牌。
 *
 * 判据只有三条,全部客观可算 —— 「意外」是情绪,但触发它的必须是事实,
 * 不是「我觉得这牌很强」:
 *
 *   1. **跨职业**:他的职业打不出这张牌,只可能是发现、偷、或者随机生成。
 *   2. **提前登场**:这张牌的费用高于他这回合的水晶上限 —— 靠减费或硬币硬凑出来的。
 *   3. **超大身材**:单只随从体格 ≥ 16(8/8 以上),属于「怎么突然冒出这么一只」。
 *
 * 三条都要求「他本来不该有这个东西」。纯高费、纯传说**不算** —— 对手后期打出
 * 10 费传说很正常,那不叫意外,叫按计划。惊一次是惊喜,惊五次是噪音。
 *
 * 这里只报事实和理由,不判断「该不该惊讶」—— 那是她的活。
 */
export function surpriseAlerts(
  actions: readonly ActionRecord[],
  before: GameSnapshot | null,
  now: GameSnapshot,
): Alert[] {
  const foe = now.opponent;
  const cands: { key: string; name: string; why: string[] }[] = [];
  const seen = new Set<string>();
  const add = (key: string, name: string, why: string[]) => {
    // 变形体(`xxx_t`)和本体是同一件事,只算一次 —— 否则一次变形会报两条
    const norm = key.replace(/t$/, '');
    if (seen.has(norm)) return;
    seen.add(norm);
    cands.push({ key: norm, name, why });
  };

  /* ---- 路径一:从动作里看「他打出的那张牌」 ---- */
  //
  // 覆盖有限:对手手牌在揭示之前日志里没有 cardId,PLAY block 那一刻通常拿不到。
  // 实测 255 次对手出牌只有 15 次带 cardId —— 所以必须再有一条路(见下),
  // 只靠这条的话「大身材」永远触发不了。
  for (const a of actions) {
    if (a.who !== 'opponent') continue;
    if (a.kind !== 'play' && a.kind !== 'weapon') continue;

    const reasons: string[] = [];
    const cls = cardClassZh(a.cardId ?? '');
    if (cls && cls !== '中立' && foe.heroClass && cls !== foe.heroClass) {
      reasons.push(`这是${cls}的牌,他玩的是${foe.heroClass},只可能是发现或者偷来的`);
    }
    if (typeof a.cost === 'number' && foe.manaMax > 0 && a.cost > foe.manaMax) {
      reasons.push(`一张 ${a.cost} 费的牌,可他这回合只有 ${foe.manaMax} 点水晶`);
    }
    const live = (a.atk ?? 0) + (a.health ?? 0);
    const print = live > 0 ? null : cardBody(a.cardId ?? '');
    const body = live > 0 ? live : print ? print.atk + print.health : 0;
    if (body >= 16) {
      reasons.push(live > 0 ? `一只 ${a.atk}/${a.health}` : `一只 ${print?.atk}/${print?.health} 的大怪`);
    }
    if (!reasons.length) continue;

    const leg = isLegendary(a.cardId ?? '') ? '(传说)' : '';
    add(a.cardId || a.text, `${a.text.replace(/^打出\s*/, '')}${leg}`, reasons);
  }

  /* ---- 路径二:从场上新增的随从里看 ---- */
  //
  // 随从落地之后信息是全的(身材、cardId、关键词都在),补上路径一拿不到的那部分。
  // 这里不区分「打出来的」和「召唤出来的」—— 对玩家来说都是「突然冒出这么一只」。
  const beforeIds = new Set((before?.opponent.minions ?? []).map((m) => m.id));
  for (const m of foe.minions) {
    if (beforeIds.has(m.id)) continue;
    const reasons: string[] = [];
    const cls = cardClassZh(m.cardId ?? '');
    if (cls && cls !== '中立' && foe.heroClass && cls !== foe.heroClass) {
      reasons.push(`这是${cls}的牌,他玩的是${foe.heroClass}`);
    }
    if (m.atk + m.health >= 16) reasons.push(`一只 ${m.atk}/${m.health}`);
    if (!reasons.length) continue;

    // 场上实体的 name 常常是空的(对手的牌没揭示名字),退回卡表 ——
    // 念一串 TTN_835 给她听,比不说还难看
    // 卡表也查不到(衍生物、新版本的 token)就别把内部 id 当名字给她。
    // 2026-10-28 实测:她收到的是「对手场上多了 CATA_190t14 —— 一只 12/12」,
    // 那句 id 对她零信息量,她只能含糊地说「他这就砸下来一个 12/12」。
    // 与其递一串认不出来的编号,不如直说没认出来 —— 她至少不会以为自己漏读了什么。
    const name = m.name || cardName(m.cardId ?? '') || (m.cardId ? '一只没认出来的随从' : `#${m.id}`);
    const leg = isLegendary(m.cardId ?? '') ? '(传说)' : '';
    add(m.cardId || name, `${name}${leg}`, reasons);
  }

  if (!cands.length) return [];

  // 一次事件冒出好几只时合并成一句。实测里面见过一次随机召唤直接添了 3 个跨职业随从,
  // 分三条推过去就是刷屏 —— 她该说一句「这几个都不是他的牌」,不是说三遍。
  //
  // **理由必须跟名字绑在一条上。** 原来是「名字全列一遍,理由全平铺」:
  //   对手场上一下多了 大领主弗塔根(传说)、年兽(传说) ——
  //   这是圣骑士的牌,他玩的是术士;这是恶魔猎手的牌,他玩的是术士;一只 6/12
  // 实测 2026-10-29 第 16 回合就是这句。两条「这是 X 的牌」长得一模一样却指两张不同的牌,
  // 末尾的「一只 6/12」谁也认不出来是年兽的 —— 读起来像场上有第三只。
  if (cands.length > 1) {
    const line = cands.slice(0, 4).map((c) => {
      // 「一只 6/12」单独摆在理由串末尾时没有主语,换成带归属的写法
      const why = c.why.map((w) => w.replace(/^一只 (\d+\/\d+)$/, '$1 的身材')).join(',');
      return `${c.name},${why}`;
    });
    const who = foe.heroClass ? `这几个都不是${foe.heroClass}的牌` : '这几个都不是他的牌';
    const cnt = cands.length;
    const cntText = cnt > 4 ? `${cnt} 张,先说前四张` : `${['两', '三', '四'][cnt - 2]}张`;
    return [{
      id: `surprise:batch:${cands.map((c) => c.key).join(',')}`,
      text: `对手场上一下多了 ${cntText} —— ${line.join(';')}。${who}。`,
      tone: 'calm',
      face: 'surprised',
    }];
  }

  const one = cands[0];
  return [{
    id: `surprise:${one.key}`,
    text: `对手场上多了 ${one.name} —— ${one.why.join(';')}。`,
    tone: 'calm',
    face: 'surprised',
  }];
}

/** 回合开始时那句事实。 */
export function turnText(now: GameSnapshot): string {
  const me = now.me;
  const foe = now.opponent;
  // 有硬币就把「还能多花几点」摆出来 —— 不然 5/5 会让人以为上限就是 5 费。
  // 但硬币本身也有费用:被「手牌费用 +1」照过之后,打硬币是花 1 换 1,
  // 一点水晶都换不到。这时候不能写「+1币」,那等于告诉她还能多花一点。
  const coinMana = me.coinMana ?? me.coinCount ?? 0;
  const coin = coinMana > 0
    ? `(+${coinMana}币)`
    : (me.coinCount ? `(硬币被加价了,打出去换不到水晶)` : '');
  return `第 ${now.turn} 回合,轮到我。我 ${combined(me)} 血、手牌 ${me.handCount} 张、${me.mana}/${me.manaMax} 水晶${coin};`
    + `对手 ${combined(foe)} 血,${boardText(foe)}。`;
}

/** 开局时那句事实:双方职业、先后手。 */
export function startText(now: GameSnapshot): string {
  const me = now.me;
  const foe = now.opponent;
  // 先手看 `firstPlayerId`,不看 `activePlayerId` —— 后者是「现在轮到谁」,
  // 开局那一刻两个概念还差一步(实测后手开局被说成「我先手」)。
  const firstId = now.firstPlayerId || now.activePlayerId;
  const first = firstId === me.playerId ? '我先手' : '对手先手';
  return `对局开始:我是 ${me.heroClass || '未知职业'},对手是 ${foe.heroClass || '未知职业'},${first}。`;
}

/** 结束时那句事实。 */
export function endText(now: GameSnapshot): string {
  const me = now.me;
  const foe = now.opponent;
  const label = now.result === 'won' ? '赢了' : now.result === 'lost' ? '输了' : now.result === 'tied' ? '平局' : '结束';
  // 赢了、对手却不是 0 血 —— 那是他认输/退了,不是被封脸打死。
  // 不说明白的话,这句话读起来像自相矛盾:赢了,对手还有 17 血?
  // (2026-10-28 实测:末回合对手 9 血 8 甲,日志里 PLAYSTATE=LOST,血量全程没归零。)
  const foeWalked = now.result === 'won' && combined(foe) > 0;
  const meWalked = now.result === 'lost' && combined(me) > 0;
  const note = foeWalked ? '(他没打完就退了)' : meWalked ? '(我认输了)' : '';
  return `这局${label}:第 ${now.turn} 回合,我 ${combined(me)} 血 / 对手 ${combined(foe)} 血${note}。`;
}

/**
 * 结束时的**标记**,写法就是 `pet_say` 的行内标记本身(`<表情, 动作>`)。
 *
 * 为什么这一处不像别处那样只给表情 id:赢了光换脸不够 —— 他要的是她**跳起来**。
 * 桌宠的词表里 `jump` 是原地起跳、`hop` 是小蹦、`flap` 是开心地蹦着扑腾。
 * 给成完整标记,她照抄进 `pet_say` 就会跳;拆成「表情 id」+「动作 id」两截,
 * 她还得自己拼一次语法,而拼错是被静默丢弃的 —— 她不会知道跳失败了。
 *
 * 两个坑写在测试里(celebrate.test.mjs),这里记一句:
 *   - `<…>` 是行内标记,挂的是 anchor,不是 `【…】` 那种整块 beat;
 *   - **标记后面必须跟着台词**。页面在空台词的 beat 上直接跳过,不执行 anchor ——
 *     光给一个 `<happy, jump>` 她不会动,所以这句标记永远是句子的开头,不是全部。
 *
 * 输了别跳、别笑:`sad` 一个就够。硬挤的庆祝比没反应更难看。
 */
export function endMarker(result: GameSnapshot['result']): string {
  if (result === 'won') return '<happy, jump>';
  if (result === 'lost') return '<sad>';
  return '<neutral>';
}

/** 回合点写成一句话,给 turn 事件用。 */
export function turnPointText(p: TurnPoint): string {
  const my = `${p.myHp}${p.myArmor ? `+${p.myArmor}` : ''} 血`;
  const foe = `${p.foeHp}${p.foeArmor ? `+${p.foeArmor}` : ''} 血`;
  return `第 ${p.turn} 回合,轮到我。我 ${my}、手牌 ${p.myHand} 张、场面${p.myBoard};对手 ${foe}、手牌 ${p.foeHand} 张、场面${p.foeBoard}。`;
}

/**
 * 斩杀线:把 planLethal 算出来的账说成人话。
 *
 * 要交代三件事,缺一件这个数就会骗人:
 *   1. 过墙吃掉了多少攻击力(有嘲讽时)
 *   2. 手牌那部分是怎么凑出来的
 *   3. 哪些东西没算进去(冲锋、条件不满足的战吼、法术伤害加成、无视嘲讽)
 */
export function lethalText(now: GameSnapshot): string {
  const plan = planLethal(now);
  const target = combined(now.opponent);
  const taunts = now.opponent.minions.filter((m) => m.taunt);

  const parts: string[] = [];
  if (taunts.length) {
    parts.push(`能打出的攻击 ${plan.swingsTotal} → 过墙后剩 ${plan.faceAtk}`);
  } else {
    parts.push(`场面 ${plan.faceAtk}`);
  }
  if (plan.spellDamage > 0) {
    parts.push(`手牌直伤 ${plan.spellDamage}(${plan.spells.map((x) => `${x.name} ${x.cost}费${x.damage}伤`).join(' + ')})`);
  }
  if (plan.buffDamage > 0) {
    parts.push(`buff ${plan.buffDamage}(${plan.buffs.map((x) => `${x.name} ${x.cost}费+${x.atk}攻`).join(' + ')})`);
  }
  // 战吼也要报(2026-11-19)。它是 total 的一部分,不写出来就成了「账面加起来对不上总数」
  if (plan.battlecryDamage > 0) {
    parts.push(`战吼 ${plan.battlecryDamage}(${plan.battlecries.map((x) => `${x.name} ${x.cost}费${x.damage}伤`).join(' + ')})`);
  }

  const head = `斩杀线:${parts.join(' + ')} = ${plan.total},对手 ${target} 血(含护甲)`;

  const lines: string[] = [];
  if (plan.total >= target && plan.total > 0) {
    lines.push(`${head} → 够斩杀${plan.total - target > 0 ? `,富余 ${plan.total - target}` : ',刚好'}。`);
  } else if (plan.total <= 0) {
    lines.push(`斩杀线:这回合打不到脸。对手 ${target} 血(含护甲)。`);
    if (taunts.length) {
      // 「墙解得开但攻击力用完」和「墙根本解不开」是两件事,别混成一句
      lines.push(plan.wall.cleared
        ? `对面 ${taunts.length} 个嘲讽解得开,但攻击力全用在过墙上了。`
        : `对面 ${taunts.length} 个嘲讽,现有攻击力解不开。`);
    }
  } else {
    lines.push(`${head},还差 ${target - plan.total}。`);
  }

  if (plan.wall.steps.length) lines.push(`过墙:${plan.wall.steps.join(';')}。`);

  // 这套数字是**这回合**的。要问「下回合能不能收」,得先把对面会先动手这件事算进去。
  //
  // 实测 2026-10-24 第 19 回合:我 19 血、场攻 17(六只),对面 25 血;她按 17 去估下回合
  // 的斩杀,可对面两个随从能动手,最坏情况下把我最贵的 6/8 和 5/5 换掉,只剩 6 点。
  // 「我场攻 17」和「下回合我场攻 6」是两句话,只报前一句就是在骗人。
  const worse = worstCaseFaceAttack(now.me, now.opponent);
  const myBoard = now.me.minions.reduce((n, m) => n + Math.max(0, m.atk), 0);
  if (myBoard > 0 && worse < myBoard) {
    const attackers = now.opponent.minions.filter((m) => m.atk > 0 && !m.frozen).length;
    lines.push(
      `注意:上面这些是这回合的账。他 ${attackers} 个随从能动手,每个只能咬一个 —— `
      + `最坏情况下换成你场上最贵的 ${attackers} 只,下回合场攻只剩 ${worse}(现在 ${myBoard})。`
      + '要按最坏情况算斩杀,别按现在的场面算。',
    );
  }

  if (plan.total > 0) {
    const notes: string[] = [];
    if (taunts.length) notes.push('过墙只按现有攻击力算,没考虑先用法术解墙');
    if (plan.buffDamage > 0) notes.push('buff 假设加在能攻击的随从身上');
    // 战吼已经从「没算」里摘出去(2026-11-19):确定打得出的那些进了 total,
    // 只剩「前提不满足/判不了」的那部分没算 —— 这一句不能再笼统地把战吼整个划掉。
    notes.push('冲锋、随从亡语、法术伤害加成、无视嘲讽都没算;战吼只算了前提确定满足的');
    lines.push(`注意:${notes.join(';')}。`);
  }

  return lines.join('\n');
}
