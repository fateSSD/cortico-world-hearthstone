/**
 * 炉石陪打 · 面板（浏览器 bundle，手写，无构建步骤）。
 *
 * 契约：默认导出 { panels: { <id>: { mount(ctx) } } }。宿主用 `import()` 装它，
 * `ctx.root` 是唯一的 DOM 挂载点，`ctx.invoke(method, args)` 打到 world 的 webUi().invoke。
 *
 * 设计上只有三件东西：一行状态、一个按钮、一行建议。别往这里加设置项 ——
 * 设置页已经够长了，面板存在的意义就是「一眼看、点一下」。
 */

const TEXT = {
  zh: {
    helpTitle: '扩展名旁边那三盏灯怎么看？',
    helpOn: '绿',
    helpOnDesc: '上一次是好的，正常。',
    helpOff: '灰',
    helpOffDesc: '没启用，不是坏了 —— 比如模式调成了「安静」，或者这局已经打完了。不用管。',
    helpErr: '红',
    helpErrDesc: '读不到对局，要去处理。原因和怎么办，鼠标停在灯上能看到。',
    helpWhich: '三盏灯分别是：日志（读得到对局吗）、模式（她会自动开口还是等你说）、形象包（蹦迪、律动那些动作要装包，宿主认不出就丢掉）。',
    turn: (n) => `第 ${n} 回合`,
    myTurn: '轮到你',
    foeTurn: '对手回合',
    quietHint: '她只看不说，等你点',
    normalHint: '她自己会开口',
    me: '我',
    foe: '对面',
    mana: '水晶',
    hand: '手牌',
    deck: '牌库',
    board: '场攻',
    ask: '让她看这回合',
    asking: '问一下…',
    sent: '已发给她',
    noGame: '现在没有进行中的对局',
    ended: '这局已经结束',
    watch: '日志在跟进',
    noLog: '没找到对局日志',
    auto: '自动开口',
    turns: '轮到我时提一句',
    alerts: '关键节点开口',
    fail: '面板连不上服务端',
    empty: '点上面那个按钮，让她说这回合怎么打。',
    voice: '按谁的思路',
    voiceMine: '她的',
    voiceHis: '你的',
    voiceEmpty: '这边还没数出来 —— 打完一局才会有',
    feedbackTip: '点一下复制邮箱 6316@qq.com',
    feedbackCopied: '已复制 6316@qq.com',
    feedbackFail: '复制失败 —— 手动抄一下：6316@qq.com',
    selfPlayBtn: '这局你来打',
    figInstall: '装形象包',
    figReinstall: '重装形象包',
    figInstalling: '正在装…',
    selfPlayNote: '按了之后她会气泡里问你一句，你答了才开始。她要先开着「电脑操作」才动得了手。',
    selfPlaySent: '叫她了 —— 等她气泡里问你',
    selfPlayFail: '没叫到，面板连不上服务端',
    thoughts: '她最近想到的',
    thoughtsEmpty: '还没写过。打完一局她可能会记一句。',
    feedback: '报 bug / 提需求',
    calibrateBtn: '校准',
    calibrateClose: '收起',
    ladderStandard: '标准',
    ladderWild: '狂野',
    ladderTwist: '幻变',
    rankPlaceholder: '如 钻5 2星 / 传说 #800',
    saveRank: '存段位',
    arenaUnder: '地下(12-3)',
    arenaNormal: '普通(5-2)',
    wins: '胜',
    losses: '负',
    saveArena: '设战绩',
    resetArena: '新开0-0',
    savedOk: '已更新',
    trackerTitle: '记牌器',
    myTrackerTitle: '我方记牌器',
    oppTrackerTitle: '对手记牌器',
    importDeck: '导代码',
    clearDeck: '清代码',
    deckNamePlaceholder: '可选：给这套牌起个名',
    deckPlaceholder: '粘贴炉石卡组代码(AAE...)或游戏内分享全文',
    doImport: '保存并启用',
    tabMy: '剩余牌库',
    tabMyPlayed: '我方已出',
    tabOpp: '对手已出',
    tabOppDeck: '对手牌库',
    tabHand: '对手手牌',
    noDeckHint: '未导入卡组代码（仅显示已见出牌，不编造牌库底）',
    noOppDeckHint: '未导入对手卡组代码（可粘贴对方代码看剩余牌）',
    mismatchHint: '已导入卡组与本局职业不符，已忽略',
    deckPlayed: '已出',
    deckEmpty: '牌库空了',
    noMyPlaysYet: '我方暂未出牌',
    noPlaysYet: '对手暂未出牌',
    deleteDeckTitle: '删除此卡组',
    searchOppDeck: '搜卡组',
    searchingOppDeck: '搜索中…',
    noOppHand: '对手空手或未在对局',
    secretsCount: (n) => `奥秘 ${n} 个`,
    oppCreated: '衍生',
    oppDraw: '抽',
    oppCoin: '硬币',
    heldTurns: (n) => `留${n}回合`,
    burstBadge: (dmg) => `余直伤 ${dmg}`,
    highlanderReady: '宇宙✓',
  },
  en: {
    helpTitle: 'What do the three dots next to the extension name mean?',
    helpOn: 'Green',
    helpOnDesc: 'last time worked. Normal.',
    helpOff: 'Grey',
    helpOffDesc: 'not enabled — that is not a fault. Quiet mode, or the match already ended. Nothing to do.',
    helpErr: 'Red',
    helpErrDesc: 'cannot read the match. Hover the dot for the reason and the fix.',
    helpWhich: 'The three are: log (can it read the match), mode (does she speak up by herself), figures (dance and bounce moves need a figure pack).',
    turn: (n) => `Turn ${n}`,
    myTurn: 'your turn',
    foeTurn: 'their turn',
    quietHint: 'She stays quiet until you ask',
    normalHint: 'She speaks up on her own',
    me: 'you',
    foe: 'foe',
    mana: 'mana',
    hand: 'hand',
    deck: 'deck',
    board: 'atk',
    ask: 'Ask her about this turn',
    asking: 'Asking…',
    sent: 'Sent',
    noGame: 'No match in progress',
    ended: 'Match over',
    watch: 'Watching the log',
    noLog: 'No game log found',
    auto: 'Speak up on her own',
    turns: 'Say something each turn',
    alerts: 'Speak on key moments',
    fail: 'Panel cannot reach the server',
    empty: 'Hit the button above to hear what to play.',
    voice: 'Whose read',
    voiceMine: 'Hers',
    voiceHis: 'Yours',
    voiceEmpty: 'Nothing counted yet — it needs one finished match',
    feedbackTip: 'Click to copy 6316@qq.com',
    feedbackCopied: 'Copied 6316@qq.com',
    feedbackFail: 'Copy failed — the address is 6316@qq.com',
    selfPlayBtn: 'You take this one',
    figInstall: 'Install figure pack',
    figReinstall: 'Install again',
    figInstalling: 'Installing…',
    selfPlayNote: 'She will ask you in a bubble first — nothing happens until you say yes. Computer use must be enabled for her to act.',
    selfPlaySent: 'Asked her — wait for the bubble',
    selfPlayFail: 'Could not reach the server',
    thoughts: 'On her mind lately',
    thoughtsEmpty: 'Nothing yet. She writes one after a match now and then.',
    feedback: 'Report a bug / ask for a feature',
    calibrateBtn: 'Calibrate',
    calibrateClose: 'Hide',
    ladderStandard: 'Standard',
    ladderWild: 'Wild',
    ladderTwist: 'Twist',
    rankPlaceholder: 'e.g. 钻5 2星 / 传说 #800',
    saveRank: 'Save rank',
    arenaUnder: 'Underground (12-3)',
    arenaNormal: 'Arena (5-2)',
    wins: 'W',
    losses: 'L',
    saveArena: 'Set record',
    resetArena: 'New 0-0',
    savedOk: 'Updated',
    trackerTitle: 'Deck Tracker',
    myTrackerTitle: 'My Tracker',
    oppTrackerTitle: 'Opp Tracker',
    importDeck: 'Import code',
    clearDeck: 'Clear',
    deckNamePlaceholder: 'Optional deck name',
    deckPlaceholder: 'Paste Blizzard deckstring (AAE...) or full deck text',
    doImport: 'Save & Use',
    tabMy: 'Remaining',
    tabMyPlayed: 'My Played',
    tabOpp: 'Opp Played',
    tabOppDeck: 'Opp Deck',
    tabHand: 'Opp Hand',
    noDeckHint: 'No deck code imported (only known seen cards shown)',
    noOppDeckHint: 'No opponent deck code imported',
    mismatchHint: 'Imported deck class mismatches match, ignored',
    deckPlayed: 'Played',
    deckEmpty: 'Deck empty',
    noMyPlaysYet: 'No plays yet',
    noPlaysYet: 'No opponent plays yet',
    deleteDeckTitle: 'Delete deck',
    searchOppDeck: 'Auto Search',
    searchingOppDeck: 'Searching…',
    noOppHand: 'Empty hand or not in match',
    secretsCount: (n) => `${n} secrets`,
    oppCreated: 'Created',
    oppDraw: 'Draw',
    oppCoin: 'Coin',
    heldTurns: (n) => `held ${n}T`,
    burstBadge: (dmg) => `${dmg} dmg left`,
    highlanderReady: 'No Dupes',
  },
};

function text(lang) {
  return lang && String(lang).startsWith('en') ? TEXT.en : TEXT.zh;
}

/**
 * 复制一段文字。
 *
 * 两级：先试 `navigator.clipboard`，不行再用 `execCommand` 兜底。
 * 为什么要有兜底：宿主的 webview 里剪贴板 API 可能因为权限策略被拒，
 * 而 `execCommand('copy')` 在选中文本框时是能用的 —— 这条是给那种情况留的。
 */
async function copyText(doc, text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到下面兜底 */ }
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function el(doc, tag, cls, content) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined) node.textContent = content;
  return node;
}

/**
 * 「灯怎么看」。默认折叠。
 *
 * 灯是宿主画在扩展名旁边的，原因只在悬停时出现 —— **没人知道要悬停**。
 * 面板里得有块能查的地方。
 *
 * 颜色一律走宿主的变量（这个文件的规矩是「不写死任何颜色」）：
 * `--ok` / `--ink-dim` / `--danger` 正好是三态。
 */
function lampsHelp(doc, t) {
  const box = el(doc, 'details', 'hs-help');
  box.append(el(doc, 'summary', null, t.helpTitle));

  const ul = el(doc, 'ul');
  for (const [color, k, d] of [
    ['var(--ok)', 'helpOn', 'helpOnDesc'],
    ['var(--ink-dim)', 'helpOff', 'helpOffDesc'],
    ['var(--danger)', 'helpErr', 'helpErrDesc'],
  ]) {
    const li = el(doc, 'li');
    const dot = el(doc, 'span', 'hs-help-dot');
    dot.style.background = color;
    li.append(dot, el(doc, 'b', null, t[k]), doc.createTextNode('　' + t[d]));
    ul.append(li);
  }
  box.append(ul, el(doc, 'p', 'hs-help-which', t.helpWhich));
  return box;
}

function mount(ctx) {
  const doc = ctx.root.ownerDocument;
  const t = text(ctx.language);
  const wrap = el(doc, 'div', 'hs-panel');
  ctx.root.appendChild(wrap);

  const head = el(doc, 'div', 'hs-head');
  const headText = el(doc, 'div', 'hs-head-text');
  const statusChip = el(doc, 'span', 'hs-chip', '—');
  head.append(headText, statusChip);

  // 模式与战绩进度条（可折叠校准）
  const progWrap = el(doc, 'div', 'hs-progress');
  const progBar = el(doc, 'div', 'hs-progress-bar');
  const progBrief = el(doc, 'span', 'hs-progress-brief', '—');
  const calToggle = el(doc, 'button', 'hs-mini-btn', t.calibrateBtn);
  calToggle.type = 'button';
  progBar.append(progBrief, calToggle);

  const calForm = el(doc, 'div', 'hs-prog-form');
  calForm.hidden = true;
  const rankRow = el(doc, 'div', 'hs-form-row');
  const rankFmt = el(doc, 'select', 'hs-input hs-select');
  for (const [val, lbl] of [['standard', t.ladderStandard], ['wild', t.ladderWild], ['twist', t.ladderTwist]]) {
    const opt = el(doc, 'option', null, lbl);
    opt.value = val;
    rankFmt.append(opt);
  }
  const rankInput = el(doc, 'input', 'hs-input hs-rank-input');
  rankInput.type = 'text';
  rankInput.placeholder = t.rankPlaceholder;
  const rankBtn = el(doc, 'button', 'hs-mini-btn is-primary', t.saveRank);
  rankBtn.type = 'button';
  rankRow.append(rankFmt, rankInput, rankBtn);

  const arenaRow = el(doc, 'div', 'hs-form-row');
  const arenaModeSel = el(doc, 'select', 'hs-input hs-select');
  for (const [val, lbl] of [['underground', t.arenaUnder], ['arena', t.arenaNormal]]) {
    const opt = el(doc, 'option', null, lbl);
    opt.value = val;
    arenaModeSel.append(opt);
  }
  const arenaWins = el(doc, 'input', 'hs-input hs-num-input');
  arenaWins.type = 'number';
  arenaWins.min = '0';
  arenaWins.max = '12';
  arenaWins.value = '0';
  const arenaLosses = el(doc, 'input', 'hs-input hs-num-input');
  arenaLosses.type = 'number';
  arenaLosses.min = '0';
  arenaLosses.max = '3';
  arenaLosses.value = '0';
  const arenaSaveBtn = el(doc, 'button', 'hs-mini-btn', t.saveArena);
  arenaSaveBtn.type = 'button';
  const arenaResetBtn = el(doc, 'button', 'hs-mini-btn', t.resetArena);
  arenaResetBtn.type = 'button';
  arenaRow.append(
    arenaModeSel,
    arenaWins, el(doc, 'span', 'hs-form-unit', t.wins),
    arenaLosses, el(doc, 'span', 'hs-form-unit', t.losses),
    arenaSaveBtn, arenaResetBtn,
  );
  const calMsg = el(doc, 'div', 'hs-form-msg');
  calForm.append(rankRow, arenaRow, calMsg);
  progWrap.append(progBar, calForm);

  calToggle.addEventListener('click', () => {
    calForm.hidden = !calForm.hidden;
    calToggle.textContent = calForm.hidden ? t.calibrateBtn : t.calibrateClose;
  }, { signal: ctx.signal });

  const stats = el(doc, 'div', 'hs-stats');

  const button = el(doc, 'button', 'hs-ask', t.ask);
  button.type = 'button';

  const card = el(doc, 'div', 'hs-card hs-empty', t.empty);

  const createDeckImporter = (importMethod, clearMethod) => {
    const actions = el(doc, 'div', 'hs-tracker-actions');
    const importBtn = el(doc, 'button', 'hs-mini-btn', t.importDeck);
    importBtn.type = 'button';
    const clearBtn = el(doc, 'button', 'hs-mini-btn', t.clearDeck);
    clearBtn.type = 'button';
    clearBtn.hidden = true;
    actions.append(importBtn, clearBtn);

    const bar = el(doc, 'div', 'hs-deck-bar');
    bar.hidden = true;

    const form = el(doc, 'div', 'hs-deck-form');
    form.hidden = true;
    const nameInput = el(doc, 'input', 'hs-input');
    nameInput.type = 'text';
    nameInput.placeholder = t.deckNamePlaceholder;
    const ta = el(doc, 'textarea', 'hs-input hs-deck-ta');
    ta.rows = 3;
    ta.placeholder = t.deckPlaceholder;
    const btns = el(doc, 'div', 'hs-form-row');
    const submitBtn = el(doc, 'button', 'hs-mini-btn is-primary', t.doImport);
    submitBtn.type = 'button';
    const msg = el(doc, 'div', 'hs-form-msg');
    btns.append(submitBtn, msg);
    form.append(nameInput, ta, btns);

    importBtn.addEventListener('click', () => {
      form.hidden = !form.hidden;
      msg.textContent = '';
    }, { signal: ctx.signal });

    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      setMsg(msg, '');
      try {
        const res = await ctx.invoke(importMethod, [ta.value, nameInput.value]);
        apply(res);
        if (res && res.ok === false) {
          setMsg(msg, res.error || t.fail, true);
        } else {
          ta.value = '';
          nameInput.value = '';
          form.hidden = true;
        }
      } catch (err) {
        setMsg(msg, err instanceof Error ? err.message : String(err), true);
      } finally {
        submitBtn.disabled = false;
      }
    }, { signal: ctx.signal });

    clearBtn.addEventListener('click', async () => {
      clearBtn.disabled = true;
      try {
        apply(await ctx.invoke(clearMethod, []));
      } catch (err) {
        showError(err);
      } finally {
        clearBtn.disabled = false;
      }
    }, { signal: ctx.signal });

    return { actions, bar, form, clearBtn };
  };

  // 双边独立记牌器容器：我方记牌器（含多卡组保存/切换） + 对手记牌器（同样支持导代码/清代码）
  const trackersGrid = el(doc, 'div', 'hs-trackers');

  const myTrackerBox = el(doc, 'div', 'hs-tracker hs-tracker-me');
  const myTrackerHead = el(doc, 'div', 'hs-tracker-head');
  const myTrackerTitle = el(doc, 'span', 'hs-tracker-title', t.myTrackerTitle);
  const myDeckUi = createDeckImporter('importDeck', 'clearDeck');
  myTrackerHead.append(myTrackerTitle, myDeckUi.actions);

  let activeMyTab = 'rem';
  const myTabRow = el(doc, 'div', 'hs-tabs');
  const myTabBtns = {};
  for (const [k, label] of [['rem', t.tabMy], ['played', t.tabMyPlayed]]) {
    const b = el(doc, 'button', `hs-tab${k === activeMyTab ? ' is-on' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', () => {
      activeMyTab = k;
      for (const [key, node] of Object.entries(myTabBtns)) {
        node.classList.toggle('is-on', key === activeMyTab);
      }
      if (latestTracker) renderMyTrackerBody(latestTracker, true);
    }, { signal: ctx.signal });
    myTabBtns[k] = b;
    myTabRow.append(b);
  }
  const myTrackerList = el(doc, 'div', 'hs-tracker-list');
  myTrackerBox.append(myTrackerHead, myDeckUi.bar, myDeckUi.form, myTabRow, myTrackerList);

  const oppTrackerBox = el(doc, 'div', 'hs-tracker hs-tracker-opp');
  const oppTrackerHead = el(doc, 'div', 'hs-tracker-head');
  const oppTrackerTitle = el(doc, 'span', 'hs-tracker-title', t.oppTrackerTitle);
  const oppDeckUi = createDeckImporter('importOppDeck', 'clearOppDeck');
  const searchOppBtn = el(doc, 'button', 'hs-mini-btn', t.searchOppDeck);
  searchOppBtn.type = 'button';
  oppDeckUi.actions.prepend(searchOppBtn);
  oppTrackerHead.append(oppTrackerTitle, oppDeckUi.actions);

  const oppSearchMsg = el(doc, 'div', 'hs-form-msg');
  oppSearchMsg.hidden = true;
  searchOppBtn.addEventListener('click', async () => {
    if (searchOppBtn.disabled) return;
    searchOppBtn.disabled = true;
    searchOppBtn.textContent = t.searchingOppDeck;
    oppSearchMsg.hidden = true;
    try {
      const res = await ctx.invoke('searchOppDeck', []);
      apply(res);
      if (res && res.ok === false) {
        oppSearchMsg.hidden = false;
        setMsg(oppSearchMsg, res.error || t.fail, true);
      } else if (res && res.message) {
        oppSearchMsg.hidden = false;
        setMsg(oppSearchMsg, res.message, false);
        ctx.timeout(() => { oppSearchMsg.hidden = true; }, 4500);
      }
    } catch (err) {
      oppSearchMsg.hidden = false;
      setMsg(oppSearchMsg, err instanceof Error ? err.message : String(err), true);
    } finally {
      searchOppBtn.textContent = t.searchOppDeck;
      searchOppBtn.disabled = false;
    }
  }, { signal: ctx.signal });

  const matchupRow = el(doc, 'div', 'hs-tracker-matchup');
  matchupRow.hidden = true;

  let activeOppTab = 'opp';
  const oppTabRow = el(doc, 'div', 'hs-tabs');
  const oppTabBtns = {};
  for (const [k, label] of [['opp', t.tabOpp], ['deck', t.tabOppDeck], ['hand', t.tabHand]]) {
    const b = el(doc, 'button', `hs-tab${k === activeOppTab ? ' is-on' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', () => {
      activeOppTab = k;
      for (const [key, node] of Object.entries(oppTabBtns)) {
        node.classList.toggle('is-on', key === activeOppTab);
      }
      if (latestTracker) renderOppTrackerBody(latestTracker, true);
    }, { signal: ctx.signal });
    oppTabBtns[k] = b;
    oppTabRow.append(b);
  }
  const oppTrackerList = el(doc, 'div', 'hs-tracker-list');
  oppTrackerBox.append(oppTrackerHead, oppSearchMsg, oppDeckUi.bar, oppDeckUi.form, matchupRow, oppTabRow, oppTrackerList);

  trackersGrid.append(myTrackerBox, oppTrackerBox);

  const switches = el(doc, 'div', 'hs-switches');

  // 「按谁的思路」单独一行,不进开关组:那三个是「她开不开口」,
  // 这一行是「她站在谁的立场」—— 安静模式下照样有意义。
  const voiceRow = el(doc, 'div', 'hs-voice');

  // 「这局你来打」：按钮只是**叫她过来问一句**，不是开关。
  // 真正的授权在桌宠那边的气泡问答里 —— 宿主的规矩只认那边的回答。
  const selfPlayRow = el(doc, 'div', 'hs-selfplay');
  const selfPlayBtn = el(doc, 'button', 'hs-selfplay-btn', t.selfPlayBtn);
  selfPlayBtn.type = 'button';
  const selfPlayNote = el(doc, 'div', 'hs-selfplay-note', t.selfPlayNote);
  selfPlayRow.append(selfPlayBtn, selfPlayNote);

  // 感想栏：跨对局的东西，放在「这局怎么样」那一堆下面。
  const thoughtsRow = el(doc, 'div', 'hs-thoughts');

  /*
   * 形象包：那组跟随动作只有装了才存在，而形象包没地方发，只能跟着扩展走。
   *
   * **装的动作要他点了才发生**（2026-11-16）。原来是载入即装 —— 官方
   * `cortico-extensions#659` 明确要求改掉：装个陪打扩展不该顺带往
   * 桌宠的 `data/figures/` 里塞东西。所以这里只有按钮，没有自动。
   */
  const figureRow = el(doc, 'div', 'hs-figure');
  const figureMsg = el(doc, 'div', 'hs-figure-msg', '');
  const figureBtn = el(doc, 'button', 'hs-figure-btn', t.figInstall);
  figureBtn.type = 'button';
  figureRow.append(figureMsg, figureBtn);

  figureBtn.addEventListener('click', async () => {
    if (figureBtn.disabled) return;
    figureBtn.disabled = true;
    figureBtn.textContent = t.figInstalling;
    try {
      apply(await ctx.invoke('figure'));
    } catch (err) {
      showError(err);
      figureBtn.textContent = t.figReinstall;
      figureBtn.disabled = false;
    }
  }, { signal: ctx.signal });

  // 反馈入口放最底下，不打扰上面那块。
  const footer = el(doc, 'div', 'hs-footer');
  // 反馈入口：**点击复制邮箱**，不是 mailto。
  //
  // 原来写成 <a href="mailto:...">，点了没反应 —— 宿主的面板是 webview，
  // 里面没有注册 mailto 的处理器，点了等于点在一块死链接上。
  // 复制到剪贴板这条路在 webview 里是可靠的，而且他粘到哪儿都行。
  const feedback = el(doc, 'button', 'hs-feedback', t.feedback);
  feedback.type = 'button';
  feedback.title = t.feedbackTip;
  feedback.addEventListener('click', async () => {
    const ok = await copyText(doc, '6316@qq.com');
    feedback.textContent = ok ? t.feedbackCopied : t.feedbackFail;
    feedback.disabled = true;
    setTimeout(() => {
      feedback.textContent = t.feedback;
      feedback.disabled = false;
    }, 2200);
  }, { signal: ctx.signal });
  footer.append(feedback);

  selfPlayBtn.addEventListener('click', async () => {
    if (selfPlayBtn.disabled) return;
    selfPlayBtn.disabled = true;
    try {
      await ctx.invoke('selfplay');
      selfPlayNote.textContent = t.selfPlaySent;
      selfPlayNote.classList.add('is-ok');
    } catch {
      selfPlayNote.textContent = t.selfPlayFail;
      selfPlayNote.classList.add('is-bad');
    }
    // 5 秒后恢复原样 —— 提示留在那儿会变成一块「已经叫过了」的死状态，
    // 下一局他想再叫一次时会以为按钮坏了。
    setTimeout(() => {
      selfPlayBtn.disabled = false;
      selfPlayNote.textContent = t.selfPlayNote;
      selfPlayNote.classList.remove('is-ok', 'is-bad');
    }, 5000);
  }, { signal: ctx.signal });

  /* 灯说明放在最底下 —— 用户是「看到灰点、滚下来找答案」才需要它。 */
  const helpBox = lampsHelp(doc, t);

  wrap.append(head, progWrap, stats, button, card, trackersGrid, voiceRow, switches, selfPlayRow, figureRow, thoughtsRow, helpBox, footer);

  let busy = false;
  let lastKey = '';
  let latestTracker = null;
  let myTrackerSig = '';
  let oppTrackerSig = '';
  let myDeckBarSig = '';
  let oppDeckBarSig = '';

  const setMsg = (node, msg, isErr = false) => {
    node.textContent = msg || '';
    node.className = `hs-form-msg${isErr ? ' is-err' : msg ? ' is-ok' : ''}`;
  };

  rankBtn.addEventListener('click', async () => {
    rankBtn.disabled = true;
    setMsg(calMsg, '');
    try {
      const res = await ctx.invoke('setRank', [rankFmt.value, rankInput.value]);
      apply(res);
      if (res && res.ok === false) setMsg(calMsg, res.error || t.fail, true);
      else setMsg(calMsg, t.savedOk);
    } catch (err) {
      setMsg(calMsg, err instanceof Error ? err.message : String(err), true);
    } finally {
      rankBtn.disabled = false;
    }
  }, { signal: ctx.signal });

  arenaSaveBtn.addEventListener('click', async () => {
    arenaSaveBtn.disabled = true;
    setMsg(calMsg, '');
    try {
      const res = await ctx.invoke('setArena', [Number(arenaWins.value) || 0, Number(arenaLosses.value) || 0, arenaModeSel.value]);
      apply(res);
      setMsg(calMsg, t.savedOk);
    } catch (err) {
      setMsg(calMsg, err instanceof Error ? err.message : String(err), true);
    } finally {
      arenaSaveBtn.disabled = false;
    }
  }, { signal: ctx.signal });

  arenaResetBtn.addEventListener('click', async () => {
    arenaResetBtn.disabled = true;
    setMsg(calMsg, '');
    try {
      const res = await ctx.invoke('resetArena', [arenaModeSel.value]);
      arenaWins.value = '0';
      arenaLosses.value = '0';
      apply(res);
      setMsg(calMsg, t.savedOk);
    } catch (err) {
      setMsg(calMsg, err instanceof Error ? err.message : String(err), true);
    } finally {
      arenaResetBtn.disabled = false;
    }
  }, { signal: ctx.signal });

  // 多卡组导入/清空事件已由 createDeckImporter 统一绑定

  const chip = (state) => {
    statusChip.dataset.state = state;
  };

  const cell = (label, value, tone) => {
    const box = el(doc, 'div', 'hs-cell');
    box.append(el(doc, 'span', 'hs-cell-label', label), el(doc, 'span', `hs-cell-value${tone ? ` hs-${tone}` : ''}`, value));
    return box;
  };

  const renderStats = (status) => {
    stats.replaceChildren();
    if (!status.me || !status.foe) {
      stats.append(el(doc, 'div', 'hs-note', status.note || t.noGame));
      return;
    }
    const me = status.me;
    const foe = status.foe;
    stats.append(
      cell(t.me, me.armor ? `${me.hp}+${me.armor}` : String(me.hp)),
      cell(t.foe, foe.armor ? `${foe.hp}+${foe.armor}` : String(foe.hp)),
      cell(t.mana, `${me.mana}/${me.manaMax}`),
      cell(t.board, String(foe.boardAttack), foe.boardAttack >= me.hp + me.armor ? 'danger' : ''),
      cell(t.hand, String(me.hand)),
    );
  };

  const renderHead = (status) => {
    if (status.turn === null) {
      headText.textContent = status.phase === 'no-log' ? t.noLog : t.watch;
      chip('off');
      return;
    }
    const who = status.ended ? t.ended : status.myTurn ? t.myTurn : t.foeTurn;
    headText.textContent = `${t.turn(status.turn)} · ${who}`;
    chip(status.ended ? 'off' : status.myTurn ? 'on' : 'idle');
  };

  const renderSwitches = (auto) => {
    switches.replaceChildren();
    const row = (key, label, value, kind) => {
      const item = el(doc, 'label', 'hs-switch');
      const input = el(doc, 'input');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.disabled = busy;
      input.addEventListener('change', async () => {
        const next = input.checked;
        input.disabled = true;
        try {
          const payload = await ctx.invoke('auto', [key, next]);
          apply(payload);
        } catch (err) {
          input.checked = !next;
          showError(err);
        } finally {
          input.disabled = false;
        }
      }, { signal: ctx.signal });
      item.append(input, el(doc, 'span', '', label));
      if (kind) item.dataset.kind = kind;
      return item;
    };
    // 主开关别写成「自动开口：自动」这种同义反复 —— 直接说清勾上等于什么:
    // 勾上 = 她自己会开口;不勾 = 她只看不说,等你在上面那一下。
    const quiet = auto.mode === 'quiet';
    switches.append(
      row('mode', quiet ? t.quietHint : t.normalHint, !quiet, 'primary'),
      row('speakTurns', t.turns, auto.speakTurns),
      row('speakAlerts', t.alerts, auto.speakAlerts),
    );
  };

  /**
   * 「按谁的思路」。
   *
   * 两个按钮而不是一个开关：开关只能表达「开 / 关」，而这里两边都是有内容的状态，
   * 没有「关掉」这个选项 —— 写成勾选框，他每次都要想一下「不勾是什么」。
   *
   * 切到他那边时如果还没数出来，把话说在脸上。点了没反应会被当成按钮坏了。
   *
   * **只在状态真的变了才重绘。** 面板每 2 秒轮询一次，每次都 replaceChildren 的话，
   * 他手指按下去那一瞬按钮正好被换掉，这次点击就没了 —— 表现是「点了没反应，再点就好了」。
   */
  let voiceSig = '';
  /**
   * 她最近想到的。
   *
   * 没有就显示一句空态 —— 空着一块什么都没有的框，会让人以为坏了。
   * 每条只给时刻 + 正文：她写的时候自己带局面（「第 12 回合，对面空场」），
   * 面板再拼一遍「第几回合」是重复。
   */
  const renderThoughts = (list) => {
    thoughtsRow.replaceChildren();
    thoughtsRow.append(el(doc, 'div', 'hs-thoughts-title', t.thoughts));
    if (!list || !list.length) {
      thoughtsRow.append(el(doc, 'div', 'hs-thoughts-empty', t.thoughtsEmpty));
      return;
    }
    const ul = el(doc, 'ul', 'hs-thoughts-list');
    for (const item of list) {
      const li = el(doc, 'li');
      const at = (item.at || '').slice(11, 16);
      li.append(el(doc, 'span', 'hs-thoughts-at', at));
      li.append(el(doc, 'span', 'hs-thoughts-text', item.text || ''));
      ul.append(li);
    }
    thoughtsRow.append(ul);
  };

  const renderVoice = (status) => {
    // voice 缺省时（旧版 Core、或页面拿到的是旧数据）当成 mine ——
    // 不加这一句，两个按钮都不亮，看着像坏了。
    const cur = status.voice === 'his' ? 'his' : 'mine';
    const sig = `${cur}|${Boolean(status.hisReady)}|${busy}`;
    if (sig === voiceSig) return;
    voiceSig = sig;

    voiceRow.replaceChildren();
    voiceRow.append(el(doc, 'span', 'hs-voice-label', t.voice));
    const seg = el(doc, 'div', 'hs-seg');
    const pick = (key, label, active, hint) => {
      const b = el(doc, 'button', `hs-seg-btn${active ? ' is-on' : ''}`, label);
      b.type = 'button';
      b.disabled = active || busy;
      if (hint) b.title = hint;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          apply(await ctx.invoke('voice', [key]));
        } catch (err) {
          showError(err);
          b.disabled = false;
        }
      }, { signal: ctx.signal });
      return b;
    };
    seg.append(
      pick('mine', t.voiceMine, cur === 'mine', t.voiceMine),
      pick('his', t.voiceHis, cur === 'his', status.hisReady ? t.voiceHis : t.voiceEmpty),
    );
    voiceRow.append(seg);
    if (cur === 'his' && !status.hisReady) {
      voiceRow.append(el(doc, 'span', 'hs-voice-note', t.voiceEmpty));
    }
  };

  const renderAdvice = (advice) => {
    if (!advice) {
      card.className = 'hs-card hs-empty';
      card.textContent = t.empty;
      return;
    }
    card.className = `hs-card hs-kind-${advice.kind}`;
    card.textContent = advice.text;
    // 建议换了才动一下,避免每 2 秒闪一次
    if (advice.text !== lastKey) {
      lastKey = advice.text;
      card.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 220 });
    }
  };

  const renderProgress = (status) => {
    const p = status.progress;
    if (!p) { progWrap.hidden = true; return; }
    progWrap.hidden = false;
    progBrief.textContent = p.brief || '—';
    const editing = Boolean(doc?.activeElement && calForm.contains?.(doc.activeElement));
    if (!editing && calForm.hidden) {
      if (p.ladderFormat) rankFmt.value = p.ladderFormat;
      if (p.arenaMode) arenaModeSel.value = p.arenaMode;
    }
  };

  const rowNode = (docRef, cost, name, right, extraCls) => {
    const r = el(docRef, 'div', `hs-tr-row${extraCls ? ` ${extraCls}` : ''}`);
    if (cost !== null) r.append(el(docRef, 'span', 'hs-tr-cost', String(cost)));
    r.append(el(docRef, 'span', 'hs-tr-name', name));
    if (right) r.append(el(docRef, 'span', 'hs-tr-right', right));
    return r;
  };

  const renderMyTrackerBody = (tr, force = false) => {
    const sig = `${activeMyTab}|${tr.deckSource}|${tr.deckMismatch}|${JSON.stringify(tr.myRemaining)}|${JSON.stringify(tr.myPlayed)}`;
    if (!force && sig === myTrackerSig) return;
    myTrackerSig = sig;
    myTrackerList.replaceChildren();

    if (activeMyTab === 'played') {
      if (!tr.myPlayed || !tr.myPlayed.length) {
        myTrackerList.append(el(doc, 'div', 'hs-tr-hint', t.noMyPlaysYet));
        return;
      }
      for (const p of tr.myPlayed) {
        myTrackerList.append(rowNode(doc, p.cost, p.name, `${t.deckPlayed}×${p.count}`));
      }
      return;
    }

    if (tr.deckSource === 'none') {
      myTrackerList.append(el(doc, 'div', 'hs-tr-hint', tr.deckMismatch ? t.mismatchHint : t.noDeckHint));
      for (const p of tr.myPlayed || []) {
        myTrackerList.append(rowNode(doc, p.cost, p.name, `${t.deckPlayed}×${p.count}`));
      }
      return;
    }
    if (!tr.myRemaining || !tr.myRemaining.length) {
      myTrackerList.append(el(doc, 'div', 'hs-tr-hint', t.deckEmpty));
      return;
    }
    for (const c of tr.myRemaining) {
      const probText = c.prob > 0 ? ` ${Math.round(c.prob * 100)}%` : '';
      const right = `×${c.left}${probText}`;
      const label = c.extraCreated ? `${c.name} [洗]` : c.name;
      myTrackerList.append(rowNode(doc, c.cost, label, right));
    }
  };

  const renderOppTrackerBody = (tr, force = false) => {
    const sig = `${activeOppTab}|${tr.oppDeckSource}|${tr.oppDeckMismatch}|${tr.oppSecrets}|${JSON.stringify(tr.oppRemaining)}|${JSON.stringify(tr.oppPlayed)}|${JSON.stringify(tr.oppHand)}`;
    if (!force && sig === oppTrackerSig) return;
    oppTrackerSig = sig;
    oppTrackerList.replaceChildren();

    if (activeOppTab === 'deck') {
      if (tr.oppDeckSource !== 'imported') {
        oppTrackerList.append(el(doc, 'div', 'hs-tr-hint', tr.oppDeckMismatch ? t.mismatchHint : t.noOppDeckHint));
        return;
      }
      if (!tr.oppRemaining || !tr.oppRemaining.length) {
        oppTrackerList.append(el(doc, 'div', 'hs-tr-hint', t.deckEmpty));
        return;
      }
      for (const c of tr.oppRemaining) {
        const probText = c.prob > 0 ? ` ${Math.round(c.prob * 100)}%` : '';
        oppTrackerList.append(rowNode(doc, c.cost, c.name, `×${c.left}${probText}`));
      }
      return;
    }

    if (activeOppTab === 'opp') {
      if (!tr.oppPlayed || !tr.oppPlayed.length) {
        oppTrackerList.append(el(doc, 'div', 'hs-tr-hint', t.noPlaysYet));
        return;
      }
      for (const p of tr.oppPlayed) {
        const right = `${p.count > 1 ? `×${p.count} ` : ''}${p.created ? t.oppCreated : ''}`.trim();
        oppTrackerList.append(rowNode(doc, p.cost, p.name, right, p.created ? 'is-created' : ''));
      }
      return;
    }

    if (tr.oppSecrets > 0) {
      oppTrackerList.append(el(doc, 'div', 'hs-tr-secret', t.secretsCount(tr.oppSecrets)));
    }
    if (!tr.oppHand || !tr.oppHand.length) {
      oppTrackerList.append(el(doc, 'div', 'hs-tr-hint', t.noOppHand));
      return;
    }
    for (const h of tr.oppHand) {
      const label = h.revealedName
        ? `#${h.slot} ${h.revealedName} [明牌]`
        : h.isCoin
          ? `#${h.slot} ${t.oppCoin}`
          : `#${h.slot} T${h.enteredTurn} ${h.created ? (h.creatorName ? `${t.oppCreated}(${h.creatorName})` : t.oppCreated) : t.oppDraw}`;
      oppTrackerList.append(rowNode(doc, null, label, t.heldTurns(h.age), h.created ? 'is-created' : ''));
    }
  };

  const renderDeckBarNodes = (bar, rawList, selectMethod, deleteMethod, prevSig) => {
    const list = Array.isArray(rawList) ? rawList : [];
    const sig = JSON.stringify(list);
    if (sig === prevSig) return prevSig;
    bar.replaceChildren();
    if (!list.length) { bar.hidden = true; return sig; }
    bar.hidden = false;
    for (const d of list) {
      const chipWrap = el(doc, 'div', `hs-deck-chip${d.active ? ' is-on' : ''}`);
      const pickBtn = el(doc, 'button', 'hs-deck-chip-btn', d.heroClass ? `${d.heroClass}·${d.name}` : d.name);
      pickBtn.type = 'button';
      pickBtn.title = d.name;
      pickBtn.addEventListener('click', async () => {
        try {
          apply(await ctx.invoke(selectMethod, [d.active ? '' : d.id]));
        } catch (err) {
          showError(err);
        }
      }, { signal: ctx.signal });
      const delBtn = el(doc, 'button', 'hs-deck-chip-del', '×');
      delBtn.type = 'button';
      delBtn.title = t.deleteDeckTitle;
      delBtn.addEventListener('click', async () => {
        try {
          apply(await ctx.invoke(deleteMethod, [d.id]));
        } catch (err) {
          showError(err);
        }
      }, { signal: ctx.signal });
      chipWrap.append(pickBtn, delBtn);
      bar.append(chipWrap);
    }
    return sig;
  };

  const renderTracker = (status) => {
    const tr = status.tracker;
    latestTracker = tr || null;
    if (!tr) { trackersGrid.hidden = true; return; }
    trackersGrid.hidden = false;

    const myBadges = [];
    if (tr.deckName) myBadges.push(tr.deckName);
    else if (tr.myClass) myBadges.push(tr.myClass);
    if (tr.inGame) myBadges.push(`${tr.myRemainingCount}`);
    if (tr.remainingBurstDamage > 0) myBadges.push(t.burstBadge(tr.remainingBurstDamage));
    if (tr.hasDuplicates === false) myBadges.push(t.highlanderReady);
    myTrackerTitle.textContent = myBadges.length ? `${t.myTrackerTitle} · ${myBadges.join(' · ')}` : t.myTrackerTitle;

    const oppBadges = [];
    if (tr.oppDeckName) oppBadges.push(tr.oppDeckName);
    else if (tr.oppClass) oppBadges.push(tr.oppClass);
    if (tr.inGame) oppBadges.push(`${t.hand}${tr.oppHandCount ?? 0}/${t.deck}${tr.oppDeckCount ?? 0}`);
    if (tr.oppSecrets > 0) oppBadges.push(t.secretsCount(tr.oppSecrets));
    oppTrackerTitle.textContent = oppBadges.length ? `${t.oppTrackerTitle} · ${oppBadges.join(' · ')}` : t.oppTrackerTitle;

    myDeckUi.clearBtn.hidden = !(tr.hasImportedDeck ?? (tr.deckSource === 'imported' || tr.deckMismatch));
    oppDeckUi.clearBtn.hidden = !(tr.hasOppImportedDeck ?? (tr.oppDeckSource === 'imported' || tr.oppDeckMismatch));
    myDeckBarSig = renderDeckBarNodes(myDeckUi.bar, tr.savedDecks, 'selectDeck', 'deleteDeck', myDeckBarSig);
    oppDeckBarSig = renderDeckBarNodes(oppDeckUi.bar, tr.oppSavedDecks, 'selectOppDeck', 'deleteOppDeck', oppDeckBarSig);

    if (tr.matchupBrief) {
      matchupRow.hidden = false;
      matchupRow.textContent = tr.matchupBrief;
    } else {
      matchupRow.hidden = true;
      matchupRow.textContent = '';
    }
    renderMyTrackerBody(tr);
    renderOppTrackerBody(tr);
  };

  const apply = (payload) => {
    if (!payload || !payload.status) return;
    renderHead(payload.status);
    renderProgress(payload.status);
    renderStats(payload.status);
    renderSwitches(payload.status.auto);
    renderTracker(payload.status);
    renderVoice(payload.status);
    renderThoughts(payload.status.thoughts);
    renderFigure(payload.figure);
    if (payload.advice !== undefined) renderAdvice(payload.advice);
    button.disabled = busy || payload.status.ended || !payload.status.me;
  };

  /**
   * 形象包那一行：说清现在什么状态，**按钮一直在**（2026-11-16 改）。
   *
   * 之前只在 `missing` 时露出来，装过一次的人就再也看不见它 ——
   * 面板上这一格会变成一句没法操作的话。现在按状态换字，装过就是「重装」
   * （`force` 整格重写，包坏了靠它救）；只有「别人的包」（occupied）禁用：
   * 覆盖别人做的东西比装不上更糟。
   */
  const renderFigure = (fig) => {
    if (!fig) { figureRow.hidden = true; return; }
    figureRow.hidden = false;
    figureMsg.textContent = fig.message || '';
    const blocked = fig.status === 'occupied' || fig.status === 'loading';
    figureBtn.hidden = false;
    figureBtn.disabled = blocked;
    figureBtn.textContent = fig.status === 'missing' ? t.figInstall : t.figReinstall;
  };

  const showError = (err) => {
    card.className = 'hs-card hs-kind-danger';
    card.textContent = `${t.fail}:${err instanceof Error ? err.message : String(err)}`;
  };

  const refresh = async () => {
    try {
      apply(await ctx.invoke('status'));
    } catch (err) {
      showError(err);
    }
  };

  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    const old = button.textContent;
    button.textContent = t.asking;
    try {
      const payload = await ctx.invoke('ask');
      apply(payload);
      button.textContent = t.sent;
      ctx.timeout(() => { button.textContent = old; }, 1400);
    } catch (err) {
      showError(err);
      button.textContent = old;
    } finally {
      busy = false;
      button.disabled = false;
    }
  }, { signal: ctx.signal });

  void refresh();
  // 2 秒一轮:日志那边的轮询是 400ms,面板不需要跟着抖;
  // 他盯着的是「回合/血量/场攻」这类会停几秒的数。
  ctx.interval(() => { void refresh(); }, 2000);
}

export default {
  panels: {
    main: { mount },
  },
};
