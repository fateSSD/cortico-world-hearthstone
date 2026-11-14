/**
 * 配置段与设置页的声明。
 * cfg 是 `worlds.hearthstone` 的活引用:热改的键下一次轮询即生效,不需要重启。
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';
import { defaultInstallDirs } from './platform.ts';

export const HEARTHSTONE_ID = 'hearthstone';

/**
 * 找不到日志时的默认安装位置。玩家装在别处时由 `logPath` 覆盖。
 *
 * 平台差异全在 `platform.ts`：Windows 是上游那 5 条盘符路径（逐字节不变），
 * macOS 是 `/Applications/Hearthstone` 与 `~/Applications/Hearthstone`。
 * 保留具名导出，`log-source.ts` 引用它不用改。
 */
export const DEFAULT_INSTALL_DIRS = defaultInstallDirs();

export interface HearthstoneConfigSection extends WorldSection {
  /** Power.log 的绝对路径;留空 = 从安装目录自动找最新的那份。 */
  logPath: string;
  /** 炉石装在别处时填它的根目录,自动找日志用。 */
  installDir: string;
  /** 哪一方是本地玩家。auto 按日志里的 PLAYER_ID 惯例取 1。 */
  localPlayerId: 'auto' | '1' | '2';
  /** 轮到我行动时提一句。 */
  speakTurns: boolean;
  /** 轮到我时,事件里直接带一句机械建议(不用她再调工具)。 */
  adviceInTurn: boolean;
  /** 出现关键节点时开口(残血、被压场、进入斩杀线等)。 */
  speakAlerts: boolean;
  /** normal = 按上面两项自己开口;quiet = 只看不说,等被问。 */
  mode: 'normal' | 'quiet';
  /**
   * 听歌时让路。
   *
   * 打开后：检测到 QQ 音乐 / 网易云在跑，就按 `quiet` 处理——不主动解说回合和告警，
   * 你问的时候照答。让的是「主动开口」这一层，工具调用不受影响。
   *
   * **默认关。** 两件事同时进行、各说各的，这是很多人喜欢的状态。
   * 看到进程也不等于真在放歌，挂着不动也会让路。
   */
  yieldToMusic: boolean;
  /**
   * 允不允许她自己改那份打法档案。
   *
   * 关掉之后她只能读、不能写 —— 文件里已有的照旧生效，只是不新增。
   * 人和 AI 一起写同一份东西时，这个开关通常只在"她把档案写成流水账了"的时候用得上。
   */
  styleWritable: boolean;
  /**
   * 解说时站在谁的立场上。
   *
   * `mine` = 她自己那份 `hearthstone-style.md`（她写的，第一人称）。
   * `his`  = 从他对局记录里数出来的 `hearthstone-his-style.md`（他的习惯，用「你」说他）。
   *
   * 默认为什么是 `mine`：她的档案是她自己在这个世界里长出来的东西，
   * 不该被"他更熟悉自己的打法"这件事一上来就盖掉。他按需切。
   *
   * 无论切到哪一边，**算出来的东西都不许让** —— 斩杀、能换掉谁、
   * 群伤够不够，这几样只用 `hearthstone_advice` 的数。
   */
  voice: 'mine' | 'his';
  /** 残血阈值:生命值降到这个数以下算告警。 */
  alertHealth: number;
  /** 对手场上随从达到这个数算被压场。 */
  swarmCount: number;
  /** 保留最近多少个动作供 `hearthstone_recent` 查询。 */
  historySize: number;
  /** 轮询日志的间隔(毫秒)。 */
  pollMs: number;
  /**
   * 核心牌名单(留着做配合,不当普通按费牌打出去)。
   *
   * 逗号分隔,牌名或卡牌 ID 都行。机械规则永远不知道「这张牌是为了下一步铺垫」——
   * 只能由他告诉。实测:第 7 回合 4 水晶,建议把「德雷阿佳丝」当普通 3 费随从推出去,
   * 而那是他卡组的核心,要靠别的牌复制/触发她的亡语。
   */
  keepCards: string;
  /** 被问「这回合怎么打」时,要不要额外问一次模型(多回合规划)。 */
  llmAdvice: boolean;
  /** 模型名。默认 deepseek-chat。 */
  llmModel: string;
  /** 接口地址。默认 DeepSeek 官方;兼容任何 OpenAI 格式端点。 */
  llmBaseUrl: string;

  /* ---------- 日记 ---------- */

  /* ---------- 日记 ---------- */

  /**
   * 复盘日记存哪。留空 = 数据目录下的 `hearthstone-diary/`。
   *
   * 填一个 OneDrive / 坚果云的同步目录就能自动上云 —— 扩展自己不做上传，
   * 那是同步盘的事。换位置是整件事的重点：换个盘、换台机器都能接着读。
   */
  diaryDir: string;
}

export const HEARTHSTONE_DEFAULTS = (): HearthstoneConfigSection => ({
  enabled: false,
  logPath: '',
  installDir: '',
  localPlayerId: 'auto',
  speakTurns: true,
  adviceInTurn: true,
  speakAlerts: true,
  mode: 'normal',
  yieldToMusic: false,
  styleWritable: true,
  voice: 'mine',
  alertHealth: 10,
  swarmCount: 4,
  historySize: 200,
  pollMs: 400,
  keepCards: '',
  llmAdvice: false,
  llmModel: 'deepseek-chat',
  llmBaseUrl: 'https://api.deepseek.com',
  diaryDir: '',
});

/** 设置页的分组。键是 cfg 的点分路径。 */
export function hearthstoneConfigGroups(): ConfigGroup[] {
  return [
    {
      id: 'hearthstone.connect',
      owner: `world:${HEARTHSTONE_ID}`,
      schema: {
        type: 'object',
        title: '接入',
        description: '一次配好就不用再动。日常的开关与「要建议」都在陪打面板上。',
        properties: {
          'worlds.hearthstone.logPath': {
            type: 'string',
            title: 'Power.log 路径',
            description: '留空就自动找安装目录下最新的那份。',
            'x-path': { kind: 'file', extensions: ['log'] },
          },
          'worlds.hearthstone.installDir': {
            type: 'string',
            title: '炉石安装目录',
            description: '装在别的盘时填根目录。留空按常见位置依次试。',
            'x-path': { kind: 'directory' },
          },
          'worlds.hearthstone.localPlayerId': {
            type: 'string',
            title: '哪一方是你',
            description: '默认按日志惯例认为 PLAYER_ID=1 是你。把你说反了才改。',
            enum: ['auto', '1', '2'],
          },
          'worlds.hearthstone.keepCards': {
            type: 'string',
            title: '核心牌（起手一定留）',
            // 原描述只写了「别当普通随从扔」，读起来只管出牌那一侧，
            // 于是没人想到它同时决定换牌留不留 —— 实测 2026-10-28 那份配置是空的。
            description: '你卡组里不能当普通牌扔掉的核心。填在这里的牌：换牌阶段**一定留**（哪怕 7 费、哪怕后手），'
              + '按费打时也会单独标出来。逗号分隔，牌名或 ID；写短名能匹配全名（填「阿米图特」就命中「阿米图特，阿米图斯的守护者」）。',
            'x-hot': true,
          },
        },
      },
    },
    {
      id: 'hearthstone.advanced',
      owner: `world:${HEARTHSTONE_ID}`,
      schema: {
        type: 'object',
        title: '高级（一般不用动）',
        description: '阈值和模型。默认值是按真实对局调过的,没遇到具体问题就别改。',
        properties: {
          'worlds.hearthstone.yieldToMusic': {
            type: 'boolean',
            title: '听歌时让路',
            description: '打开后：检测到 QQ 音乐 / 网易云在跑，就不主动解说（回合提醒和告警都停），你问的时候照答；关掉播放器自动恢复。默认关——两件事同时进行、各说各的，很多人反而喜欢。注意：播放器挂着没放也算「在跑」，这时同样会安静。',
          },
          'worlds.hearthstone.styleWritable': {
            type: 'boolean',
            title: '允许她自己改打法档案',
            description:
              '存在 `hearthstone-style.md`，第一人称，写她在牌桌上是什么人、倾向推哪条路、看不惯什么。'
              + '**关掉之后她只能读不能写** —— 已有的照旧生效，只是不会新增。'
              + '这份档案只管「怎么说」和「先推哪条」，管不了算出来的斩杀和墙（那条写死在提示词里，开关管不到）。',
            'x-hot': true,
          },
          'worlds.hearthstone.voice': {
            type: 'string',
            title: '解说站在谁的立场',
            description:
              '「她自己的」＝按 `hearthstone-style.md`，那是她自己写的立场。'
              + '「你的」＝按 `hearthstone-his-style.md`，那份是从你的对局记录里数出来的（采纳率、常玩的职业、'
              + '你没按建议走时改打了什么），每打完一局自动重算。'
              + '面板上那个按钮切的就是这一项。'
              + '**两边都管不住算出来的数** —— 斩杀、能换掉谁、群伤够不够，照旧以 `hearthstone_advice` 为准。',
            enum: ['mine', 'his'],
            'x-hot': true,
          },
          'worlds.hearthstone.alertHealth': {
            type: 'integer',
            title: '残血线',
            description: '生命值降到这个数以下算一次告警。',
            minimum: 1,
            maximum: 29,
            'x-hot': true,
          },
          'worlds.hearthstone.swarmCount': {
            type: 'integer',
            title: '被压场线',
            description: '对手随从到这个数量算一次告警。',
            minimum: 2,
            maximum: 7,
            'x-hot': true,
          },
          'worlds.hearthstone.pollMs': {
            type: 'integer',
            title: '日志轮询间隔',
            description: '越小反应越快,越费 CPU。默认 400。',
            minimum: 100,
            maximum: 5000,
            'x-suffix': 'ms',
            'x-hot': true,
          },
          'worlds.hearthstone.llmAdvice': {
            type: 'boolean',
            title: '问模型要第二意见（默认关）',
            description: '关掉时点一下立刻出结果；开着会多等模型 1–3 秒，换一段独立判断。',
            'x-hot': true,
          },
          'worlds.hearthstone.llmModel': {
            type: 'string',
            title: '模型名',
            description: '默认 deepseek-chat。',
          },
        },
      },
    },
    {
      id: 'hearthstone.diary',
      owner: `world:${HEARTHSTONE_ID}`,
      schema: {
        type: 'object',
        title: '复盘日记',
        description: '她每局打完会写一篇：这把发生了什么、为什么赢或输、赢在哪输在哪。',
        properties: {
          'worlds.hearthstone.diaryDir': {
            type: 'string',
            title: '日记存哪（留空=数据目录）',
            description:
              '每局一篇，一天一个文件。'
              + '填你 OneDrive / 坚果云的同步目录就能自动上云 —— 扩展自己不做上传，交给同步盘。'
              + '换位置是这功能的意义所在：换盘、换机器都能接着读。',
          },
        },
      },
    },
  ];
}

