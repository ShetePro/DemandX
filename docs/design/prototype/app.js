/* DemandX prototype interactions */
(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ---------- theme ---------- */
  const saved = localStorage.getItem('dx-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('dx-theme', next);
  });

  /* ---------- evidence fixtures ---------- */
  const EV = {
    e12: {
      title: '证据 e12',
      sub: '小红书 · 2026-02-18 · 一手',
      quote: '“三个平台改库存改到凌晨，每次都怕超卖，平台又不同步。”',
      supports: '多平台库存同步是高频、真实的操作痛点。',
      not: '用户愿意为工具付费，或愿意更换现有方案。',
      signal: '需要（problem/seeking）· 价格：未提及 · 平台：小红书',
    },
    e19: {
      title: '证据 e19',
      sub: 'Reddit · r/ecommerce · 2026-01-07 · 一手',
      quote: '“We already pay for an ERP but 399 a month is too much for 3 marketplaces.”',
      supports: '存在已付费的替代方案，且价格是可讨论的变量。',
      not: '用户愿意迁移到更便宜的新产品。',
      signal: '付费 · 价格：$399/月 · 平台：Reddit',
    },
    e21: {
      title: '证据 e21',
      sub: 'Hacker News · 2026-03-02 · 一手',
      quote: '“Looking for a self-hosted alternative to our ERP — migration cost is the blocker.”',
      supports: '存在主动寻找替代品的用户。',
      not: '替代方案已经出现，或迁移成本可被接受。',
      signal: '切换 · 价格：未提及 · 平台：Hacker News',
    },
  };

  /* ---------- drawer ---------- */
  const drawer = $('#drawer');
  const scrim  = $('#scrim');
  const openDrawer = (id) => {
    const d = EV[id];
    if (!d) return;
    $('#dTitle').textContent = d.title;
    $('#dSub').textContent = d.sub;
    $('#dQuote').textContent = d.quote;
    $('#dSupports').textContent = d.supports;
    $('#dNot').textContent = d.not;
    $('#dSignal').textContent = d.signal;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.classList.add('show');
  };
  const closeDrawer = () => {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('show');
  };
  document.addEventListener('click', (e) => {
    const ev = e.target.closest('[data-e]');
    if (ev) { openDrawer(ev.dataset.e); return; }
    if (e.target.closest('#drawerClose') || e.target === scrim) closeDrawer();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  /* ---------- routing ---------- */
  let started = false;
  const go = (name) => {
    $$('.screen').forEach(s => s.classList.toggle('is-active', s.dataset.screen === name));
    $$('.nav-item[data-nav]').forEach(n => n.classList.toggle('is-active', n.dataset.nav === name));
    const map = { home: '工作台', chat: '对话', report: '报告', evidence: '证据库', settings: 'LLM 与采集' };
    document.title = `DemandX · ${map[name] || ''}`;
    animateBars();
    if (name === 'chat' && !started) { started = true; revealAnswer(); }
    if (name === 'report') observeSections();
  };
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); go(nav.dataset.nav); }
  });

  /* ---------- bars ---------- */
  const animateBars = () => {
    $$('.screen.is-active .bar > i').forEach(bar => {
      bar.style.width = '0%';
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = 'var(--w)'; }));
    });
  };

  /* ---------- chat reveal ---------- */
  const revealAnswer = () => {
    const typing = $('#typing');
    const stream = $('#stream');
    if (!typing || !stream) return;
    stream.style.opacity = '0';
    typing.classList.add('show');
    setTimeout(() => {
      typing.classList.remove('show');
      stream.style.transition = 'opacity .35s ease';
      stream.style.opacity = '1';
    }, 1000);
  };

  /* ---------- start run ---------- */
  $('#startRun')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>已启动';
    const card = btn.closest('.run-card');
    const bar = card?.querySelector('.bar > i');
    if (bar) {
      bar.style.setProperty('--w', '72%');
      bar.style.width = '72%';
    }
    const stages = card?.querySelector('.run-stages');
    if (stages) stages.lastElementChild.textContent = 'S4–S6 排队中';
  });

  /* ---------- settings: test connection ---------- */
  $('#testBtn')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const out = $('#testResult');
    const label = btn.querySelector('span');
    btn.disabled = true;
    const original = label.textContent;
    label.textContent = '测试中…';
    btn.querySelector('.i')?.replaceWith(Object.assign(document.createElement('span'), { className: 'spinner' }));
    setTimeout(() => {
      btn.disabled = false;
      label.textContent = original;
      btn.querySelector('.spinner')?.remove();
      btn.insertAdjacentHTML('afterbegin', '<svg class="i i-success"><use href="#i-check"/></svg>');
      out.hidden = false;
      out.className = 'test-result ok';
      out.textContent = '200 · 812 ms · allowance 0.0004 · model glm-5.3';
    }, 1400);
  });

  /* ---------- settings: save chain ---------- */
  $('#saveChain')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const old = btn.textContent;
    btn.textContent = '已保存';
    setTimeout(() => { btn.textContent = old; }, 1600);
  });

  /* ---------- evidence filters ---------- */
  const counts = { signal: 24, platform: 11, hand: 17, price: 3 };
  $$('.chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('is-active');
      const active = chips => chips.reduce((n, c) => Math.min(n, counts[c.dataset.filter]), 99);
      const on = $$('.chip[data-filter].is-active');
      const count = on.length ? active(on) : counts.signal;
      $('#evCount').textContent = count;
    });
  });

  /* ---------- report toc ---------- */
  const observeSections = () => {
    const links = $$('.toc-item');
    const secs = links.map(l => document.querySelector(l.getAttribute('href'))).filter(Boolean);
    if (!secs.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        links.forEach(l => l.classList.toggle('is-active', l.getAttribute('href') === `#${en.target.id}`));
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    secs.forEach(s => io.observe(s));
  };

  /* initial */
  animateBars();
  if (document.querySelector('.screen.is-active')?.dataset.screen === 'chat') {
    started = true;
    revealAnswer();
  }
})();
