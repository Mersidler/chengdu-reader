/**
 * main.js — content script 入口（在所有模块之后加载）。
 *
 * 职责：
 *   1. 注入守卫：防止重复注入导致事件监听器叠加；
 *   2. 编排：提取正文 → 打开阅读视图 → 绑定快捷键/Esc；
 *   3. 对外暴露 globalThis.__reader，供 background 在已注入时直接调用 toggle。
 *
 * ## 为什么全程用 globalThis 而不是 window（重要，别改回去）
 *
 * 这是本项目最难排查的一个 bug，实测确认：
 * 在 Firefox 的 content script **isolated world** 里，`window !== globalThis`。
 *
 * 所有模块的 UMD 包装都写 `root.X = mod`，其中 root 取 `globalThis`
 * （因为 `typeof globalThis !== "undefined"` 优先于 `this`），
 * 所以模块挂在 **globalThis** 上。而这里原先读的是 `window[name]` → 全部 undefined，
 * 于是报「依赖模块未加载」。
 *
 * 更隐蔽的是：`executeScript({func})` 也在同一个 isolated world 执行，
 * 从它里面探测能看到 `globalThis.Readability` 等确实存在，但 `window.Readability`
 * 是 undefined —— 这个不对称就是定位的关键证据。
 *
 * jsdom 环境里 `window === globalThis`，所以单元测试**测不出这个差异**。
 * 结论：content script 里访问共享全局，一律用 globalThis。
 */
(function () {
  "use strict";

  /** content script 里模块实际挂载的全局对象。 */
  const G = globalThis;

  // 兼容：若某些环境把模块挂到了 window（例如手动在页面里加载脚本），
  // 则把 window 上的同名属性补到 G 上，保证后续读取一致。
  try {
    if (typeof window !== "undefined" && window !== G) {
      for (const name of [
        "Readability", "CleanDomUtils", "CleanBlank", "ReaderExtract",
        "ReaderPrefs", "ReaderStyles", "ReaderToolbar", "AutoNext", "ReaderView",
      ]) {
        if (G[name] === undefined && window[name] !== undefined) G[name] = window[name];
      }
    }
  } catch (_) {
    /* 补挂失败不影响主流程 */
  }

  /** 记录加载期错误，供 background 诊断（见 background.js 的 tryToggle）。 */
  function recordError(err) {
    try {
      G.__readerLoadError = (err && (err.stack || err.message)) || String(err);
      console.error("[澄读] main.js 加载失败：", err);
    } catch (_) {
      /* 记录失败不应再抛错 */
    }
  }

  // ------------------------------------------------------------ 注入守卫
  // 放在最前面：background 每次点击都会尝试注入，重复注入会让监听器叠加。
  //
  // 注意守卫的判定条件必须是 __reader（真正就绪的标志），而不是 __readerLoaded。
  // 曾经写成「先置 __readerLoaded = true，再装配」——一旦装配过程中抛错，
  // __readerLoaded 已是 true 但 __reader 不存在，后续注入会被守卫挡住，
  // 形成永久死锁，且错误只在页面控制台可见、background 侧完全看不到。
  if (G.__reader) return;

  // 逐个校验依赖模块，缺任何一个都明确报出来（而不是抛一个看不懂的 TypeError）。
  const REQUIRED = [
    "Readability",
    "CleanDomUtils",
    "CleanBlank",
    "ReaderExtract",
    "ReaderPrefs",
    "ReaderStyles",
    "ReaderToolbar",
    "AutoNext",
    "ReaderView",
  ];
  const missing = REQUIRED.filter((name) => !G[name]);
  if (missing.length) {
    recordError(
      new Error(`依赖模块未加载：${missing.join(", ")}。脚本注入顺序可能不正确，或被页面 CSP 阻断。`)
    );
    return;
  }

  const { ReaderExtract, ReaderView, ReaderToolbar, ReaderPrefs } = G;

  /** 已加载的偏好（进入阅读模式前先取一次）。 */
  const prefs = Object.assign({}, ReaderPrefs.DEFAULTS);

  /**
   * 用户是否已经改过设置。
   *
   * 为什么需要：ReaderPrefs.load() 是异步的，若在它 resolve 之前用户就点了
   * 某个控件，load 的结果回来会把用户的改动**覆盖**掉（实测踩过：
   * 打开阅读模式后立刻关闭空行清理，约 400ms 后被存储里的旧值改回开启）。
   * 用这个标记确保「用户的显式操作」永远优先于「启动时的读取」。
   */
  let prefsDirty = false;

  /** 偏好加载完成的 promise，供 toggle 等待，保证首次进入即用上已保存的设置。 */
  const prefsReady = ReaderPrefs.load()
    .then((loaded) => {
      if (!prefsDirty) Object.assign(prefs, loaded);
    })
    .catch(() => {});

  /** 保存偏好（防抖：连续点按钮只写一次盘）。 */
  let persistTimer = null;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      ReaderPrefs.save(prefs).catch(() => {});
    }, 350);
  }

  /** 阅读视图实例。 */
  const view = ReaderView.createReaderView({
    prefs: ReaderPrefs,
    styles: G.ReaderStyles,
    toolbar: ReaderToolbar,
    // 用户改动设置 → 同步到本地 prefs 并持久化。
    onPrefsChange: (next) => {
      prefsDirty = true;
      Object.assign(prefs, next);
      schedulePersist();
    },
    // 切换「空行清理」开关后，需要重新提取一次正文才能看到差异。
    onToggleClean: () => {
      if (!view.isOpen()) return;
      teardownAutoNext();
      view.close();
      // 立即写盘一次，避免防抖窗口内用户就离开了页面。
      ReaderPrefs.save(prefs).catch(() => {});
      // 重新提取并打开（toggle 是异步的，失败会自行提示）。
      toggle(true).catch(() => {});
    },
    // 自动续页开关：即时生效，不需要重新提取。
    onToggleAutoNext: (enabled) => {
      autoNext.setEnabled(enabled);
    },
  });

  // ------------------------------------------------------------ 自动续页

  /**
   * 抓取下一页。
   *
   * ## 顺序：先 background，再交给 auto-next 降级为导航
   *
   * 这里曾尝试「在页面上下文做同源抓取」以复用会话（绕过 Cloudflare）。
   * 实测**行不通**，原因是一个容易搞错的点：
   * **内容脚本运行在扩展的 origin（`moz-extension://`），对页面而言并非同源。**
   * 因此：
   *   · `credentials: "same-origin"` 不会带上页面域的 cookie；
   *   · 站点若返回 `Cross-Origin-Resource-Policy: same-origin`，
   *     该请求会在 CORP 检查阶段被直接终止，**连服务器都到不了**，
   *     所以表现为「无状态码的网络错误」而不是 403。
   *
   * 结论：跨源抓取只能交给 background（有 host 权限）；
   * 若 background 也被防护拦下，则由 auto-next 控制器降级为**真实导航**
   * ——顶层文档加载不受 CORP/COEP/CORS 限制，是唯一可靠的兜底。
   *
   * @param {string} url
   */
  function fetchPageSmart(url) {
    // 统一交给 background：只有它具备跨源特权。
    // 失败时的降级由 auto-next 控制器负责（见其 navigateTo）。
    return fetchPageViaBackground(url);
  }

  /**
   * 通过 background 抓取（跨域场景）。
   *
   * MV3 下 content script 的**跨域** fetch 受页面 CORS 约束，
   * 而 host_permissions 对 content script 无效；只有 background 有跨域特权。
   *
   * @param {string} url
   */
  function fetchPageViaBackground(url) {
    return new Promise((resolve) => {
      const runtime = (typeof browser !== "undefined" && browser.runtime) ||
        (typeof chrome !== "undefined" && chrome.runtime) || null;

      if (!runtime || !runtime.sendMessage) {
        resolve({ ok: false, reason: "no-runtime" });
        return;
      }

      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      try {
        runtime.sendMessage({ type: "cd-fetch-page", url }, (response) => {
          // Firefox 的 sendMessage 回调在出错时会带 runtime.lastError
          const lastError = runtime.lastError;
          if (lastError) {
            done({ ok: false, reason: "message-error", message: String(lastError.message || lastError) });
            return;
          }
          done(response || { ok: false, reason: "empty-response" });
        });
      } catch (err) {
        done({ ok: false, reason: "exception", message: String((err && err.message) || err) });
      }
    });
  }

  /**
   * 把抓取到的 HTML 解析成与 extractArticle 同形状的结果。
   * 复用 extract 的 documentFromHtml（含 baseURI 修复）+ extractArticle。
   */
  function parseFetchedPage(html, url) {
    try {
      const doc = ReaderExtract.documentFromHtml(html, url, document);
      return ReaderExtract.extractArticle(doc, {
        cleanBlank: prefs.cleanBlank,
        // 自动续页场景下正文较短是正常的（单章可能只有几百字），
        // 因此放宽可读性判定，否则短章节会被拒绝。
        force: true,
      });
    } catch (err) {
      return { ok: false, reason: "parse-error", error: String((err && err.message) || err) };
    }
  }

  const autoNext = G.AutoNext.createAutoNext({
    // 三级降级：同源抓取 → background 抓取 → 真实导航（见 fetchPageSmart）
    fetchPage: fetchPageSmart,
    parseArticle: parseFetchedPage,
    appendArticle: (article) => view.appendArticle(article),
    onStatus: (status) => view.setStatus(status),
    // 降级路径：抓取被 Cloudflare 等防护拦下时，改用真实浏览器导航。
    // 真实导航带完整浏览器指纹，会被正常放行（相当于用户手点「下一章」）。
    // 页面加载后由 main.js 检测「阅读模式待恢复」标记，自动重新进入阅读模式。
    navigateTo: navigateToNextPage,
  });

  /** 跨页续读的会话标记 key（存 sessionStorage，随标签页生命周期）。 */
  const RESUME_KEY = "__chengdu_resume_reader";

  /**
   * 导航到下一页，并留下「回来时自动重进阅读模式」的标记。
   *
   * 为什么用 sessionStorage：它按标签页隔离、随标签页关闭而清除，
   * 正好符合「同一个标签页里连续阅读」的语义，也不会污染其他标签页。
   */
  function navigateToNextPage(url) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({
        at: Date.now(),
        from: location.href,
      }));
    } catch (_) {
      /* 隐私模式等场景可能禁用 sessionStorage，此时只是失去自动恢复 */
    }
    // 用真实导航（等同于用户点击链接），带完整浏览器指纹
    location.assign(url);
  }

  /**
   * 检查是否有「待恢复阅读模式」的标记。
   * 页面加载完成时调用；若有则自动进入阅读模式。
   *
   * 只在标记较新（60 秒内）时恢复，避免用户很久之后再打开该标签页
   * 时莫名其妙进入阅读模式。
   */
  function maybeResumeReader() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(RESUME_KEY);
      if (raw) sessionStorage.removeItem(RESUME_KEY);
    } catch (_) {
      return;
    }
    if (!raw) return;

    let info = null;
    try {
      info = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!info || typeof info.at !== "number") return;
    if (Date.now() - info.at > 60000) return;   // 太旧，忽略

    // 等页面稳定后再进入阅读模式
    setTimeout(() => {
      toggle(true).catch(() => {});
    }, 120);
  }

  /** 滚动监听退订函数（每次打开阅读模式重新绑定）。 */
  let scrollUnsub = null;

  /** 为一个已打开的会话装配自动续页。 */
  function setupAutoNext(article) {
    autoNext.setCurrentUrl(location.href);
    autoNext.reset(Object.assign({}, article, { sourceUrl: location.href }));
    autoNext.setEnabled(prefs.autoLoadNext !== false);

    if (scrollUnsub) {
      scrollUnsub();
      scrollUnsub = null;
    }
    scrollUnsub = view.onScrollNearBottom(() => {
      autoNext.maybeLoadNext().catch(() => {});
    }, 600);
  }

  /** 拆掉自动续页（退出阅读模式时）。 */
  function teardownAutoNext() {
    if (scrollUnsub) {
      scrollUnsub();
      scrollUnsub = null;
    }
    autoNext.stop();
  }

  /**
   * 关闭阅读模式的唯一入口。
   *
   * 统一走这里是为了保证「自动续页的滚动监听与状态条」一定被清理干净。
   * 之前有多个地方直接调 view.close()，新增清理项后很容易漏掉某一处。
   */
  function closeReader() {
    teardownAutoNext();
    view.close();
  }

  /**
   * 键盘处理：只负责 Esc 退出。
   *
   * 这里**故意不处理** Ctrl+Shift+U 之类的切换快捷键。原因：
   * 切换由 manifest 的 commands + background 的 onCommand 负责，
   * 若 content script 再自己监听一次同一个键，一次按键可能被处理两遍，
   * 表现为「打开后立刻又关闭」——看起来就像快捷键失灵。
   * 快捷键这件事只允许有一个来源（commands），避免双重触发。
   */
  function handleKeydown(e) {
    if (e.key === "Escape" && view.isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      closeReader();
    }
  }

  /**
   * 打开或关闭阅读模式。
   *
   * @param {boolean} [force] true 强制打开，false 强制关闭
   * @returns {Promise<boolean>} 打开成功返回 true，关闭返回 false
   *
   * 做成异步的原因：需要等偏好从存储读回来再提取正文，
   * 否则页面刚加载完就点开阅读模式时会用默认设置渲染（用户上次保存的
   * 主题/字号会「不生效一次」）。关闭分支不需要等待，立即完成。
   */
  async function toggle(force) {
    if (force === false || (force === undefined && view.isOpen())) {
      closeReader();
      return false;
    }
    if (view.isOpen()) return true;

    // 等待偏好就绪。prefsReady 内部有 prefsDirty 保护，
    // 不会覆盖用户在等待期间做出的改动。
    await prefsReady;
    if (view.isOpen()) return true;   // 等待期间可能已被再次触发

    const result = ReaderExtract.extractArticle(document, {
      cleanBlank: prefs.cleanBlank,
    });

    if (!result.ok) {
      notifyFailure(result.reason);
      return false;
    }

    // open() 内部会以 silent 方式应用一次偏好（不触发 onPrefsChange），
    // 因此这里不需要再调 applyPrefs，也就不会把「打开」误记成一次设置改动。
    view.open(result, prefs);

    // 装配自动续页（含滚动监听）。放在 open 之后：需要视图已就绪。
    setupAutoNext(result);

    // 记录本次使用的清理开关，供下次进入时沿用。
    schedulePersist();
    return true;
  }

  /** 提取失败时给用户一个明确反馈，而不是静默无反应。 */
  function notifyFailure(reason) {
    const MESSAGES = {
      "not-readerable": "这个页面看起来不像正文内容，无法进入阅读模式。",
      "too-short": "正文内容太短，无需进入阅读模式。",
      "empty-article": "没能在这个页面上识别出正文内容。",
      "parse-error": "正文解析出错了。",
      "no-readability": "正文解析引擎未能加载。",
    };
    toast(MESSAGES[reason] || "无法进入阅读模式。");
  }

  /** 轻量提示条（独立于阅读视图，用最高 z-index 内联样式，避免受页面影响）。 */
  function toast(text) {
    const el = document.createElement("div");
    el.textContent = text;
    el.setAttribute(
      "style",
      [
        "position:fixed", "left:50%", "bottom:32px", "transform:translateX(-50%)",
        "z-index:2147483647", "max-width:min(90vw,26rem)",
        "padding:12px 18px", "border-radius:10px",
        "background:rgba(24,26,30,.94)", "color:#fff",
        "font:14px/1.5 system-ui,-apple-system,'Segoe UI','Noto Sans SC',sans-serif",
        "box-shadow:0 8px 28px rgba(0,0,0,.28)", "pointer-events:none",
        "opacity:0", "transition:opacity .18s ease",
      ].join(";")
    );
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
    });
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  // ------------------------------------------------------------ 初始化

  // 偏好的读取在模块顶部以 prefsReady 启动（并带 prefsDirty 保护），此处不再重复读取。
  // 这里曾有一句 `ReaderPrefs.load().then(loaded => { prefs = loaded })`，
  // 它会在异步返回时整体替换 prefs 对象，把用户在这期间做的改动**覆盖回旧值**
  // （实测：打开阅读模式后立刻关闭空行清理，约 400ms 后又被改回开启）。
  // prefs 现在是 const，从语言层面杜绝这类误赋值。

  document.addEventListener("keydown", handleKeydown, true);

  // 页面被卸载时清理（单页应用换页时避免残留）。
  window.addEventListener("pagehide", () => {
    if (view.isOpen()) closeReader();
  });

  // 若上一页是通过「降级导航」跳过来的，自动恢复阅读模式。
  // 这样在 Cloudflare 站点上，用户读到底部后页面自动跳转，
  // 新页面会自己进入阅读模式，体验是连续的。
  maybeResumeReader();

  /** 对外接口。 */
  G.__reader = {
    toggle,
    close: () => closeReader(),
    isOpen: () => view.isOpen(),
    getPrefs: () => Object.assign({}, prefs),
  };

  // 就绪标记放在最后：只有 __reader 真正存在才算加载成功。
  // 这样即使中途出错，也不会留下「守卫已生效但接口不存在」的死锁状态。
  G.__readerLoaded = true;
})();
