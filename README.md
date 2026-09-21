# 澄读 · 阅读模式（Firefox）

一款 Firefox 沉浸式阅读扩展，核心能力是**自动清理正文里的空白行与多余间距**。

---

## 为什么做这个

同类工具（如 Circle 阅读助手）能很好地提取正文，但正文里残留的空白行常常没被处理：
一段没有文字的空段落，渲染出来就是一行空白，长文读起来断断续续。

本扩展的目标很具体：**让正文里每一个「没有文字的行」都不出现在读者眼前。**

### 实际的分工边界（重要，避免误解）

开发中经实测确认：Mozilla Readability 本身就**已经删掉了大部分普通空段落**
（`<p></p>`、`<p>&nbsp;</p>`、`<p><br></p>`、撑高度的空 `<div>` 等都会被它清掉）。
所以本扩展的真实增量集中在 Readability **漏掉**的几类情况：

| 空白来源 | Readability 是否处理 | 本扩展 |
|---|---|---|
| `<p></p>` / `<p>&nbsp;</p>` / `<p><br></p>` | ✅ 已处理 | 兜底再查一遍 |
| 撑高度的空 `<div style="height:60px">` | ✅ 已处理 | 兜底再查一遍 |
| **只含零宽字符的段落**（`U+200B` `U+200C` `U+200D` `U+2060` `U+FEFF`） | ❌ **会保留** | ✅ **核心修复** |
| 连排 `<br>` 造成的空行 | ⚠️ 部分处理 | ✅ 折叠为最多 2 个 |
| 块级元素首尾的孤立 `<br>` | ❌ 会保留 | ✅ 删除 |
| 文章开头/结尾的大片留白 | ⚠️ 部分处理 | ✅ 裁掉 |
| 作者内联的夸张垂直 margin/padding | ❌ 不处理 | ✅ 剥离 + 统一段距 |
| 纯 `on*` 事件属性等可执行内容 | ❌ 会保留 | ✅ 安全净化 |

**零宽字符那条是本扩展最实在的价值。** Readability 的判空正则是 `/^\s*$/`，
而 JavaScript 的 `\s` **不包含** `\u200b` 这类零宽字符——于是「看着是空、实际有字符」
的段落会被它完整保留，渲染出来就是一行空白。这类内容在微信公众号、各类 CMS、
Word 粘贴的富文本里非常常见。

此外还有一层**垂直节奏归一**：删掉空元素只解决了一半问题，作者用内联 `margin: 60px 0`
撑出来的大间距同样会造成「视觉空白」。本扩展剥离垂直方向的内联 margin/padding，
段距改由阅读视图统一控制。

---

## 功能

**阅读模式**
- 一键进入沉浸式阅读（工具栏按钮 / `Ctrl+Shift+U` / `Esc` 退出）
- 正文提取基于 Mozilla Readability，自动去掉广告、导航、侧栏
- 渲染在 Shadow DOM 里，页面样式无法干扰阅读排版
- 退出后完整还原页面（含滚动位置）

**排版自定义**（即时生效，自动保存）
- 主题：浅色 / 护眼 / 深色
- 字号加减、行距加减、段距加减
- 页宽：窄 / 中 / 宽 / 全宽
- 字体：系统 / 衬线 / 无衬线

**空行清理**（可开关，工具条上实时显示清理了多少处）
1. **安全净化** —— 移除 `on*` 内联事件属性、`javascript:` 等危险协议、
   `script/iframe/object/embed` 等可执行标签（**独立于空行开关，始终生效**）
2. 移除注释、残留 `script/style`、`aria-hidden` 元素
3. 剥离制造空白的垂直 `margin` / 过大 `padding`
4. 归一化空白字符（`&nbsp;` → 空格、零宽字符清除、连续空白压缩）
5. 折叠连排 `<br>`，删除块首尾孤立 `<br>`
6. 自底向上删除「视觉上为空」的块级元素
7. 裁掉文章首尾的空块
8. 拆掉纯容器 `<div>`（消除站点布局残留的层层间距）

**自动续页**（可开关，工具条上显示「续页 ✓/✗」）

看小说时分章阅读，滚动到底自动加载下一章，无需回目录点链接。

- **链接识别**：用打分而非「取第一个链接」。中英文都支持
  （`下一章` / `下一节` / `下一页` / `Next Page` / `Next Chapter` / `class="next"`），
  并排除 `上一章`、`目录`、`书架`、`推荐` 等干扰项
- **同站限制**：只跟随同域名的链接，绝不跨站跳转
- **同目录优先**：`/book/1/2.html` → `/book/1/3.html` 这类「兄弟页」加分，
  降低把博客的「下一篇」误当成续页的概率
- **预加载**：进入阅读模式后就在后台备好下一章，读到底**零等待**续上
- **章节分隔线**：每追加一章会插入一条带章节名的分隔线，边界清晰
- **到底提示**：没有下一章时在视口底部提示「已到最后一页」

安全与健壮性（这几条都是踩过坑才加上的）：

| 机制 | 防的是什么 |
|---|---|
| URL 去重 | A↔B 互指时无限加载，把浏览器拖死 |
| 内容指纹去重 | 站点用不同 URL 指向同一内容 |
| 在途标记 | 滚动事件高频触发导致并发抓取同一页 |
| 失败冷却（非永久停止） | 站点临时限流后用户被迫退出重进 |
| 页数上限（100 页） | 极端情况下的兜底 |
| 编码嗅探 | GBK/GB2312 站点按 UTF-8 解码得到整页乱码（中文小说站高频） |
| **主世界抓取** | Cloudflare 等防护挑战扩展请求（详见下文「关键设计」） |
| 三级降级 | 主世界 → background → 真实导航，尽可能保住连续阅读 |

**有声朗读（听书）**（工具条上开关，默认关闭）

把正文用小米 MiMo TTS 合成语音朗读，读到本章将尽时自动续下一章——全程不用手动干预。

- **两种合成粒度**（播放条上一键切换）
  - `分段`（默认）：首句出声快（约 3 秒），段间语气可能有细微跳变
  - `整页`：整页一次合成，语气连贯，但首次出声慢
- **播放控制**：播放/暂停、上一段/下一段、语速（0.75×~2×）、音色、进度显示
- **9 个音色**：茉莉 / 冰糖 / 苏打 / 白桦（中文），Mia / Chloe / Milo / Dean / 默认（英文）
- **视图跟随**：朗读到哪，视图滚到哪，当前段落高亮
- **进度记忆**：按页面记住读到第几段，下次打开该页可继续

### 自动续章是怎么做到「提前」的（这是听书的关键难点）

不需要用滚动位置去猜「本章快读完了」——**播放引擎自己精确知道还剩多少音频**：

```
正文块 → 切分成 cue → 合成队列（并发 2，保持领先）→ 音频队列 → 顺序播放
                          ↑                                  │
                          └── 剩余可播时长 < 90 秒 → 触发续章 ┘
```

- **触发条件是播放水位**，比滚动像素精确得多，且天然带提前量
- 续章调用的是自动续页已有的 `prefetch()` 缓存——用户还在读当前章时，
  下一章早已抓取、解析、净化完毕，**命中缓存即零等待**
- 朗读时不滚动页面，所以「滚动到底自动加载」不会触发；改由引擎按水位驱动

### 朗读的已知限制

- **需要自备 API Key**：在底部播放条填入小米 MiMo 开放平台的 Key（`sk-` 开头）。
  **填一次即可**——输入框实时同步到 `storage.local`，下次打开自动回填，
  不需要重新填写。Key 只存在本地，不上传任何地方；**代码里不硬编码任何密钥**。
  在输入框里按回车可直接开始播放。
- **语速 > 1.5× 时音调会变尖**：Web Audio 的 `playbackRate` 会同时改变音调，
  原生没有「变速不变调」。1.0× 无影响
- **首次播放需点一下**：浏览器要求 `AudioContext` 在用户手势的**同步执行栈**里
  创建或 `resume()`。这是有意的设计——引擎在点击处理器里同步调用
  `primeAudio()`，而不是等网络请求回来再创建（那时手势已失效，
  音频上下文会一直是 `suspended`，表现为「合成成功但完全没声音」，
  且 `onended` 永不触发、朗读会卡在第一条不动）
- **降级导航场景会中断朗读**：站点抓取被 Cloudflare 拦下时会改为真实导航跳页，
  新页面无用户手势、浏览器不允许自动出声。进度记忆保证跳过去后能从原处继续

**不做**（本版有意排除）：标注高亮、笔记、导出、目录、图片增强。

---

## 安装

### 先说结论：自己用不需要打包

Firefox 对扩展有**强制签名**要求：

> Add-ons need to be signed before they can be installed into release and beta versions of Firefox.

因此 `.zip` 包**双击是装不上的**——正式版/测试版 Firefox 会拒绝未签名的扩展。
自己日常使用，有下面三种可行方式。

---

### 方式一：临时载入（推荐用于日常自己用）

不需要签名、不需要打包，重启后失效（Firefox 重启需重新载入一次）。

1. Firefox 地址栏输入 `about:debugging#/runtime/this-firefox`
2. 点「临时载入附加组件」（Load Temporary Add-on）
3. 选择本目录下的 **`manifest.json`**（也可以选 `dist/` 里的 zip）
4. 打开任意文章页，按 `Ctrl+Shift+U` 或点工具栏图标

> Temporary installation 的特点：无需签名；**只保留到重启 Firefox 为止**；
> 且安装时的权限确认不会弹出。适合开发和个人自用。

### 方式二：打包 → 提交 Mozilla 签名（正式、可长期使用）

这是唯一能让扩展在正式版 Firefox 里**永久安装**的途径。

```bash
npm run build          # 生成 dist/chengdu-reader-0.2.0.zip
```

然后在 [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) 提交审核，
或改用命令行直接签名（需 Mozilla 账号的 API key/secret）：

```bash
npx web-ext sign --api-key=<KEY> --api-secret=<SECRET>
```

签名后会得到 `.xpi`，那个才可以永久安装、并能在多台设备上使用。

### 方式三：开发者版 / Nightly / ESR + 关闭签名校验

不愿走线上流程、又想永久安装，可以装 **Firefox Developer Edition**（或 Nightly / ESR），
在 `about:config` 里把 `xpinstall.signatures.required` 设为 `false`，
即可安装未签名的 `.zip`（需重命名为 `.xpi` 或直接选 zip）。

> 正式版（Release）和 Beta 版**不支持**这个开关。另外扩展必须有 `id`
> （本项目已设置 `browser_specific_settings.gecko.id`），否则关闭校验也装不上。

---

### 环境要求

Firefox **140+**。选择这个下限的原因：
`:has()` 选择器（CSS 兜底层用到）需要 121+，而清单里的
`data_collection_permissions`（Mozilla 强制的数据收集声明）需要 140+，取两者较高者。

### 常用命令

```bash
npm run start     # 自动启动 Firefox 并载入扩展（需已安装 Firefox，最方便）
npm run build     # 打包为 dist/chengdu-reader-0.2.0.zip
npm run lint      # 清单与代码校验
```

`npm run start` 是用 `web-ext run` 启动一个已载入扩展的 Firefox，
改完代码自动重载，比手动临时载入省事。

> **`npm run start` 用了持久 profile（重要）**：`web-ext run` 默认每次创建
> **全新的临时 profile**（官方文档：*"If not specified, a new temporary profile
> will be created"*），而扩展的 `storage.local` 存在 profile 里——
> 于是每次启动你的**设置和 API Key 都被清空**，表现为「每次都要重新填 key」。
> 因此 `start` 脚本显式指定了 `--firefox-profile .web-ext-profile
> --keep-profile-changes`，设置会被保留（该目录已 gitignore）。

---

## 开发

```bash
npm install          # 安装 jsdom（仅测试用）
npm test             # 跑全部测试（292 项）
npm run lint         # web-ext 清单校验
npm run start        # 启动带扩展的 Firefox（需已安装 Firefox）
npm run build        # 打包为 dist/chengdu-reader-0.2.0.zip
npm run vendor       # 重新拉取并打包 Readability（一般不需要）
```

### 项目结构

```
manifest.json                     # MV3；Firefox 用 background.scripts（事件页）
icons/icon.svg
src/
  background.js                   # 事件页：工具栏点击 / 快捷键 → 按需注入；
                                  #   抓取请求 → 主世界优先，background 兜底
  shared/
    fetch-page.js                 # 抓取 + GBK/GB2312 等编码嗅探（content 与 background 共用）
  content/
    main.js                       # 入口：注入守卫 + 编排 + 自动续页装配 + 跨页恢复
    extract.js                    # 克隆文档 → Readability → 净化 → 清理；下一页链接识别
    auto-next.js                  # ★ 自动续页控制器（预加载 / 去重 / 冷却 / 并发防护）
    tts-text.js                   # ★ 朗读文本切分（切句 / 增量扫描 / 两种粒度打包）
    tts.js                        # ★ 朗读引擎（合成队列 / Web Audio 播放 / 水位续章）
    tts-bar.js                    # 底部朗读播放条（播放控制 / 语速 / 音色 / 粒度 / Key）
    reader-view.js                # Shadow DOM 浮层、生命周期、追加内容、状态提示
    toolbar.js                    # 浮动工具条
    prefs.js                      # 偏好读写（storage.local）
    styles.js                     # 阅读视图样式（含 CSS 兜底层、章节分隔、状态条、播放条）
    clean/
      dom-utils.js                # DOM 判定工具 + 安全净化
      clean-blank.js              # ★ 空行清理管线（8 步）
  vendor/readability.js           # vendored Readability（已加 global 导出）
tests/
  clean-blank.test.mjs            # 清理管线单元测试
  extract.test.mjs                # 提取集成测试
  sanitize.test.mjs               # 安全净化测试
  title.test.mjs                  # 标题处理测试
  auto-next.test.mjs              # ★ 自动续页：链接识别 / 预加载 / 防死循环 / 编码 / 降级
  tts-text.test.mjs               # ★ 朗读切分：切句 / 增量扫描一致性 / 不跨章打包
  tts.test.mjs                    # ★ 朗读引擎：状态机 / 水位续章 / 高亮 / 进度记忆
  tts-bar.test.mjs                # ★ 播放条 UI：API Key 持久化 / 回车提交 / 阻止冒泡
  reader-view.test.mjs            # 视图/工具条/偏好 DOM 测试
  background.test.mjs             # background 注入与抓取/TTS 转发逻辑
  load-order.test.mjs             # 脚本加载顺序 + 端到端
  global-object.test.mjs          # ★ window !== globalThis 的真实环境差异
  shortcut.test.mjs               # 快捷键与权限配置守卫
  styles.test.mjs                 # 样式表静态守卫
  syntax.test.mjs                 # 语法与模板字符串守卫
  devtools/
    dirty-page.html               # 「脏页面」样本（空行清理）
    dev-server.cjs                # 本地测试服务器（小说站 + 脏页面 + 源码）
    verify-tts.html               # ★ 真机验证页：decodeAudioData 解码真实 MP3
    verify-collector.cjs          # 收集真机验证结果（headless 无法截图时的取数方式）
    verify-e2e.cjs                # ★ TTS 端到端验证（真实 API，含长文本完整性）
    sample-tts.mp3                # 真实 TTS 音频样本（真机解码验证用）
tools/vendor-readability.mjs      # Readability 拉取打包脚本
```

### 几处关键设计

**零构建、纯普通脚本。** Firefox 的 content script 不支持 ES module `import`，
因此所有模块都写成「UMD 风格 IIFE + 挂全局变量」，由 `background.js` 按固定顺序注入。
这也意味着可以直接 `about:debugging` 载入调试，改完刷新页面即生效，无需打包器。

**按需注入（但也确实需要 host 权限）。** 扩展只在用户点击按钮/按快捷键时才注入脚本，
不在所有页面常驻，这一点是成立的。

但**不能只靠 `activeTab`**：实测证明，在一次用户手势里连续调用
`scripting.executeScript` 时，`activeTab` 的临时授予无法稳定覆盖全部调用，
会抛 `Missing host permission for the tab`。由于错误只进控制台，
表现就是「点了图标毫无反应」，极难排查。对照实验（同一份代码只改权限）：

| 权限 | 结果 |
|---|---|
| 只有 `activeTab` | ❌ `Missing host permission` |
| 加上 host 权限 | ✅ 全链路通过 |

因此 manifest 显式声明了 `http/https/file` 的 host 权限。
代价是安装时会显示「访问所有网站数据」——这是功能必需的，不是过度索取。

**抓取下一页：必须用「页面主世界」（MAIN world）。** 这是本项目最关键的架构决定。

扩展有三个可以发请求的执行环境，**它们的 origin 完全不同**，这直接决定能否通过站点防护：

| 环境 | origin | 站点看到的 |
|---|---|---|
| 内容脚本（ISOLATED world） | `moz-extension://…` | 跨源 → 被 CORP/CORS 拦截 |
| background（扩展页面） | `moz-extension://…` | 跨源 → 被 Cloudflare 挑战（403） |
| **页面主世界（MAIN world）** | **页面自身 origin** | **与网页自己的 AJAX 无异** ✅ |

实测证据（同一站点、同一 URL）：

| 请求发起位置 | 结果 |
|---|---|
| background | ❌ `403 Forbidden`（`Cf-Mitigated: challenge`） |
| **页面主世界** | ✅ **`200 OK`** |

正确做法是用 `scripting.executeScript({ world: "MAIN" })` 把抓取代码注入页面主世界执行。
此时请求由页面自己发出，自动携带该源 cookie（含 `cf_clearance`）、
`Sec-Fetch-Site: same-origin`、正确的 Referer，且同源不受 CORS/CORP 限制。

抓取顺序因此是**三级降级**：

```
1. 页面主世界抓取   ← 首选，能过 Cloudflare（origin 正确）
2. background 抓取   ← 兜底（跨域等场景）
3. 真实浏览器导航     ← 最后兜底（顶层文档加载，不受任何跨源策略限制）
```

> 为什么第 3 级也可用：导航就是用户在地址栏回车，带完整浏览器指纹，任何防护都会放行。
> 代价是页面刷新，因此只在抓取确实走不通时使用；新页面加载后会自动重新进入阅读模式
>（用 `sessionStorage` 传递恢复标记）。

**安全权衡（必须说明）**：MDN 警告 MAIN world 中的代码可被页面读取或干扰。
这里注入的代码**只做「取 HTML 文本」一件事**，不传递任何敏感数据，
且结果仍会经过既有的 sanitize 净化管线，风险可控。

**预加载下一章（消除续读顿挫）。** 原实现是「读到底部才开始抓取」，
用户会看到几百毫秒到数秒的等待。现在改为：进入阅读模式约 1.2 秒后
（用 `requestIdleCallback` 避开首屏渲染）就在后台抓取并解析好下一章，
读到底部时**直接插入，几乎零等待**；插入后立刻为「再下一章」预取，**始终领先一章**。

预加载是**静默**的：不显示「正在加载」，失败也不提示（真正的失败留到实际加载时再报）。
缓存带 URL 标记，`nextLink` 变化后自动作废；同一目标不重复抓取。

**共享全局一律用 `globalThis`，不要用 `window`。** 这是本项目最难排查的 bug：
在 Firefox content script 的 **isolated world** 里 **`window !== globalThis`**。
模块的 UMD 包装写 `root.X = mod`（root 取 globalThis），而 `main.js` 原本从
`window[name]` 读，于是全部 undefined、报「依赖模块未加载」。
jsdom 里两者是同一个对象，**所以单元测试测不出这个差异**——
`tests/global-object.test.mjs` 专门用 Node 的 `vm` 构造出「二者不同」的沙箱来守住它。

**必须先克隆文档。** Readability 会就地修改传给它的 document，
不克隆会导致退出阅读模式后原页面被破坏。

**baseURI 修复。** Readability 用 `doc.baseURI` 把相对链接/图片转成绝对地址，
而 `cloneNode` 出来的文档 baseURI 可能为空，会静默退化为保留相对路径、
导致阅读视图里图片全裂。`extract.js` 显式把 baseURI 指向原文档。
自动续页抓回来的页面同理：`documentFromHtml` 会把 baseURI 指向目标页 URL。

**清理逻辑是纯函数、样式探测依赖注入。** 核心管线不依赖浏览器全局，
因此能在 Node + jsdom 下完整回归测试（含幂等性）。追加进来的章节会走同一套管线。

**幂等性是硬性验收项。** 管线连跑两遍的结果必须与跑一遍完全一致。

**失败要可见。** 项目早期把错误只写进 `console.warn`，导致一个权限问题
藏了很久。现在失败会在工具栏图标上显示红色角标（`!` 权限 / `×` 其他），
并把关键步骤写进日志——`console.log` 成本极低，但能把静默失败变成可诊断的失败。

**朗读为什么走 background 而不是内容脚本直连。** 与抓取同理：content script 的
origin 是 `moz-extension://`，对 `api.xiaomimimo.com` 而言是跨源，而
`host_permissions` 对 content script 无效。只有 background 有跨域特权。

（顺带一提：官方 API 确实返回 `Access-Control-Allow-Origin: *`，
所以内容脚本直连也能通——但依赖服务端的 CORS 配置是脆弱的，
一旦对方收紧就会静默失效。走 background 不依赖这个假设。）

**朗读为什么用 Web Audio 而不是 `<audio>`。** `<audio src="blob:...">` 是页面文档里的
媒体元素，受页面 CSP 的 `media-src` 约束（本项目在 CSP 上栽过跟头）。
`AudioContext.decodeAudioData` 走纯 JS 数据路径，不受 CSP 约束。

**朗读的切分为什么必须增量。** 自动续页会在用户阅读过程中不断往正文追加内容。
如果每次追加都重新打包整份 cue 列表，**已经合成好的 cue 会因重新切分而错位**——
缓存的音频对不上文本，朗读内容会串。因此打包器设计成增量的：
一旦某个 cue 被吐出，它的文本与下标永不改变，新内容只会追加成新 cue。
`tests/tts-text.test.mjs` 有专门的断言守住这条不变式。

**朗读的 cue 为什么不跨章节边界。** 跨章拼接会让语气在接缝处突变，
且高亮定位失去意义。用「遇到章节分隔线就切换 pageIndex」作为分组键自然阻断。

**朗读引擎顶层绝不触碰 `AudioContext`。** jsdom 里没有这个 API，
若在模块加载时就 `new AudioContext()`，所有加载该模块的测试都会崩。
因此一律惰性创建 + `typeof` 守卫。

---

## 测试

```bash
npm test
```

覆盖要点：

- **删除**：空段落、嵌套空 `div`、空 `li`、零宽字符段落、首尾留白
- **保留**：图片、`hr`、`table`（含空单元格）、`pre`/`code`/`textarea` 内的空白、
  锚点元素、`data:image` 图片
- **转换**：连排 `<br>` 折叠、内联垂直 margin 剥离且水平分量保留
- **安全**：`on*` 属性、`javascript:`/`vbscript:` 协议、`script/iframe/object/embed`
  一律清除；且**独立于空行清理开关**
- **幂等性**：所有样本跑两遍结果一致
- **加载**：按 manifest 顺序注入后全局变量链完整、端到端可开合
- **样式守卫**：禁止会把正常段落隐藏的选择器（见下）
- **语法守卫**：所有脚本通过语法检查、CSS 模板字符串完整
- **朗读切分**：切句正确性、增量扫描与一次性全扫结果一致、重复扫描幂等、
  已吐出的 cue 下标与文本永不改变、一个 cue 不跨章节
- **朗读引擎**：状态机迁移、并发受限、合成失败跳过而非卡死、
  水位触发续章、续章后扫描到新内容、高亮与跟随、进度记忆、无 `AudioContext` 环境不崩

### 三类「只有真实环境能发现」的坑

jsdom 不做布局、不支持 `:has()`、没有 `AudioContext`、也不发真实网络请求，
因此有三类 bug 单靠单元测试测不出来，已在代码与测试中留下防线：

1. **样式误伤正文**：曾写下 `p:not(:has(*)):not(:empty) { display: none }`，
   它的实际含义是「有文字但没有嵌套元素的段落」——把几乎所有正文段落都隐藏了。
   `tests/styles.test.mjs` 现在静态禁止这类选择器，`display:none` 必须走白名单。
2. **绝对定位居中导致换行**：`.rd-bar` 曾用 `left:50% + translateX(-50%)` 居中，
   绝对定位元素在宽度 auto 时的可收缩宽度只有「左边界→右边缘」= 半屏，
   工具条因此被迫换行、并遮住标题。现已改为 `inset-inline:0 + margin:auto + fit-content`。
3. **音频解码能力**：`decodeAudioData` 能否解码服务端返回的音频，jsdom 完全测不了。
   用 `tests/devtools/verify-tts.html` 在**真实 Firefox** 里验证过：
   官方 API 的 MP3 可正常解码（3.04 秒 / 48000Hz / 单声道），
   音频有实际内容（峰值 0.508），时长与文本长度相符。

**建议改动样式后，用 `tests/devtools/dirty-page.html` 在真实浏览器里过一眼。**

### 朗读的两套验证

| 脚本 | 验证什么 | 需要什么 |
|---|---|---|
| `tests/devtools/verify-tts.html` | 真实浏览器里的音频解码与播放链路 | 一个静态服务器 + 真实 Firefox |
| `tests/devtools/verify-e2e.cjs` | 真实 API 的端到端（含长文本完整性、各音色、各格式） | API Key（`MIMO_API_KEY` 或 `.tts-key`） |

`verify-e2e.cjs` 实测结论（2026-09）：1134 字 → **502 秒音频 / 3.2MB，MP3 帧连续无截断**；
5 个中文音色全部可用；非法音色会返回可读错误。

> 注：`verify-collector.cjs` 是配合 `verify-tts.html` 的取数工具。
> 本机 Firefox headless 的 `--screenshot` 会失败（GFX1 错误），
> 而它的远程调试端口走 WebDriver BiDi（不是 CDP），从 Node 侧读取不便，
> 因此让验证页把结果 **POST 回收集器**是最可靠的取数方式。

---

## 隐私

**阅读模式本身**：不收集、不传输任何数据。所有偏好只存在本地 `browser.storage.local`，
正文提取与清理完全在页面内完成，无任何网络请求。

**有声朗读**：只在**你主动开启朗读并填写 API Key** 后，才把**待朗读的正文文本**
发送到小米 MiMo 的语音合成接口（`api.xiaomimimo.com`）以换取音频。
这是朗读功能的必要前提，除此之外不发送任何内容（不发送页面 URL、
不发送 Cookie、不发送任何标识信息）。API Key 只存在本地 `storage.local`，
代码里不硬编码任何密钥。**不使用朗读功能则完全没有这类请求。**

清单中据此声明 `data_collection_permissions.required = ["none"]`。

---

## 许可

本项目代码采用 MIT。

`src/vendor/readability.js` 来自 [mozilla/readability](https://github.com/mozilla/readability)
（Apache License 2.0），由 `tools/vendor-readability.mjs` 自动生成并附加了浏览器全局导出。
