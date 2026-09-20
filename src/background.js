/**
 * background.js — 事件页（Firefox MV3 的 background）。
 *
 * 职责：把「工具栏点击」与「快捷键」统一转成一次 toggle 调用。
 *
 * ## 为什么需要 host_permissions（重要，别改回去）
 *
 * 最初只申请了 activeTab，理由是「隐私友好、按需注入」。但实测证明这条路不可靠：
 * 一次用户手势里连续调用 scripting.executeScript 时，activeTab 的临时授予
 * 无法稳定覆盖全部调用，会抛出 `Missing host permission for the tab`。
 * 由于错误只写进控制台，表现就是「点了图标/按了快捷键毫无反应」——极难排查。
 *
 * 对照实验（同一份代码，只改权限）：
 *   只有 activeTab  → TOGGLE_FAIL: Missing host permission for the tab
 *   加上 host 权限  → PROBE_DONE → INJECT_OK → TOGGLE_OK（全链路通过）
 *
 * 因此 manifest 显式声明了 http/https/file 的 host 权限，不再依赖 activeTab 的时序。
 * activeTab 仍然保留，作为兜底（例如将来收窄 host_permissions 时）。
 *
 * ## 调用次数也压到了最少
 *
 * 旧实现每次都要 probe → inject → toggle 三次 executeScript，放大了权限时序问题。
 * 现在改成「先试一次切换，失败才注入并重试」：
 *   - 已注入页面：1 次调用
 *   - 未注入页面：2 次调用（注入 + 切换）
 */

const api = typeof browser !== "undefined" ? browser : chrome;

/**
 * 统一的日志前缀。
 * 排查「点了没反应」这类问题时，日志是唯一的线索来源——
 * 之前所有错误都只写 console.warn 且信息不足，导致问题被隐藏了很久。
 * 保留这些日志是有意为之：它们成本极低，但能把静默失败变成可诊断的失败。
 */
const LOG_PREFIX = "[澄读]";

console.log(`${LOG_PREFIX} background 已加载，监听器注册中…`);

/** 工具栏图标的默认提示文案（与 manifest 的 default_title 保持一致）。 */
const DEFAULT_TITLE = "进入阅读模式 (Ctrl+Shift+U)";

/**
 * content script 的加载顺序（**唯一事实来源**）。
 *
 * 依赖关系：
 *   dom-utils → clean-blank → extract → prefs/styles/toolbar → auto-next → reader-view → main
 *
 * 注意：
 *   - auto-next 要在 reader-view 之前（main.js 会把两者装配到一起）；
 *   - main.js 必须最后（它负责装配前面所有模块）。
 *
 * 测试（load-order / global-object）会解析这份数组，因此新增模块只需改这里，
 * 不要在测试里另抄一份顺序。
 */
const CONTENT_SCRIPTS = [
  "src/vendor/readability.js",
  "src/content/clean/dom-utils.js",
  "src/content/clean/clean-blank.js",
  "src/content/extract.js",
  "src/content/prefs.js",
  "src/content/styles.js",
  "src/content/toolbar.js",
  "src/content/auto-next.js",
  "src/content/reader-view.js",
  "src/content/main.js",
];

/**
 * 尝试调用页面里已注入的 __reader.toggle()。
 *
 * @returns {Promise<boolean|null>} true/false = 切换结果；null = 页面尚未注入
 */
/**
 * 尝试调用页面里已注入的 __reader.toggle()。
 *
 * 关于 async：`toggle()` 返回 Promise。如果只写 `window.__reader.toggle(f)`
 * 就返回，那么它内部抛出的异常会被 Promise 静默吞掉——表现为
 * 「日志显示注入成功、操作完成，但页面毫无变化」，完全无从排查。
 *
 * 因此这里**必须** await 它，并把结果/错误转成可序列化的普通对象返回，
 * 让 background 侧能真正看到成功还是失败。
 *
 * @returns {Promise<{state:"ok"|"not-injected"|"error", result?:any, error?:string}>}
 */
function tryToggle(tabId, force) {
  return api.scripting
    .executeScript({
      target: { tabId },
      func: async (f) => {
        // 注意：content script 的 isolated world 里 window !== globalThis，
        // 模块与 __reader 挂在 globalThis 上。两处都查一遍以增强兼容。
        const G = typeof globalThis !== "undefined" ? globalThis : window;
        const reader = (G && G.__reader) || (typeof window !== "undefined" && window.__reader) || null;
        if (!(reader && typeof reader.toggle === "function")) {
          // 诊断：把关键状态一起带回 background。
          // 「注入成功但 __reader 不存在」意味着某个模块加载时抛错了，
          // 必须看到到底是哪个模块缺失，否则无从下手。
          return {
            state: "not-injected",
            diag: {
              readerLoaded: Boolean(G.__readerLoaded),
              readerLoadError: G.__readerLoadError || null,
              // 逐个检查模块是否挂上了全局（globalThis 为准）
              modules: {
                Readability: typeof G.Readability,
                CleanDomUtils: typeof G.CleanDomUtils,
                CleanBlank: typeof G.CleanBlank,
                ReaderExtract: typeof G.ReaderExtract,
                ReaderPrefs: typeof G.ReaderPrefs,
                ReaderStyles: typeof G.ReaderStyles,
                ReaderToolbar: typeof G.ReaderToolbar,
                AutoNext: typeof G.AutoNext,
                ReaderView: typeof G.ReaderView,
              },
            },
          };
        }
        try {
          const result = await reader.toggle(f === null ? undefined : f);
          return { state: "ok", result: result === undefined ? null : result };
        } catch (err) {
          // 把页面内的错误带回 background，否则它会消失在 Promise 里
          return {
            state: "error",
            error: (err && (err.stack || err.message)) || String(err),
          };
        }
      },
      args: [force === undefined ? null : force],
    })
    .then((results) => {
      const first = Array.isArray(results) ? results[0] : null;
      const value = first ? first.result : null;
      // executeScript 的返回值必须可序列化；这里做一层防御。
      if (value && typeof value === "object" && value.state) return value;
      return { state: "ok", result: value };
    });
}

/**
 * 注入 content script。
 *
 * 采用「逐个文件顺序注入」而非一次传 9 个 files，原因：
 *   1. 批量注入时若某文件抛错，Firefox 的行为不明确，错误也无法归因到具体文件；
 *   2. 逐个注入可以精确记录「哪个文件失败、为什么失败」，把一次点击变成完整诊断；
 *   3. 注入顺序由我们显式保证，不依赖批量注入的实现细节。
 *
 * 这些脚本每页只在首次激活时注入一次，多几次调用的开销可忽略。
 *
 * @returns {Promise<string[]>} 每个文件的注入结果
 */
async function injectAll(tabId) {
  const report = [];
  for (const file of CONTENT_SCRIPTS) {
    try {
      await api.scripting.executeScript({ target: { tabId }, files: [file] });
      report.push(`${file}=ok`);
    } catch (err) {
      report.push(`${file}=失败(${(err && err.message) || String(err)})`);
    }
  }
  return report;
}

/**
 * 探针：检查已注入脚本到底把模块挂到了哪里。
 *
 * 这是为了验证一个 jsdom 测不出来的假设：content script 里
 * `window` 与 `globalThis` 是否同一个对象。UMD 包装写的是 `root.X = mod`
 * （root 取 globalThis），而 main.js 读的是 `window[name]`；
 * 若两者在真实 Firefox 中不同，模块就会「已加载但读不到」。
 */
function probeGlobals(tabId) {
  return api.scripting
    .executeScript({
      target: { tabId },
      func: () => {
        const names = [
          "Readability", "CleanDomUtils", "CleanBlank", "ReaderExtract",
          "ReaderPrefs", "ReaderStyles", "ReaderToolbar", "AutoNext", "ReaderView",
        ];
        const G = typeof globalThis !== "undefined" ? globalThis : window;
        const onWindow = {};
        const onGlobalThis = {};
        for (const n of names) {
          onWindow[n] = typeof window[n];
          onGlobalThis[n] = typeof G[n];
        }
        return {
          // 关键判据：content script 的 isolated world 里这两者是否相同。
          // 实测在 Firefox 中为 false —— 这就是「模块已加载却读不到」的根因。
          windowIsGlobalThis: window === G,
          selfIsWindow: typeof self !== "undefined" && self === window,
          readerOnGlobalThis: typeof G.__reader,
          readerOnWindow: typeof window.__reader,
          readerLoaded: Boolean(G.__readerLoaded),
          loadError: G.__readerLoadError || null,
          onWindow,
          onGlobalThis,
        };
      },
    })
    .then((results) => {
      const first = Array.isArray(results) ? results[0] : null;
      return first ? first.result : null;
    })
    .catch((err) => ({ probeFailed: (err && err.message) || String(err) }));
}

/** 统一的入口：点击工具栏或按快捷键都走这里。 */
async function toggleReader(tab) {
  if (!tab || tab.id === undefined) {
    console.warn(`${LOG_PREFIX} 未拿到标签页信息，已忽略本次触发`, tab);
    return;
  }

  console.log(`${LOG_PREFIX} 收到触发，标签页 id=${tab.id}，url=${tab.url || "(不可见)"}`);

  try {
    // 第一次尝试：假定页面已注入过。
    let outcome = await tryToggle(tab.id, null);

    if (outcome.state === "not-injected") {
      // 尚未注入：注入整包后强制打开（用户点一次就该看到效果）。
      console.log(`${LOG_PREFIX} 页面尚未注入，正在注入脚本…`);
      const injectReport = await injectAll(tab.id);
      console.log(`${LOG_PREFIX} 逐文件注入结果:\n  ${injectReport.join("\n  ")}`);

      // 注入后立即探针：看模块到底挂到了 window 还是 globalThis。
      const probe = await probeGlobals(tab.id);
      console.log(`${LOG_PREFIX} 探针结果:`, JSON.stringify(probe, null, 1));

      console.log(`${LOG_PREFIX} 脚本注入完成，正在打开阅读模式…`);
      outcome = await tryToggle(tab.id, true);
    }

    // 页面内 toggle() 抛出的错误会通过 state=error 带回来，
    // 必须显式处理，否则「注入成功但页面无变化」将无从解释。
    if (outcome.state === "error") {
      console.error(`${LOG_PREFIX} 阅读模式内部出错：`, outcome.error);
      reportFailure(tab.id, new Error(outcome.error || "阅读模式内部错误"));
      return;
    }

    if (outcome.state === "not-injected") {
      // 逐项打印成扁平字符串：对象在控制台里会被折叠成 {…}，
      // 关键信息（到底哪个模块缺失）就看不到了。
      const diag = outcome.diag || {};
      const mods = diag.modules || {};
      const detail = Object.entries(mods)
        .map(([k, t]) => `${k}=${t}`)
        .join(", ");
      const missing = Object.entries(mods)
        .filter(([, t]) => t === "undefined")
        .map(([k]) => k);

      console.error(`${LOG_PREFIX} ★ 模块加载失败诊断`);
      console.error(`${LOG_PREFIX}   模块状态: ${detail}`);
      console.error(`${LOG_PREFIX}   缺失模块: ${missing.length ? missing.join(", ") : "(无)"}`);
      console.error(`${LOG_PREFIX}   readerLoaded: ${diag.readerLoaded}`);
      console.error(`${LOG_PREFIX}   页面记录的错误: ${diag.readerLoadError || "(无)"}`);

      reportFailure(
        tab.id,
        new Error(missing.length ? `模块未加载：${missing.join(", ")}` : "main.js 未暴露 __reader")
      );
      return;
    }

    clearBadge(tab.id);
    console.log(`${LOG_PREFIX} 操作完成 ✓（toggle 返回 ${JSON.stringify(outcome.result)}）`);
  } catch (err) {
    // 失败必须让用户看见。否则「点了没反应」完全无从排查——
    // 这个教训是有代价的：此前只 console.warn，导致问题被隐藏了很久。
    console.error(`${LOG_PREFIX} 切换阅读模式失败：`, err);
    reportFailure(tab.id, err);
  }
}

/** 在工具栏图标上显示失败标记，让用户能看到发生了什么。 */
function reportFailure(tabId, err) {
  try {
    const message = String((err && err.message) || err || "");
    const isPermission = /permission|host/i.test(message);

    api.action.setBadgeText({ tabId, text: isPermission ? "!" : "×" });
    api.action.setBadgeBackgroundColor({ tabId, color: "#c0392b" });
    api.action.setTitle({
      tabId,
      title: isPermission
        ? "澄读：无法访问此页面。请确认不是 about:/扩展商店等受限页；若刚安装，请重新载入扩展以应用新权限"
        : `澄读：进入阅读模式失败（${message.slice(0, 80)}）。详情见浏览器控制台`,
    });

    // 几秒后自动清除，避免角标长期挂着误导。
    setTimeout(() => clearBadge(tabId), 6000);
  } catch (_) {
    /* 角标只是辅助反馈，失败不应影响主流程 */
  }
}

/** 清除角标，恢复正常提示。 */
function clearBadge(tabId) {
  try {
    api.action.setBadgeText({ tabId, text: "" });
    api.action.setTitle({ tabId, title: DEFAULT_TITLE });
  } catch (_) {
    /* 同上 */
  }
}

// ---------------------------------------------------------------- 消息处理

/**
 * 在**页面主世界（MAIN world）**里抓取目标页。
 *
 * ## 为什么必须用 MAIN world（这是通过 Cloudflare 的关键）
 *
 * 三个可发请求的执行环境，origin 完全不同：
 *
 *   | 环境                    | origin                | 站点看到的             |
 *   |-------------------------|-----------------------|------------------------|
 *   | 内容脚本（ISOLATED）     | `moz-extension://…`   | 跨源，被 CORP/CORS 拦  |
 *   | background（扩展页面）   | `moz-extension://…`   | 跨源，被 CF 挑战 → 403 |
 *   | **页面主世界（MAIN）**   | **页面自身的 origin** | **与页面自己的 AJAX 无异** ✅ |
 *
 * 实测证据（同一站点同一 URL）：
 *   · background 发请求 → 403（`Cf-Mitigated: challenge`）
 *   · 页面主世界发请求   → **200**
 *
 * 因此把抓取代码注入 MAIN world 执行：请求由页面自己发出，自动携带
 * 该源的 cookie（含 cf_clearance）、`Sec-Fetch-Site: same-origin`、
 * 正确的 Referer，且同源不受 CORS/CORP 限制。
 *
 * 代价（MDN 的警告）：MAIN world 中的代码可被页面读取/干扰。
 * 这里只做「取 HTML 文本」这一件事，不传递任何敏感数据，
 * 且抓取结果会经过既有的 sanitize 管线，风险可控。
 *
 * @param {number} tabId
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} 与 FetchPage.fetchPage 相同形状的结果
 */
async function fetchInMainWorld(tabId, url, timeoutMs) {
  if (!api.scripting || !api.scripting.executeScript) {
    return { ok: false, reason: "no-scripting" };
  }

  try {
    const results = await api.scripting.executeScript({
      target: { tabId },
      // 关键：在页面主世界执行，请求 origin 即页面自身
      world: "MAIN",
      args: [url, timeoutMs || 15000],
      func: async (targetUrl, limitMs) => {
        // 这段代码在页面上下文运行，可使用页面自身的 fetch 与编码能力。
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), limitMs) : null;
        try {
          const res = await fetch(targetUrl, {
            credentials: "same-origin",   // 页面自己的 cookie（含 cf_clearance）
            redirect: "follow",
            headers: { Accept: "text/html,application/xhtml+xml" },
            signal: controller ? controller.signal : undefined,
          });

          if (!res.ok) {
            return { ok: false, reason: "http-error", status: res.status };
          }

          const buf = await res.arrayBuffer();
          if (buf.byteLength > 3 * 1024 * 1024) {
            return { ok: false, reason: "too-large", status: res.status };
          }

          const bytes = new Uint8Array(buf);

          // 编码判定：HTTP 头 > HTML meta > UTF-8
          const ctype = res.headers.get("content-type") || "";
          const headerCs = (/charset\s*=\s*["']?([\w-]+)/i.exec(ctype) || [])[1] || null;
          const headText = new TextDecoder("windows-1252").decode(bytes.slice(0, 4096));
          const metaCs = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(headText) || [])[1]
            || (/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(headText) || [])[1]
            || null;

          const ALIAS = { gb2312: "gbk", "gb-2312": "gbk", utf8: "utf-8", latin1: "windows-1252" };
          const norm = (n) => (n ? (ALIAS[String(n).toLowerCase()] || String(n).toLowerCase()) : null);

          let charset = norm(headerCs || metaCs || "utf-8");
          const decode = (bytesIn, enc) => {
            try {
              return new TextDecoder(enc, { fatal: false }).decode(bytesIn);
            } catch (_) {
              return new TextDecoder("windows-1252").decode(bytesIn);
            }
          };

          let html = decode(bytes, charset);
          // 替换字符过多 → 换编码重试（站点声明常与实际不符）
          if ((html.slice(0, 4000).match(/\uFFFD/g) || []).length > 8) {
            const alt = charset === "utf-8" ? "gb18030" : "utf-8";
            const retry = decode(bytes, alt);
            if ((retry.slice(0, 4000).match(/\uFFFD/g) || []).length < 8 || retry.length > html.length) {
              html = retry;
              charset = alt;
            }
          }

          return { ok: true, html, charset, finalUrl: res.url || targetUrl };
        } catch (err) {
          const msg = String((err && err.message) || err);
          const aborted = err && err.name === "AbortError";
          return { ok: false, reason: aborted ? "timeout" : "network-error", message: msg };
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    });

    const first = Array.isArray(results) ? results[0] : null;
    if (!first || !first.result) {
      return { ok: false, reason: "main-world-empty" };
    }
    return first.result;
  } catch (err) {
    const message = String((err && err.message) || err);
    console.warn(`${LOG_PREFIX} MAIN world 抓取失败: ${message}`);
    return { ok: false, reason: "main-world-error", message };
  }
}

/**
 * 处理来自 content script 的抓取请求（自动加载下一章用）。
 *
 * 抓取顺序：
 *   1. **页面主世界**（首选）—— 请求 origin 即页面自身，能通过 Cloudflare
 *   2. **background 特权抓取**（兜底）—— 跨域、或主世界注入失败时
 *
 * 两者都失败时，由 content script 侧的 auto-next 控制器降级为真实导航。
 */
function registerMessageHandler() {
  if (!api.runtime || !api.runtime.onMessage) {
    console.warn(`${LOG_PREFIX} runtime.onMessage 不可用，自动翻页将无法抓取页面`);
    return;
  }

  const fetcher = (typeof globalThis !== "undefined" && globalThis.FetchPage) || null;

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "cd-fetch-page") return undefined;

    const url = message.url;
    const tabId = sender && sender.tab && sender.tab.id;
    console.log(`${LOG_PREFIX} 收到抓取请求: ${url}（tab ${tabId}）`);

    (async () => {
      // ---- 1) 优先在页面主世界抓取（可复用页面会话，能过 Cloudflare）----
      if (tabId !== undefined) {
        const mainResult = await fetchInMainWorld(tabId, url, message.timeoutMs);
        if (mainResult && mainResult.ok) {
          console.log(
            `${LOG_PREFIX} 主世界抓取成功: ${url}（编码 ${mainResult.charset}，${mainResult.html.length} 字符）`
          );
          sendResponse(mainResult);
          return;
        }
        console.log(
          `${LOG_PREFIX} 主世界抓取失败（${mainResult && mainResult.reason}），改用 background 抓取`
        );
      }

      // ---- 2) 兜底：background 特权抓取 ----
      if (!fetcher) {
        sendResponse({ ok: false, reason: "no-fetcher" });
        return;
      }
      try {
        const result = await fetcher.fetchPage(url, {
          referer: message.referer,
          timeoutMs: message.timeoutMs,
        });
        console.log(
          `${LOG_PREFIX} background 抓取${result.ok ? "成功" : "失败"}: ${url}` +
            (result.ok ? `（${result.html.length} 字符）` : `（${result.reason}）`)
        );
        sendResponse(result);
      } catch (err) {
        console.error(`${LOG_PREFIX} background 抓取异常: ${url}`, err);
        sendResponse({ ok: false, reason: "exception", message: String((err && err.message) || err) });
      }
    })();

    // 返回 true 以保持消息通道打开，等待异步 sendResponse。
    return true;
  });

  console.log(`${LOG_PREFIX} 抓取消息处理器已注册（主世界优先，background 兜底）`);
}

// ---------------------------------------------------------------- 事件绑定

// 注：manifest 中不能给 action 配 default_popup，否则 onClicked 不会触发。
api.action.onClicked.addListener(toggleReader);

registerMessageHandler();

api.commands.onCommand.addListener((command) => {
  console.log(`${LOG_PREFIX} 收到快捷键命令：${command}`);
  if (command !== "toggle-reader") return;
  api.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => toggleReader(tabs && tabs[0]))
    .catch((err) => console.error(`${LOG_PREFIX} 无法获取当前标签页：`, err));
});

console.log(`${LOG_PREFIX} 监听器注册完毕，等待点击或快捷键…`);
