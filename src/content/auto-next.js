/**
 * auto-next.js — 「滚动到底自动加载下一章/下一页」控制器。
 *
 * ## 设计要点（每一条都对应一个真实的失败模式）
 *
 * 1. **必须在 background 抓取**：MV3 下 content script 的 fetch 受页面 CORS 限制，
 *    所以统一走 runtime.sendMessage → background（见 shared/fetch-page.js）。
 *    本模块通过 `deps.fetchPage` 注入，便于测试时替换。
 *
 * 2. **URL 去重是防死循环的关键**：小说站常有「下一章」指向自身、或两页互指的情况。
 *    已访问的 URL 全部记入 seen 集合，重复即停止，避免无限加载。
 *
 * 3. **串行 + 在途标记**：滚动事件触发极频繁，必须防止并发抓取同一页。
 *    用 `loading` 标记保证同一时刻只有一次加载。
 *
 * 4. **连续失败熔断**：站点结构不符预期时，不要在每次滚动时反复重试。
 *    连续失败达到阈值即停止，并把状态告知用户。
 *
 * 5. **内容去重**：即使 URL 不同，正文也可能重复（站点用不同 URL 指同一内容）。
 *    用正文指纹比对，指纹相同则视作已到末尾。
 *
 * 6. **用户可关闭**：任何失败都不应让阅读器不可用，因此错误只降级为「停止加载 + 提示」。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    root.AutoNext = mod;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * 连续失败多少次后**暂停**（不是永久停止）。
   *
   * 为什么是「暂停」而不是「停止」：实测遇到小说站的反爬限流——
   * 同一站点同一时刻，有的 URL 返回 200、有的返回 403。
   * 若此时永久停止，用户就再也用不了自动翻页，只能退出重进。
   * 改为暂停 + 冷却后允许重试，更符合真实站点的行为。
   */
  const MAX_CONSECUTIVE_FAILURES = 3;

  /** 失败后暂停多久才允许重试（毫秒）。 */
  const RETRY_COOLDOWN_MS = 8000;

  /**
   * 预加载延迟（毫秒）。进入阅读模式后等这么久再开始预取下一章，
   * 避免和首屏渲染、正文提取抢主线程。
   */
  const PREFETCH_DELAY_MS = 1200;

  /** 单次会话最多自动加载多少页（防止极端情况下无限滚动）。 */
  const MAX_PAGES = 100;

  /**
   * 计算正文的内容指纹，用于识别「不同 URL 但内容相同」的页面。
   * 取前若干可见字符即可，够稳且便宜。
   *
   * @param {Element|string} content
   */
  function contentFingerprint(content) {
    const text = typeof content === "string"
      ? content
      : (content && (content.textContent || "")) || "";
    return text.replace(/[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]+/g, "").slice(0, 200);
  }

  /** 规范化 URL：去掉 hash，便于去重（同一页的不同锚点应视为同一页）。 */
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.href;
    } catch (_) {
      return String(url || "");
    }
  }

  /**
   * 创建自动翻页控制器。
   *
   * 支持两种续页模式（自动降级）：
   *
   *   1. **追加模式**（首选）：抓取下一页 HTML，无缝追加到当前阅读视图。
   *      体验最好——不刷新、位置连续。
   *   2. **导航模式**（降级）：直接让浏览器导航到下一页，页面加载后自动
   *      重新进入阅读模式。
   *
   * 为什么需要导航模式：实测发现不少站点启用 Cloudflare 人机验证
   * （响应头 `Cf-Mitigated: challenge`）。扩展发出的 fetch 会被 CF 挑战
   * 直接拒绝（实测 5 种请求变体——含携带完整 cookie 的 `credentials: include`
   * ——全部 403）。原因是 CF 校验的不只是 cookie，还包括浏览器环境指纹
   * （Sec-CH-UA 客户端提示、TLS 指纹、JS 挑战痕迹），扩展请求在这些维度上
   * 无法匹配。
   *
   * 而**真实浏览器导航**（和用户手点链接一样）带完整指纹，CF 会正常放行。
   * 因此遇到抓取被拦时，自动改用导航模式即可继续阅读。
   *
   * @param {object} deps
   * @param {Function} deps.fetchPage   (url) => Promise<{ok, html, charset, finalUrl}|{ok:false, reason}>
   * @param {Function} deps.parseArticle (html, url) => article 结果（与 extractArticle 同形状）
   * @param {Function} deps.appendArticle (article) => void  把内容追加进阅读视图
   * @param {Function} [deps.navigateTo] (url) => void  导航到指定 URL（降级模式用）
   * @param {Function} [deps.onStatus]  (status) => void  状态变化回调（供 UI 显示）
   * @param {Function} [deps.onEnd]     () => void  到达末尾
   * @param {boolean}  [deps.allowNavigate] 是否允许降级为导航模式（默认 true）
   * @param {number}   [deps.prefetchDelayMs] 预加载延迟（默认 PREFETCH_DELAY_MS）；
   *   测试里传 0 可让预加载立即发生，避免依赖真实计时
   */
  function createAutoNext(deps) {
    const fetchPage = deps.fetchPage;
    const parseArticle = deps.parseArticle;
    const appendArticle = deps.appendArticle;
    const navigateTo = deps.navigateTo || null;
    const onStatus = deps.onStatus || function () {};
    const onEnd = deps.onEnd || function () {};
    const allowNavigate = deps.allowNavigate !== false;
    const prefetchDelayMs = typeof deps.prefetchDelayMs === "number"
      ? deps.prefetchDelayMs
      : PREFETCH_DELAY_MS;

    /** 已访问过的 URL（规范化后）。 */
    let seen = new Set();
    /** 已加载内容的指纹。 */
    let fingerprints = new Set();
    /** 下一个待加载的链接。 */
    let nextLink = null;
    /** 是否正在加载（防并发）。 */
    let loading = false;
    /** 连续失败次数。 */
    let failures = 0;
    /** 本次会话已加载页数。 */
    let loadedCount = 0;
    /**
     * 冷却截止时间戳。失败达阈值或遇到限流(403/429)时设置，
     * 冷却期内不再尝试；到期后自动恢复（而不是永久放弃）。
     */
    let cooldownUntil = 0;
    /** 是否已停止（到达末尾 / 手动停止）。注意：失败不再导致永久停止。 */
    let stopped = false;
    /** 是否启用。 */
    let enabled = true;
    /** 挂起状态：用完即弃的加载中/失败提示。 */
    let lastStatus = { state: "idle" };

    /**
     * 预加载缓存：{ url, article, finalUrl } 或 null。
     * 命中它就能在滚动到底时**零等待**插入内容。
     */
    let prefetched = null;
    /** 是否正在预加载（防并发）。 */
    let prefetching = false;
    /** 已排程但未执行的预加载定时器/句柄。 */
    let prefetchTimer = null;

    /** 记录一个已读页面。 */
    function markSeen(url, content) {
      seen.add(normalizeUrl(url));
      const fp = contentFingerprint(content);
      if (fp) fingerprints.add(fp);
    }

    /**
     * 初始化/重置：用首屏文章建立基线。
     * @param {object} article 首屏 extractArticle 的结果
     */
    function reset(article) {
      seen = new Set();
      fingerprints = new Set();
      failures = 0;
      loadedCount = 0;
      stopped = false;
      loading = false;
      cooldownUntil = 0;
      prefetched = null;
      prefetching = false;
      cancelScheduledPrefetch();
      nextLink = (article && article.nextLink) || null;

      const url = (article && article.sourceUrl) || currentUrl;
      if (url) markSeen(url, article && article.content);

      if (!nextLink) {
        stopped = true;
        setStatus({ state: "end", message: "未找到下一章" });
      } else {
        setStatus({ state: "idle" });
        // 立即开始预加载下一章：用户还在读这一页时就把它备好，
        // 读到底即可零等待续上（这正是消除顿挫感的关键）。
        schedulePrefetch();
      }
    }

    /** 首屏来源 URL，由外部设置（用于去重）。 */
    let currentUrl = "";

    function setStatus(s) {
      lastStatus = s;
      onStatus(s);
    }

    /**
     * 抓取并解析一个页面（不追加）。
     *
     * 抽成独立函数是为了让**预加载**与**实际加载**共用同一套逻辑：
     * 预加载只是「提前调用它并把结果存起来」，读到底时直接取用。
     *
     * @returns {Promise<{ok:true, article:object, finalUrl:string}
     *                  |{ok:false, reason:string, status:number}>}
     */
    async function fetchAndParse(url) {
      const res = await fetchPage(url);

      if (!res || !res.ok) {
        return {
          ok: false,
          reason: (res && res.reason) || "unknown",
          status: (res && res.status) || 0,
        };
      }

      // 用最终 URL（可能经过重定向）做去重
      const finalUrl = res.finalUrl || url;
      const article = parseArticle(res.html, finalUrl);

      if (!article || !article.ok) {
        return { ok: false, reason: (article && article.reason) || "parse-failed", status: 0 };
      }

      return { ok: true, article, finalUrl };
    }

    /**
     * 预加载下一章（**不追加**，只抓取并缓存）。
     *
     * ## 为什么需要预加载
     *
     * 原实现是「读到底部才开始抓取」，用户会看到明显的加载顿挫
     *（网络往返 + 解析 + 清理通常几百毫秒到数秒）。
     * 改为在用户**还在读当前章时**就提前取好，读到底直接插入，几乎零等待。
     *
     * ## 设计要点
     *
     * · **静默**：不显示「正在加载」状态，不打扰阅读；失败也不提示
     *   （真正的失败留到 maybeLoadNext 时再报告，那时才有意义）。
     * · **不并发**：同一时刻只预加载一页；已有匹配的缓存则不重复抓取。
     * · **可失效**：缓存带上目标 URL，nextLink 变化后旧缓存自动作废。
     * · **让路**：用 requestIdleCallback 之类的空闲时机触发，
     *   避免与首屏渲染抢资源。
     */
    async function prefetch() {
      if (!enabled || stopped) return { prefetched: false, reason: "disabled" };
      if (cooldownUntil && Date.now() < cooldownUntil) {
        return { prefetched: false, reason: "cooldown" };
      }
      if (!nextLink || !nextLink.url) return { prefetched: false, reason: "no-next-link" };
      if (loadedCount >= MAX_PAGES) return { prefetched: false, reason: "max-pages" };

      const targetUrl = nextLink.url;

      // 已有同一目标的缓存 → 无需重复抓取
      if (prefetched && prefetched.url === targetUrl) {
        return { prefetched: true, reason: "cached" };
      }
      // 已在预加载中 → 不并发
      if (prefetching) return { prefetched: false, reason: "busy" };

      // 已访问过 → 不预加载（避免循环）
      if (seen.has(normalizeUrl(targetUrl))) return { prefetched: false, reason: "already-seen" };

      prefetching = true;
      try {
        const result = await fetchAndParse(targetUrl);
        // 期间 nextLink 可能已变（例如用户已读完并加载了下一章）
        if (nextLink && nextLink.url === targetUrl) {
          prefetched = result.ok
            ? { url: targetUrl, article: result.article, finalUrl: result.finalUrl }
            : null;
        }
        return { prefetched: Boolean(prefetched), reason: result.ok ? "ok" : result.reason };
      } catch (_) {
        return { prefetched: false, reason: "exception" };
      } finally {
        prefetching = false;
      }
    }

    /** 丢弃当前缓存（nextLink 变化或加载失败时调用）。 */
    function clearPrefetch() {
      prefetched = null;
    }

    /**
     * 滚动接近底部时调用。若满足条件则加载下一章。
     *
     * 优先使用预加载好的缓存 —— 命中时无需网络等待，直接插入。
     *
     * @returns {Promise<{loaded:boolean, reason?:string}>}
     */
    async function maybeLoadNext() {
      if (!enabled || stopped || loading) {
        return { loaded: false, reason: stopped ? "stopped" : loading ? "busy" : "disabled" };
      }
      // 失败冷却期内不再尝试，避免在站点限流时反复撞墙。
      if (cooldownUntil && Date.now() < cooldownUntil) {
        return { loaded: false, reason: "cooldown" };
      }
      if (!nextLink || !nextLink.url) {
        stopped = true;
        setStatus({ state: "end" });
        onEnd();
        return { loaded: false, reason: "no-next-link" };
      }
      if (loadedCount >= MAX_PAGES) {
        stopped = true;
        setStatus({ state: "end", message: `已达上限 ${MAX_PAGES} 页` });
        onEnd();
        return { loaded: false, reason: "max-pages" };
      }

      const targetUrl = nextLink.url;

      // 已访问过 → 说明出现了循环（或指向自身），停止。
      if (seen.has(normalizeUrl(targetUrl))) {
        stopped = true;
        setStatus({ state: "end", message: "已到末尾" });
        onEnd();
        return { loaded: false, reason: "already-seen" };
      }

      // ---- 快路径：命中预加载缓存，立即插入 ----
      if (prefetched && prefetched.url === targetUrl) {
        const cached = prefetched;
        prefetched = null;
        const appended = appendParsed(cached.article, cached.finalUrl);
        // 插入后立刻为「再下一章」做预加载，保持始终领先一章
        schedulePrefetch();
        return appended;
      }

      loading = true;
      setStatus({ state: "loading", message: `正在加载第 ${loadedCount + 2} 页…` });

      try {
        const result = await fetchAndParse(targetUrl);

        if (!result.ok) {
          const reason = result.reason;
          const detail = describeFetchError(reason);
          const status = result.status;

          // ---- 降级路径：抓取失败时改用真实浏览器导航 ----
          //
          // 只要**抓取这条路走不通**，就应该尝试导航。实测遇到过两类失败：
          //
          //   · HTTP 403/429（Cloudflare 挑战，`Cf-Mitigated: challenge`）
          //   · 直接抛异常（network-error）——例如站点返回
          //     `Cross-Origin-Resource-Policy: same-origin`，
          //     而内容脚本的 fetch 起源是扩展(moz-extension://)，
          //     对页面而言是跨源请求，会在 CORP 检查阶段被直接终止，
          //     根本到不了服务器，因此**没有 HTTP 状态码**。
          //
          // 导航是顶层文档加载，不受 CORP/COEP/CORS 影响，是最可靠的兜底。
          const canFallbackToNavigation = allowNavigate && navigateTo;
          if (canFallbackToNavigation) {
            stopped = true;   // 本页会话结束，新页面会重建
            setStatus({
              state: "loading",
              message: status === 403 || status === 429
                ? "该站点需人工验证，正在跳转下一页…"
                : "无法直接加载，正在跳转下一页…",
            });
            // 给状态条一点展示时间，避免用户觉得「莫名其妙跳走了」
            setTimeout(() => {
              try {
                navigateTo(targetUrl);
              } catch (err) {
                setStatus({ state: "error", message: "跳转失败：" + String((err && err.message) || err) });
              }
            }, 350);
            return { loaded: false, reason: "navigating" };
          }

          failures++;

          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            // 注意是「暂停」而非永久停止：给冷却时间，之后仍可继续。
            cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
            failures = 0;
            setStatus({
              state: "error",
              message: `${detail}；已暂停自动加载，稍后滚动可重试`,
            });
            return { loaded: false, reason };
          }

          setStatus({ state: "error", message: detail });
          return { loaded: false, reason };
        }

        return appendParsed(result.article, result.finalUrl);
      } catch (err) {
        failures++;
        const message = String((err && err.message) || err);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          // 同样是「暂停 + 冷却」，不是永久停止
          cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
          failures = 0;
          setStatus({
            state: "error",
            message: `${message}；已暂停自动加载，稍后滚动可重试`,
          });
        } else {
          setStatus({ state: "error", message });
        }
        return { loaded: false, reason: "exception" };
      } finally {
        loading = false;
      }
    }

    /**
     * 把已解析好的文章追加进阅读视图，并更新状态。
     * 预加载快路径与实际加载路径共用（避免两处逻辑漂移）。
     *
     * @returns {{loaded:boolean, reason?:string}}
     */
    function appendParsed(article, finalUrl) {
      // 内容指纹相同 → 站点用不同 URL 指向同一内容，视为末尾。
      const fp = contentFingerprint(article.content);
      if (fp && fingerprints.has(fp)) {
        stopped = true;
        setStatus({ state: "end", message: "已到末尾（内容重复）" });
        onEnd();
        return { loaded: false, reason: "duplicate-content" };
      }

      // 重定向到已访问过的页面 → 视为循环
      if (seen.has(normalizeUrl(finalUrl))) {
        stopped = true;
        setStatus({ state: "end", message: "已到末尾" });
        onEnd();
        return { loaded: false, reason: "redirect-loop" };
      }

      appendArticle(article);
      markSeen(finalUrl, article.content);
      loadedCount++;
      failures = 0;

      // 更新下一个链接；旧缓存对新目标无效，必须清掉
      nextLink = article.nextLink || null;
      clearPrefetch();

      if (!nextLink) {
        stopped = true;
        setStatus({ state: "end", message: "已到最后一页" });
        onEnd();
      } else {
        setStatus({ state: "idle", message: `已加载 ${loadedCount} 页` });
      }

      return { loaded: true };
    }

    /**
     * 在空闲时机安排一次预加载。
     *
     * 用 requestIdleCallback（不支持则退回 setTimeout），
     * 避免与首屏渲染、滚动等主线程任务抢时间。
     */
    function schedulePrefetch(delayMs) {
      if (!enabled || stopped) return;
      if (prefetchTimer) return;   // 已有排程

      const run = () => {
        prefetchTimer = null;
        prefetch().catch(() => {});
      };

      const delay = typeof delayMs === "number" ? delayMs : prefetchDelayMs;

      // 延迟为 0 时同步排队（用 setTimeout 0），便于测试即时观察。
      // 浏览器里默认走 requestIdleCallback，避免与首屏渲染抢主线程。
      if (delay <= 0 || typeof requestIdleCallback !== "function") {
        prefetchTimer = setTimeout(run, Math.max(0, delay));
      } else {
        prefetchTimer = requestIdleCallback(run, { timeout: delay + 2000 });
      }
    }

    /** 取消已排程但尚未执行的预加载。 */
    function cancelScheduledPrefetch() {
      if (!prefetchTimer) return;
      try {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(prefetchTimer);
        else clearTimeout(prefetchTimer);
      } catch (_) {
        /* 忽略 */
      }
      prefetchTimer = null;
    }

    /** 把抓取失败原因转成用户能看懂的话。 */
    function describeFetchError(reason) {
      const MAP = {
        timeout: "加载超时",
        "http-error": "服务器返回错误",
        "network-error": "网络错误",
        // TLS 握手失败：常见于老旧站点只监听 HTTP，
        // 而请求被升级成 HTTPS（见 manifest 的 CSP 说明）
        "tls-error": "HTTPS 连接失败（该站点可能只支持 HTTP）",
        "dns-error": "域名无法解析",
        refused: "连接被拒绝",
        "too-large": "页面过大，已跳过",
        "bad-url": "链接无效",
        "no-fetcher": "抓取模块不可用",
        "no-runtime": "扩展消息通道不可用",
        "parse-error": "这一页无法解析为正文",
      };
      return MAP[reason] || "加载失败";
    }

    /** 开关。关闭时不清空进度，重新打开可继续。 */
    function setEnabled(v) {
      enabled = !!v;
      if (!enabled) {
        setStatus({ state: "off" });
      } else if (!stopped) {
        setStatus({ state: "idle" });
      }
    }

    /** 手动停止（用户点「停止」或关闭阅读模式）。 */
    function stop() {
      stopped = true;
      loading = false;
      cancelScheduledPrefetch();
      clearPrefetch();
    }

    return {
      reset,
      maybeLoadNext,
      prefetch,
      schedulePrefetch,
      clearPrefetch,
      cancelScheduledPrefetch,
      setEnabled,
      stop,
      setCurrentUrl: (u) => { currentUrl = u || ""; },
      getState: () => ({
        enabled,
        stopped,
        loading,
        loadedCount,
        failures,
        /** 是否处于失败冷却期 */
        coolingDown: Boolean(cooldownUntil && Date.now() < cooldownUntil),
        cooldownRemainingMs: cooldownUntil ? Math.max(0, cooldownUntil - Date.now()) : 0,
        hasNext: Boolean(nextLink && nextLink.url),
        nextUrl: nextLink ? nextLink.url : null,
        /** 是否已预加载好下一章（命中即可零等待续读） */
        prefetchReady: Boolean(prefetched),
        prefetchUrl: prefetched ? prefetched.url : null,
        status: lastStatus,
        seenCount: seen.size,
      }),
    };
  }

  return {
    MAX_CONSECUTIVE_FAILURES,
    RETRY_COOLDOWN_MS,
    PREFETCH_DELAY_MS,
    MAX_PAGES,
    createAutoNext,
    contentFingerprint,
    normalizeUrl,
  };
});
