/**
 * 从 HearthstoneJSON 生成「手牌卡名表」。
 *
 * 为什么需要:炉石日志里手牌只给 cardId(`CS2_029`),不给名字。要让扩展说出
 * 「你手上有一张火球术」而不是「你手上有一张 CS2_029」,就得有一张对照表。
 *
 * 收 collectible,加上会站在场上的衍生 token —— 但不收附魔、战棋、佣兵、乱斗。
 * 2026-11-06 之前只收 collectible,于是 `TIME_009t2` 这种强化版 token 读不出来,
 * 她只能说「这张我认不出来」。取舍见 `usableCard` 的注释。
 *
 * 每条紧凑成 [名称, 费用, 类型, 备注]:
 *   ["火球术", 4, "S", "伤害6"]
 *   ["森金持盾卫士", 4, "M", "3/5 嘲讽"]
 *
 * 备注里的效果是按**文本关键词**提炼的,不是完整的牌面文字 —— 完整文字能让表涨到几 MB,
 * 而模型本来就认得大部分卡;给个摘要够它判断「这是一张解场还是一张爆发」。
 *
 *   node tools/build-card-table.mjs <cards.json> src/data/cards.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('用法: node tools/build-card-table.mjs <cards.json> <out.json>');
  process.exit(1);
}

const cards = JSON.parse(readFileSync(src, 'utf8'));

const TYPE_LETTER = {
  SPELL: 'S',
  MINION: 'M',
  WEAPON: 'W',
  HERO: 'H',
  LOCATION: 'L',
};

/** 机制 → 中文短标签。只留对战判断用得上的。 */
const MECH = [
  ['TAUNT', '嘲讽'],
  ['DIVINE_SHIELD', '圣盾'],
  ['CHARGE', '冲锋'],
  ['RUSH', '突袭'],
  ['WINDFURY', '风怒'],
  ['LIFESTEAL', '吸血'],
  ['POISONOUS', '剧毒'],
  ['DEATHRATTLE', '亡语'],
  ['BATTLECRY', '战吼'],
  ['COMBO', '连击'],
  ['SECRET', '奥秘'],
  ['DISCOVER', '发现'],
  ['FREEZE', '冻结'],
  ['IMMUNE', '免疫'],
  ['STEALTH', '潜行'],
  // 下面三个以前漏了,都直接影响「怎么打」:
  // 复生 = 打死了还会站起来(实测「不稳定的原型机」就因为漏了它,摘要只剩「亡语 +1/+1」);
  // 闪避 = 法术指定不了它,想解得靠随从撞;
  // 过载 = 下回合水晶要还债。
  ['REBORN', '复生'],
  ['ELUSIVE', '闪避'],
  ['OVERLOAD', '过载'],
  // 锻造 = 花 2 点水晶把它换成强化版。词条在卡面上,日志里只能看到"已经锻造完了"
  // (cardId 变成 `xxx_t`),看不到"这是一张锻造牌" —— 所以这一项只能从卡面来。
  ['FORGE', '锻造'],

  // ---- 下面这批是 2026-10-24 补的。共同点:都会改变「这回合该怎么打」,
  // 但日志里读不到(手牌实体很少被完整 dump),所以只能从卡面词条进摘要。
  // 排在前面的优先占用摘要长度。
  ['TRADEABLE', '可交易'],        // 花 1 费换一张 —— 废牌能换掉,剩水有去处
  ['INFUSE', '注入'],             // 友方随从每死一个就升级,打出去的身材不是牌面那个
  ['MANATHIRST', '法力渴求'],     // 水晶到某个数才触发额外效果 —— 影响"该不该等"
  ['QUICKDRAW', '快枪'],          // 本回合抽到就打才有额外效果 —— 影响"该不该留"
  ['MINIATURIZE', '迷你'],        // 打出时给一张 1/1 复制,等于多一张牌
  ['ECHO', '回响'],               // 本回合可以反复打,费用要按倍数算
  ['MAGNETIC', '磁力'],           // 能贴到机械上,等于半个 buff
  ['TITAN', '泰坦'],              // 三个技能之一,每回合替一次攻击
  ['COLOSSAL', '巨型'],           // 打出时附带身体部件,实际场面比牌面大
  ['EXCAVATE', '发掘'],           // 拿宝藏,价值高于牌面
  ['DREDGE', '探底'],             // 挑牌库底三张置顶 —— 影响下回合抽什么
  ['HONORABLE_KILL', '荣誉击杀'],  // 正正好打死才触发 —— 影响换不换
  ['FRENZY', '暴怒'],             // 第一次挨打触发,不是说不能碰它
  ['OVERHEAL', '过量治疗'],        // 治疗溢出的部分才算,奶量牌的价值重估
  ['OUTCAST', '流放'],            // 手牌最左最右打出才有额外效果
  ['SPELLBURST', '法术爆发'],      // 放过法术后触发
  ['CORRUPT', '腐蚀'],            // 用过更高费的牌后升级
  ['TWINSPELL', '双生法术'],       // 打一次给一张复制
  ['IMBUE', '灌注'],              // 强化英雄技能
  ['DARK_GIFT', '黑暗之赐'],      // 附带黑暗之赐强化
];

const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim();

/**
 * 摘要补丁:关键词提取拼不出来的语义,只能手写。
 *
 * 重建牌表时这些会覆盖自动摘要 —— **别删**,删了下一次重跑就又丢了。
 * 每一条都要写清「自动摘要少了什么」,不然以后没人知道这行为什么存在。
 */
const NOTE_PATCH = {
  // 自动摘要只剩「6/8 嘲讽 摧毁」。抉择的两个代价(弃两张牌 / 摧毁你的一个法力水晶)
  // 全丢了,建议照着摘要念,他打出去才发现必须二选一。2026-10-24 实测。
  DEEP_027: '6/8 嘲讽 抉择:弃2张牌 或 毁1个法力水晶(锻造后免)',
  // 自动摘要只出「4/0 战吼」:耐久读成 0(数据里没有 durability 字段),而「无法攻击英雄」
  // 这条最关键的没提。她于是把这 4 点算进对面打脸场攻 —— 实际只能砍随从。
  // 2026-10-24 第 6 回合实测。注:摘要以身材开头是这份表的约定,写清楚别漏。
  END_012: '4/2 无法攻击英雄 战吼:本回合攻击力变无穷大',
};

/** 按伤害目标分类群伤/自伤后缀，避免把「打所有角色」和「只打敌人」混成同一标签。 */
function formatDamageTag(text, max) {
  const random = /随机/.test(text) ? '随机' : '';
  if (/对(?:每个|双方)英雄造成\s*[#$@]?\s*\d+\s*点伤害/.test(text) && !/对(?:所有|每个)[^\s，。]*随从/.test(text)) {
    return `伤害${max}双方英雄`;
  }
  if (/对(?:你所有的|所有(?:其他)?友方)随从造成|随机分配到所有(?:其他)?友方随从/.test(text)) {
    return `伤害${max}友方`;
  }
  if (/(?:对|到)所有(?:未受伤的)?敌方随从|(?:对|到)每个敌方随从|随机分配到所有敌方随从|相邻的?随从/.test(text)) {
    return `伤害${max}群${random}随从`;
  }
  if (/(?:对|到)所有(?:其他|未受伤的|已被冻结的)?敌人|(?:对|到)每个敌人|(?:对|到)所有敌方\s*角色|随机分配到所有(?:敌方)?(?:敌人|敌方\s*角色)/.test(text)) {
    const minionHint = /随从/.test(text) && !/英雄|敌方\s*角色/.test(text) ? '随从' : '';
    return `伤害${max}群${random}${minionHint}`;
  }
  if (/(?:对|到)(?:除了?[^，。]*?(?:外|之外)的)?所有(?:其他|除[^，。]*外的)?角色|(?:对|到)每个角色|其他所有角色|随机分配到所有(?:其他)?角色/.test(text)) {
    return `伤害${max}群${random}己`;
  }
  if (/(?:对|到)(?:除了?[^，。]*?(?:外|之外)的)?所有(?:其他|非[^\s，。]*|具有亡语的|其他受伤的|相同类型的其他)?随从|(?:对|到)每个随从|其他所有随从|随机分配到所有(?:其他|非[^\s，。]*)?随从/.test(text)) {
    return `伤害${max}群${random}随从己`;
  }
  const minionOnly = /对(?:一个|该|目标)?敌方随从|对一个随从/.test(text) && !/英雄/.test(text);
  return `伤害${max}${random}${minionOnly ? '随从' : ''}`;
}

/** 从牌面文字里提炼「这张牌干什么」的摘要。 */
function effectNote(text, mechanics, type) {
  const bits = [];

  // 伤害:只报最大的那个数,并区分单体/敌方群体/敌我全打
  // 数字前可能是 `$`(随法伤变化)或 `#`(随某个属性变化) —— 只兼容 `$` 会漏掉一整类牌,
  // 真言术：耀 写的就是「恢复 #4点生命值」。
  const damages = [...text.matchAll(/造成\s*[#$@]?\s*(\d+)\s*点伤害/g)].map((m) => Number(m[1]));
  if (damages.length) {
    bits.push(formatDamageTag(text, Math.max(...damages)));
  }

  // 抽牌
  const draw = /抽\s*(\d+)?\s*张牌/.exec(text);
  if (draw) bits.push(`抽${draw[1] ?? 1}`);
  else if (/抽一张牌/.test(text)) bits.push('抽1');

  // 恢复生命。同样要兼容 #/$ 前缀 —— 真言术：耀 写的是「恢复 #4点生命值」,
  // 旧正则漏了它,那 4 点回血在她的判断里等于不存在。
  const heal = /恢复\s*[#$@]?\s*(\d+)\s*点生命/.exec(text) ?? /为你的英雄恢复\s*[#$@]?\s*(\d+)/.exec(text);
  if (heal) bits.push(`奶${heal[1]}`);

  // 加攻/加身材/加生命
  const pair = /获得\s*\+(\d+)\s*\/\s*\+?(\d+)/.exec(text);
  if (pair) bits.push(`+${pair[1]}/+${pair[2]}`);
  else {
    const atk = /获得\s*\+(\d+)\s*攻击力/.exec(text);
    if (atk) bits.push(`+${atk[1]}攻`);
    // 只加生命值也要记:竞技场里「+2 生命 + 抽牌」这种牌,漏掉前半截会严重低估
    const hp = /获得\s*\+(\d+)\s*生命值/.exec(text);
    if (hp) bits.push(`+${hp[1]}血`);
  }

  // 护甲
  const armor = /获得\s*(\d+)\s*点护甲/.exec(text);
  if (armor) bits.push(`甲${armor[1]}`);

  // 破坏类
  if (/消灭/.test(text)) bits.push('消灭');
  if (/沉默/.test(text)) bits.push('沉默');
  if (/冻结/.test(text)) bits.push('冻结');
  if (/召唤/.test(text)) bits.push('召唤');
  if (/复制/.test(text)) bits.push('复制');
  // 给随从贴圣盾。「使一个随从获得圣盾」这类 **buff** 效果以前整条丢 ——
  // 魔菇采掘(DEEP_018)的摘要只剩「发掘」两个字,她于是把它当普通发掘牌
  // 推荐了 3 费的消融元素,漏掉「2 费贴个盾给场上 3/3 突袭」这手。
  // 实测 2026-10-24 第 6 回合,他说「3 费的时候明明贴圣盾更好」。
  if (/获得圣盾/.test(text)) bits.push('圣盾');
  if (/攻击力等同于/.test(text)) bits.push('攻=血');

  // 「打不出来」这类**否定**机制必须留着 —— 它不是这张牌能干什么,是它干不了什么。
  // 漏了它,摘要看着还挺丰满(「4/0 战吼」),可最关键的那句没了:
  // 无穷之手「无法攻击英雄」被当成 4 点打脸威胁,实测 2026-10-24 第 6 回合。
  // 排在最前面,因为它改的是这张牌怎么用,不是它顺带还能干什么。
  if (/无法攻击英雄/.test(text)) bits.unshift('无法攻击英雄');
  else if (/无法攻击/.test(text)) bits.unshift('无法攻击');

  // 下面这一批以前一条都没提。「变形术：野猪」「策反」「剽窃」「迷乱」这类牌
  // 摘要空着,她只看得见名字 —— 用户实测问「怎么没读到牌的效果」,源头就在这。
  if (/变形/.test(text)) bits.push('变形');
  const gain = /获取\s*(\d+)?\s*张/.exec(text);
  if (gain) bits.push(`获取${gain[1] ?? 1}`);
  if (/摧毁/.test(text)) bits.push('摧毁');
  if (/互换|交换/.test(text)) bits.push('交换');
  if (/弃掉?\s*你的?手牌/.test(text)) bits.push('弃手牌');
  // 只认「装备一把/一个/装备N」这种真的装备动作。
  // 光看「装备」二字会把条件句算进来:「如果你装备着武器」不是装备效果,是前提,
  // 那样摘要里会多一个毫无意义的「装备」。
  if (/装备(?:一把|一个|\d)/.test(text)) bits.push('装备');
  if (/(?<!已)灌注(?:并触发)?你的英雄技能/.test(text)) bits.push('灌注');
  if (/黑暗之赐/.test(text) && !/战吼需.*黑暗之赐|手牌中有具有黑暗之赐/.test(text)) bits.push('黑暗之赐');

  // 预备不在 mechanics 里 —— 官方数据只把「预备」写在牌面文本开头,没有对应机制标签。
  // 所以只能按文本认:「使其获得预备」(通缉海报)是给别人加,不是自己带,排除掉。
  const prepare = /预备/.test(text) && !/获得预备/.test(text);
  const mechBits = [
    ...(prepare ? ['预备'] : []),
    ...MECH.filter(([key]) => (mechanics ?? []).includes(key)).map(([, zh]) => zh),
  ];
  // 嘲讽/圣盾这类已经在机制里了,文字摘要里别重复
  const extra = bits.filter((b) => !mechBits.some((m) => b.includes(m)));
  // 机制词条全留:它们是「这张牌能不能/该不该现在打」的判据,挤掉就等于没说。
  // 效果位补到 6 —— 以前硬切 5 个,机制一多就把「伤害3」这种关键数字切没了。
  const limit = Math.max(6, mechBits.length);
  const tagged = [...mechBits, ...extra].slice(0, limit);

  // 兜底:一个模式都没命中时,把原文压一压塞进去。
  //
  // 但**只给法术**。随从摘要的头是身材(`3/3`),那已经足够判断能不能换;硬拼一段
  // 原文会变成「3/3 在你的回合结束时 如果本随从未攻击 &抽两张牌」这种噪音,
  // 而它占的是「这回合打什么」里最贵的那点空间。
  //
  // 不加这层,2347 张可收集法术里 1395 张摘要是空的 —— 她看得见名字、看不见这张牌
  // 干什么(变形术、策反、剽窃、迷乱、星界沟通全是这种)。
  if (!tagged.length && type === 'SPELL') {
    const plain = text
      .replace(/[。，、；：「」（）()！？【】]/g, ' ')
      .replace(/[#$@&]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) return plain.slice(0, 28);
  }

  return tagged.join(' ');
}

/**
 * 结构化效果标签 —— 只收**能算出数字**的那些。
 *
 * 格式是短字符串,空格分隔:
 *   b3  战吼造成 3 点伤害(能解场,能打脸的前提是"任意目标"——这里不细分,只报有伤害)
 *   d2  亡语造成 2 点伤害(我打死它,它还会咬我一口)
 *   s1  法术伤害 +1(我方所有直伤数字要加)
 *   t   我方攻击无视嘲讽(过墙时墙不算)
 *
 * 为什么不做成对象:8328 条里绝大多数是空的,对象会把表撑大一倍多。
 *
 * 光环(AURA)故意不标:日志里的 ATK/HEALTH 是**已经加成后的实际值**,
 * 再叠一层只会重复计算。这一点曾经理解错,记在这里。
 */
/**
 * 战吼的前提条件。
 *
 * 实测踩过:雾帆劫掠者(2/2 海盗,「战吼:如果你装备着武器,造成2点伤害」)被记成
 * 无条件的 `b2`,于是建议告诉他「手上这张战吼能打 2 点,打出去就补刀」——
 * 可他手上没武器,打出去一点伤害都没有,白扔一张牌。
 *
 * 249 张「战吼 + 造成伤害」里 70 张(28%)带前提。判断条件真假不在构建期做
 * (那时没有对局状态),这里只负责**把前提写出来**,让运行时能判断或至少能提示。
 */
const COND_RULES = [
  [/装备着武器|装备了武器/, '装备武器'],
  [/手牌中有龙牌|手牌中有龙/, '手牌有龙'],
  [/控制着?其他?鱼人/, '控鱼人'],
  [/控制着?其他?机械|控制任何机械/, '控机械'],
  [/控制着?一个?奥秘|控制一个奥秘/, '控奥秘'],
  [/已灌注过你的英雄技能\s*4\s*次|已灌注过你的英雄技能四次/, '已灌注4次'],
  [/已灌注过你的英雄技能\s*2\s*次|已灌注过你的英雄技能两次/, '已灌注2次'],
  [/已灌注过你的英雄技能/, '已灌注过'],
  [/手牌中有具有黑暗之赐/, '手牌有黑暗之赐'],
  [/控制着?任何?亡灵|友方亡灵/, '控亡灵'],
  // 「控制任何 X」是常见句式,单独列会列不完 —— 统一压成「控X」
  [/控制(?:着)?任何([\u4e00-\u9fa5]{2,4})(?:随从|海盗|野兽)?/, (m) => `控${m[1]}`],
  [/拥有至少四个其他随从/, '有4个其他随从'],
  [/对手拥有\s*\d+\s*个或者更多随从/, '对手随从够多'],
  [/上个回合使用过元素牌/, '上回合用过元素'],
  [/有随从死亡|该随从死亡/, '有随从死亡'],
  [/本回合进入你的手牌/, '本回合抽到'],
  [/累计造成/, '本局累计伤害达标'],
  [/是友方角色/, '目标友方'],
];

/** 战吼那一段的前提条件(没有就返回 null)。 */
function battlecryCondition(text, mechanics) {
  if (!(mechanics ?? []).includes('BATTLECRY')) return null;
  const seg = text.split('战吼')[1] ?? '';
  if (!/如果|若|除非/.test(seg)) return null;
  for (const [re, label] of COND_RULES) {
    const m = re.exec(seg);
    if (!m) continue;
    return typeof label === 'function' ? label(m) : label;
  }
  // 没归类的条件:把「如果」后面那段压短了报出来,别丢掉
  const m = /如果([^，,。]{2,14})/.exec(seg);
  return m ? m[1].replace(/\s+/g, '').slice(0, 10) : '有前提';
}

function effectTags(card, text, mechanics) {
  const tags = [];

  const mech = mechanics ?? [];

  // 法术伤害:机制或文本都行
  const sp = /法术伤害\s*\+\s*(\d+)/.exec(text);
  if (mech.includes('SPELLPOWER') || sp) tags.push(`s${sp ? Number(sp[1]) : 1}`);

  // 战吼伤害:只看「战吼:」之后那一段,免得把光环伤害算进来
  if (mech.includes('BATTLECRY')) {
    const seg = text.split('战吼')[1] ?? '';
    const m = /造成\s*[#$@]?\s*(\d+)\s*点伤害/.exec(seg);
    // 带前提的加问号:`b2?` 表示「最多 2 点,但要满足条件」。运行时不能当确定伤害用。
    if (m) tags.push(`b${Number(m[1])}${battlecryCondition(text, mech) ? '?' : ''}`);
  }

  // 亡语伤害:同理,只看「亡语:」之后
  if (mech.includes('DEATHRATTLE')) {
    const seg = text.split('亡语')[1] ?? '';
    const m = /造成\s*\$?\s*(\d+)\s*点伤害/.exec(seg);
    if (m) tags.push(`d${Number(m[1])}`);
  }

  // 无视嘲讽
  if (/无视[^。]{0,6}嘲讽/.test(text)) tags.push('t');

  // 可锻造。只看卡面词条(mechanics),不猜文本 ——
  // 「战吼需你锻造过卡牌」(如永恒之火伊格尼斯)不是锻造牌,不能混进来。
  if (mech.includes('FORGE')) tags.push('f');

  // 可预备。机制表里没有 PREPARE(官方只写在文本开头),只能按文本认;
  // 同样排除「使其获得预备」那种授予型。
  if (/预备/.test(text) && !/获得预备/.test(text)) tags.push('p');

  // 可交易。这一条要机器可判 —— 她得知道「剩水可以花 1 费把他手里那张废牌换掉」。
  // 其余词条只进摘要就够了,不进标签。
  if (mech.includes('TRADEABLE')) tags.push('x');

  return tags.join(' ');
}

/**
 * 职业中文名。和 parser 的 `CLASS_ZH` 必须一致 —— 那边是日志里的 class 标签转中文,
 * 这边是卡牌数据转中文,两边对齐了才能比。
 */
const CLASS_ZH = {
  DRUID: '德鲁伊', HUNTER: '猎人', MAGE: '法师', PALADIN: '圣骑士', PRIEST: '牧师',
  ROGUE: '潜行者', SHAMAN: '萨满', WARLOCK: '术士', WARRIOR: '战士',
  DEMONHUNTER: '恶魔猎手', DEATHKNIGHT: '死亡骑士', NEUTRAL: '中立',
};

/**
 * 组一条卡表记录。
 *
 * 前五位是摘要用的(名/费/类型/摘要/效果标签)。第 6、7 位是给「对手打出意外牌」
 * 那个判断用的:
 *   · 第 6 位 = 职业中文 —— 对手打出**别的职业**的牌,只可能是发现/偷来的,
 *     这是最硬的「出乎意料」信号,而且客观,不需要猜。
 *   · 第 7 位 = 传说标记 `L`(只对传说牌写,省体积)。
 */
function row(parts, card) {
  const cls = CLASS_ZH[card.cardClass] ?? '';
  const out = [...parts, cls];
  if (card.rarity === 'LEGENDARY') out.push('L');
  return out;
}

/** 回落原文时的截断长度。够读完一句效果,又不至于把摘要撑成一段话。 */
const NOTE_MAX = 46;

/**
 * 这张牌要不要收。
 *
 * 原来只收 `collectible` —— 于是**衍生的 token 全进不了表**。2026-11-06 实测：
 * 她看到 `TIME_009t2` 只能说「这张的具体效果我认不出来，牌面上写什么你比我清楚」，
 * 而它就是「梅卡托克的光环」的强化版 —— 会真的站在场上，那正是最需要认出来的时候。
 *
 * 现在收 collectible **加上**随从/法术/武器/地标这四类 token，
 * 只排掉跟标准对局无关的：酒馆战棋、佣兵、乱斗、英雄皮肤、经典怀旧。
 *
 * 为什么不干脆全收：36390 张里 6740 张是 ENCHANTMENT（buff 附魔，永远不会站在场上），
 * 还有 4438 张佣兵技能、5787 张战棋牌 —— 收了只是让包变大，一条也用不上。
 */
const DEAD_SET = new Set([
  'LETTUCE', 'BATTLEGROUNDS', 'BATTLEGROUNDS_EVENT', 'TB',
  'HERO_SKINS', 'VANILLA', 'VANILLA_RELIC',
]);

const PLAYABLE_TYPES = new Set(['MINION', 'SPELL', 'WEAPON', 'LOCATION']);

function usableCard(c) {
  if (DEAD_SET.has(c.set)) return false;
  if (c.collectible) return true;
  return PLAYABLE_TYPES.has(c.type);
}

const table = {};
let minions = 0;
let spells = 0;

for (const c of cards) {
  if (!usableCard(c)) continue;
  const letter = TYPE_LETTER[c.type];
  if (!letter) continue;   // 英雄牌不进手牌逻辑,跳过
  if (!c.id || !c.name) continue;

  const cost = Number.isFinite(c.cost) ? c.cost : 0;
  const text = stripTags(c.text);
  // 条件战吼:前提必须写进摘要。只标 `b2?` 她看不懂问号是什么意思,
  // 写成「战吼需装备武器」她才知道没武器时这张牌是张 2/2 白板。
  const bcCond = battlecryCondition(text, c.mechanics);
  let note = [effectNote(text, c.mechanics, c.type), bcCond ? `战吼需${bcCond}` : '']
    .filter(Boolean).join(' ');

  if (NOTE_PATCH[c.id]) {
    // 关键词拼不出「弃两张牌还是毁一个水晶」这种二选一 —— 手写的覆盖自动摘要。
    // 随从的身材保留在补丁里(补丁是按完整摘要写的)。
    note = NOTE_PATCH[c.id];
  }

  // 提不出效果 ≠ 这张牌没效果。回落原文,截断。
  //
  // 实测:251 张武器里 79 张的摘要只有一个身材,牧师的黑暗帝国之刃就是其中一张 ——
  // 「0/3」,可它的效果是每回合给敌方英雄一次疲劳伤害。她拿着「0/3」,
  // 只能看着自己血一直掉而说不出原因。这一类(提不出来的效果)同样见于 536 张随从,
  // 比如艾维娜「你的随从牌的法力值消耗为(1)点」—— 不写进去,她的账就是错的。
  if (!note && text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    note = flat.length > NOTE_MAX ? `${flat.slice(0, NOTE_MAX)}…` : flat;
  }

  const fx = effectTags(c, text, c.mechanics);

  if (c.type === 'MINION') {
    // 随从用身材打头,后面接关键词 —— 判断能不能换牌时最需要的就是这两个数
    const stats = `${c.attack ?? 0}/${c.health ?? 0}`;
    // NOTE_PATCH 的正文已经含身材时不要重复拼
    const body = NOTE_PATCH[c.id] ? note : [stats, note].filter(Boolean).join(' ');
    table[c.id] = row([c.name, cost, letter, body, fx], c);
    minions += 1;
  } else if (c.type === 'WEAPON') {
    table[c.id] = row([c.name, cost, letter, `${c.attack ?? 0}/${c.durability ?? 0}${note ? ` ${note}` : ''}`, fx], c);
  } else {
    table[c.id] = row([c.name, cost, letter, note, fx], c);
    spells += 1;
  }
}

const payload = {
  source: 'HearthstoneJSON zhCN',
  note: '可收集牌的名称/费用/类型/摘要/结构化效果标签(b战吼伤害 d亡语伤害 s法术伤害 t无视嘲讽 f可锻造 p可预备 x可交易)；第6位职业、第7位 L=传说。',
  cards: table,
};

const json = JSON.stringify(payload);
writeFileSync(out, json, 'utf8');
const kb = (json.length / 1024).toFixed(0);
console.log(`收录 ${Object.keys(table).length} 张(随从 ${minions} / 法术等 ${spells})| ${kb} KB → ${out}`);
