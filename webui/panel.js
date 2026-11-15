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
    selfPlayNote: '按了之后她会气泡里问你一句，你答了才开始。她要先开着「电脑操作」才动得了手。',
    selfPlaySent: '叫她了 —— 等她气泡里问你',
    selfPlayFail: '没叫到，面板连不上服务端',
    thoughts: '她最近想到的',
    thoughtsEmpty: '还没写过。打完一局她可能会记一句。',
    feedback: '报 bug / 提需求',
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
    selfPlayNote: 'She will ask you in a bubble first — nothing happens until you say yes. Computer use must be enabled for her to act.',
    selfPlaySent: 'Asked her — wait for the bubble',
    selfPlayFail: 'Could not reach the server',
    thoughts: 'On her mind lately',
    thoughtsEmpty: 'Nothing yet. She writes one after a match now and then.',
    feedback: 'Report a bug / ask for a feature',
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

  const stats = el(doc, 'div', 'hs-stats');

  const button = el(doc, 'button', 'hs-ask', t.ask);
  button.type = 'button';

  const card = el(doc, 'div', 'hs-card hs-empty', t.empty);

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

  wrap.append(head, stats, button, card, voiceRow, switches, selfPlayRow, thoughtsRow, helpBox, footer);

  let busy = false;
  let lastKey = '';

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

  const apply = (payload) => {
    if (!payload || !payload.status) return;
    renderHead(payload.status);
    renderStats(payload.status);
    renderSwitches(payload.status.auto);
    renderVoice(payload.status);
    renderThoughts(payload.status.thoughts);
    if (payload.advice !== undefined) renderAdvice(payload.advice);
    button.disabled = busy || payload.status.ended || !payload.status.me;
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
