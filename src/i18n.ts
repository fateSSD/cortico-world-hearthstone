/**
 * 界面文案。简体中文以外的语言一律给英文(与框架的约定一致:DescribeText 只分 zh / en)。
 */
export interface HearthstoneText {
  label: string;
  lamp: {
    log: string;
    noLog: string;
    mode: string;
    quiet: string;
    normal: string;
  };
  promptTitle: string;
  promptDescription: string;
  varStatus: string;
  varGame: string;
  varMode: string;
  notInGame: string;
  modeQuiet: string;
  modeNormal: string;
}

const ZH: HearthstoneText = {
  label: '炉石陪打',
  lamp: {
    log: '对局日志',
    noLog: '没找到 Power.log——要么没开炉石日志,要么安装目录填错了',
    mode: '解说',
    quiet: '安静看着,等被问才答',
    normal: '该开口时自己开口',
  },
  promptTitle: '炉石陪打',
  promptDescription: '她怎么看你的对局、什么时候开口、哪些事只说事实不做判断。',
  varStatus: '日志连接状态一句话',
  varGame: '当前这局的局面摘要;不在局中时是一句说明',
  varMode: '现在是自己开口还是只看不说',
  notInGame: '现在不在局中。',
  modeQuiet: '安静模式:只记录,不主动开口。',
  modeNormal: '解说模式:该开口时自己开口。',
};

const EN: HearthstoneText = {
  label: 'Hearthstone Companion',
  lamp: {
    log: 'Game log',
    noLog: 'Power.log not found — the game log is off, or the install folder is wrong',
    mode: 'Commentary',
    quiet: 'Watching silently, answers only when asked',
    normal: 'Speaks up on its own',
  },
  promptTitle: 'Hearthstone companion',
  promptDescription: 'How she reads your match, when she speaks up, and what she states as fact rather than judgement.',
  varStatus: 'One line on the log connection',
  varGame: 'The current match summary; a note when no match is running',
  varMode: 'Whether she speaks up by herself or only watches',
  notInGame: 'No match is running right now.',
  modeQuiet: 'Quiet: she watches and records but does not speak up.',
  modeNormal: 'Commentary: she speaks up when something happens.',
};

export function hearthstoneText(language?: string): HearthstoneText {
  return language === 'zh' ? ZH : EN;
}
