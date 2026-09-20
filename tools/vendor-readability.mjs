#!/usr/bin/env node
/**
 * 拉取 Mozilla Readability.js 并包一层浏览器全局导出，写入 src/vendor/readability.js。
 *
 * 为什么要这层包装：
 *   上游 Readability.js 只有 CommonJS 导出（`module.exports = Readability`），
 *   且 Firefox 的 content script 不支持 ES module import，
 *   因此在 content script 里拿不到构造函数。
 *   这里在文件尾部补一个 `globalThis.Readability = Readability`，
 *   让它作为普通脚本按序加载时直接挂到 isolated world 的全局上。
 *
 * 用法：npm run vendor
 * 生成物已入库（vendored），日常开发无需重复运行。
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const UPSTREAM =
  "https://raw.githubusercontent.com/mozilla/readability/main/Readability.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "src", "vendor", "readability.js");

const BANNER = `/*!
 * Readability.js — vendored from https://github.com/mozilla/readability
 * Licensed under the Apache License, Version 2.0.
 * 本文件由 tools/vendor-readability.mjs 自动生成，请勿手工编辑。
 * 尾部追加了 globalThis.Readability 导出（上游仅提供 CommonJS 导出）。
 * 生成时间：__DATE__
 */
`;

async function main() {
  console.log("→ 下载 Readability.js …");
  const res = await fetch(UPSTREAM);
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
  }
  let source = await res.text();

  // 防呆：确认上游结构与预期一致，否则包装会失效。
  if (!source.includes("module.exports = Readability")) {
    throw new Error(
      "上游文件结构与预期不符：未找到 `module.exports = Readability`。" +
        "请检查上游是否变更了导出方式，并同步更新本脚本。"
    );
  }
  if (!/^function Readability\(/m.test(source)) {
    throw new Error(
      "上游文件结构与预期不符：未找到顶层 `function Readability(...)` 声明。"
    );
  }

  const tail = `
/* ---- vendoring wrapper（非上游内容）---- */
if (typeof globalThis !== "undefined" && typeof Readability === "function") {
  globalThis.Readability = Readability;
}
`;

  const output = BANNER.replace("__DATE__", new Date().toISOString()) + source + tail;

  await writeFile(OUT, output, "utf8");

  const bytes = Buffer.byteLength(output, "utf8");
  console.log(`✓ 已写入 ${OUT}（${(bytes / 1024).toFixed(1)} KB）`);

  // 顺带回显一下大小，便于判断是否需要关注体积。
  const prev = await readFile(OUT, "utf8");
  if (prev.length > 400_000) {
    console.warn("⚠ 文件偏大（>400KB），请确认上游未引入额外依赖。");
  }
}

main().catch((err) => {
  console.error("✗ vendoring 失败：", err.message);
  process.exit(1);
});
