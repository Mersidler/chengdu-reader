/**
 * fetch-page.js — 抓取网页并正确解码（含中文站编码嗅探）。
 *
 * 本模块**同时被 content script 与 background 使用**（因此位于 src/shared/）。
 *
 * ## 该在哪个上下文发请求（重要）
 *
 * 两者的能力不同，因此采用**三级降级**：
 *
 *   1. **content script 同源抓取**（首选）
 *      在页面上下文请求同源 URL，与「网页自身的 AJAX」完全一致：
 *      自动携带该源 cookie、`Sec-Fetch-Site: same-origin`、正确的 Referer，
 *      且同源不受 CORS 限制。**能通过 Cloudflare 等防护**，因为其特征
 *      与站点自身的请求无异。
 *
 *   2. **background 抓取**（跨域时）
 *      MV3 下 content script 的**跨域** fetch 受页面 CORS 约束，
 *      而 host_permissions 对 content script 无效；只有 background 有跨域特权。
 *
 *   3. **真实浏览器导航**（被防护拦截时）
 *      Cloudflare 会挑战扩展发出的请求（实测 5 种变体，含携带完整 cookie 的
 *      `credentials: include`，全部 403）——它校验的是浏览器环境指纹
 *      （Sec-CH-UA 客户端提示、TLS 指纹、JS 挑战痕迹）。
 *      真实导航带完整指纹会被放行，代价是页面刷新。
 *
 * ## 编码问题（中文小说站的高频坑）
 *
 * 大量中文站点仍是 GBK/GB2312 编码，而 `fetch().text()` **一律按 UTF-8 解码**，
 * 结果整页乱码（"锟斤拷"）。因此这里先取 raw bytes，再依据
 * （1）HTTP Content-Type 的 charset、（2）HTML 里的 <meta charset> 判断，
 * 决定用 TextDecoder 以何种编码解码。
 *
 * 运行环境：
 *   - Firefox content script / background：普通脚本，挂到 globalThis.FetchPage
 *   - Node 测试：CommonJS 导出
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    root.FetchPage = mod;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 响应体大小上限：防止误抓大文件把内存撑爆。 */
  const MAX_BYTES = 3 * 1024 * 1024;   // 3 MB
  /** 单次抓取超时。 */
  const TIMEOUT_MS = 15000;

  /** 支持的编码别名 → TextDecoder 认识的名字。 */
  const CHARSET_ALIASES = {
    "gb2312": "gbk",
    "gb-2312": "gbk",
    "gb_2312": "gbk",
    "gbk": "gbk",
    "gb18030": "gb18030",
    "big5": "big5",
    "big-5": "big5",
    "utf8": "utf-8",
    "utf-8": "utf-8",
    "iso-8859-1": "windows-1252",   // HTML 规范里 latin1 实际等同 win-1252
    "latin1": "windows-1252",
  };

  /** 从 HTTP 响应头里取 charset。 */
  function charsetFromHeader(contentType) {
    if (!contentType) return null;
    const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * 从 HTML 字节里嗅探 charset。
   *
   * 只需看开头一段：<meta charset> 按规范必须出现在前 1024 字节内。
   * 用 latin1 解码做正则匹配（任何字节都能对上，不会因编码错误而失败）。
   */
  function charsetFromHtml(bytes) {
    const head = new TextDecoder("windows-1252").decode(bytes.slice(0, 4096));

    let m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
    if (m) return m[1].toLowerCase();

    // <meta http-equiv="Content-Type" content="text/html; charset=gbk">
    m = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head);
    if (m) return m[1].toLowerCase();

    return null;
  }

  /** 把别名规范化为 TextDecoder 支持的编码名；无法识别返回 null。 */
  function normalizeCharset(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();
    return CHARSET_ALIASES[key] || key;
  }

  /**
   * 按指定编码解码字节；失败时回退 UTF-8（并容忍非法字节）。
   */
  function decodeBytes(bytes, charset) {
    const candidates = [];
    const normalized = normalizeCharset(charset);
    if (normalized) candidates.push(normalized);
    candidates.push("utf-8");

    for (const enc of candidates) {
      try {
        return new TextDecoder(enc, { fatal: false }).decode(bytes);
      } catch (_) {
        /* 该编码不被支持，试下一个 */
      }
    }
    // 最后兜底：latin1 永远可用
    return new TextDecoder("windows-1252").decode(bytes);
  }

  /**
   * 判断解码结果是否可疑（用于「声明的编码是错的」这种情况）。
   *
   * 替换字符 U+FFFD 大量出现，通常说明编码判断错了。
   */
  function looksMisdecoded(text) {
    if (!text) return false;
    const sample = text.slice(0, 4000);
    const bad = (sample.match(/\uFFFD/g) || []).length;
    return bad > 8;
  }

  /**
   * 抓取一个页面并返回解码后的 HTML。
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.referer] 部分站点检查 Referer
   * @param {RequestCredentials} [opts.credentials]
   *   凭据模式。默认 "omit"（不带 cookie，隐私更好）。
   *   **同源抓取时应传 "same-origin"** —— 这样会带上该源的 cookie
   *   （含 Cloudflare 的 cf_clearance）与页面会话一致，能显著降低被
   *   人机验证拦截的概率。
   * @returns {Promise<{ok:true, html:string, charset:string, finalUrl:string}
   *                  |{ok:false, reason:string, status?:number}>}
   */
  async function fetchPage(url, opts) {
    const options = opts || {};
    const timeoutMs = options.timeoutMs || TIMEOUT_MS;

    if (!/^https?:\/\//i.test(String(url || ""))) {
      return { ok: false, reason: "bad-url" };
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const headers = { Accept: "text/html,application/xhtml+xml" };
      if (options.referer) headers.Referer = options.referer;

      const res = await fetch(url, {
        signal: controller ? controller.signal : undefined,
        // 默认不带 cookie（减少副作用）；同源抓取时由调用方指定 same-origin，
        // 以复用页面已有的会话（这是通过 Cloudflare 的关键）。
        credentials: options.credentials || "omit",
        redirect: "follow",
        headers,
      });

      if (!res.ok) {
        return { ok: false, reason: "http-error", status: res.status };
      }

      // 先按字节拿，避免 .text() 一律按 UTF-8 解码导致中文乱码。
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) {
        return { ok: false, reason: "too-large", status: res.status };
      }

      const bytes = new Uint8Array(buf);

      // 编码判定优先级：HTTP 头 > HTML 内声明 > UTF-8
      const headerCharset = charsetFromHeader(res.headers.get("content-type"));
      const htmlCharset = charsetFromHtml(bytes);
      let charset = normalizeCharset(headerCharset || htmlCharset || "utf-8");

      let html = decodeBytes(bytes, charset);

      // 解码出来大量替换字符 → 换另一个候选编码重试（站点声明常与实际不符）
      if (looksMisdecoded(html)) {
        const alternative = charset === "utf-8" ? "gb18030" : "utf-8";
        const retry = decodeBytes(bytes, alternative);
        if (!looksMisdecoded(retry) || retry.length > html.length) {
          html = retry;
          charset = alternative;
        }
      }

      return {
        ok: true,
        html,
        charset,
        finalUrl: res.url || url,
      };
    } catch (err) {
      const message = String((err && err.message) || err);
      const aborted = err && err.name === "AbortError";

      // 细分网络错误：TLS 握手失败与「连不上」对用户意味着不同的事，
      // 提示文案也不同。实测遇到过的真实情况：
      // 老旧小说站只监听 HTTP，一旦请求被升级为 HTTPS 就握手失败
      //（浏览器报 SSL_ERROR / NS_ERROR_ABORT / SEC_ERROR 等）。
      const isTlsFailure = /ssl|tls|certificate|security|ns_error_abort|sec_error|handshake/i.test(message);
      const isDnsFailure = /dns|nxdomain|unknown host|name not resolved/i.test(message);
      const isRefused = /refused|unreachable|reset|econn/i.test(message);

      return {
        ok: false,
        reason: aborted
          ? "timeout"
          : isTlsFailure
            ? "tls-error"
            : isDnsFailure
              ? "dns-error"
              : isRefused
                ? "refused"
                : "network-error",
        message,
        // 带上请求时实际用的 URL，便于判断是否被 CSP 升级过协议
        requestedUrl: String(url),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    MAX_BYTES,
    TIMEOUT_MS,
    fetchPage,
    charsetFromHeader,
    charsetFromHtml,
    normalizeCharset,
    decodeBytes,
    looksMisdecoded,
  };
});
