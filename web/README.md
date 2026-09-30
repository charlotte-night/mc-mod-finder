# MC Mod Finder · 纯前端版（`web/`）

这个目录是一个**零依赖、零构建、零后端**的静态站点：把它扔到 GitHub Pages 上，访问者打开就能用。

原来跑在 `server/` 里的东西——跨平台检索、缓存、限流、推荐打分、真实下载测速——全部搬进了访问者的浏览器。
唯一的「服务端」是 Modrinth 和 CurseForge 的公开 API，浏览器直接访问它们。

---

## 本地预览

```bash
# 在项目根目录
npm run serve:web            # http://127.0.0.1:8788
npm run serve:web 8899       # 换个端口
```

或者任何静态服务器，例如 `npx serve web` / `python -m http.server -d web 8788`。

> **不要用 `file://` 直接双击 `index.html`。** Chrome / Edge 会拦截本地文件的 ES module，
> 页面会一片空白（Firefox 可以）。页面检测到这种情况时会直接在顶部给出提示。

---

## 发布到 GitHub Pages

1. 把这个项目推到 GitHub（`web/` 目录必须一起提交）。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
3. 推送到 `main`/`master`，`.github/workflows/pages.yml` 会先跑测试，再把 `web/` 整个目录发布出去。

发布出来的地址：

| 仓库类型 | 地址 |
| --- | --- |
| 用户/组织主页仓库（`<user>.github.io`） | `https://<user>.github.io/` |
| 普通仓库 | `https://<user>.github.io/<repo>/` |

**所有资源引用都是相对路径**（`./app.js`、`./styles.css`、`./assets/icon.svg`），
所以放在子目录里也能正常工作；`.nojekyll` 防止 Pages 的 Jekyll 处理干扰静态文件；`404.html` 负责把走错路径的访客带回首页。

不想用 Actions 也可以：**Settings → Pages → Source = Deploy from a branch**，分支选 `main`、目录选 `/docs`，
然后把 `web/` 的内容复制到 `docs/` 即可（`web/` 本身不支持作为发布目录，Pages 只允许根目录或 `/docs`）。

---

## 功能对照：从服务器搬到浏览器

| 原来（Node 服务） | 现在（浏览器） | 状态 |
| --- | --- | --- |
| `GET /api/search` 跨平台检索 | `sources/index.js` 的 `searchAll()` 直接并发请求各平台 | ✅ 等价 |
| `GET /api/tags` 版本/加载器列表 | `lib/tags.js` 调 Modrinth 标签接口，失败时用内置兜底列表 | ✅ 等价 |
| `GET /api/diagnose` 数据源诊断 | `sources/*.js` 的 `diagnose()` 在浏览器里探测接口可用性 | ✅ 等价 |
| `GET /api/curseforge/lookup` 按 ID 查询 | `sources/curseforge.js` 的 `lookupById()` | ✅ 等价 |
| `POST /api/speedtest` 服务端下载测速 | `lib/speedtest.js` **在访问者自己的网络上**取字节 | ✅ 更真实（见下） |
| `POST /api/cache/clear` | 「数据源设置 → 清除本地缓存」按钮 | ✅ 等价 |
| 服务端 TTL 缓存 + 磁盘持久化 | `lib/cache.js`：内存 Map + localStorage（带配额/降级处理） | ✅ 等价 |
| 服务端限流（防刷） | `lib/ratelimit.js`：自我限流，避免一个页面刷爆公共 API | ⚠️ 语义变了，见下 |
| `.env` 里的 `CURSEFORGE_API_KEY` | 访问者自己粘贴 key，存 localStorage | ⚠️ 必须这样，见下 |

### 测速：为什么浏览器版反而更准

老版本是**服务器**去 CDN 下载采样，测出来的是「服务器到 CDN」的速度。
现在由**访问者的浏览器**下载采样，测出来的是「访问者到自己会下载文件的那个 CDN」的速度——
这才是决定他下载快慢的那条链路。逻辑没变：按 `Range` 请求取一小段、排除首字节延迟只算稳态吞吐、
同一个 CDN 主机只测一次、结果按主机缓存 10 分钟。

同时它也更「诚实」地报告自己测不了的东西（这是迁移里最重要的一处修改）：

| 数据源 | 搜索 | 测速 | 原因 |
| --- | --- | --- | --- |
| Modrinth | ✅ | ✅ | `api.modrinth.com` 与 `cdn-alt.modrinth.com` 都返回 `Access-Control-Allow-Origin` |
| CurseForge | ✅（需自带 key） | ❌ 明确标注「此源无法测速」 | 文件在 `mediafilez.forgecdn.net`，**该主机不返回跨域许可**，浏览器读不到文件字节 |

CurseForge 那条尤其关键：老版本的测速是服务器做的，换到浏览器后如果闭眼照搬，
所有 CurseForge 条目都会「测速失败」，而失败和「这个源根本不允许浏览器取样」是两回事。
现在这种条目会显示 **「此源无法测速」**，速度项按中性值计分并在推荐依据里说明，
不会伪装成一个测出来的慢速结果。

Modrinth 的下载地址 `cdn.modrinth.com/...` 会 307 跳到 `cdn-alt.modrinth.com/...`，
而跳转响应本身不带跨域头。`lib/speedtest.js` 因此会在首个候选地址失败时自动改用
`cdn-alt.modrinth.com` 重试一次（`urlCandidates()`），这也是老版本不需要、浏览器版必须有的处理。

### 限流：从「防别人」变成「防自己」

老版本的限流器是为了保护部署者：不限流的话任何人都能拿 `/api/speedtest` 当免费下载器刷流量。
浏览器版没有这个威胁了，但两个约束还在，所以换成了**自我约束**：

- 对公共 API 的请求速率上限（Modrinth 120/分钟、CurseForge 60/分钟）+ 并发上限（4 / 2），
  避免一次搜索就打出一堆请求；
- 测速默认每台 CDN 主机最多采样 **1 MB**（可在「数据源设置」里改成 256 KB ~ 4 MB），
  一次最多 16 个条目、同时最多 3 个主机 —— 花的是访问者自己的流量，所以界面上会写清楚这次大约要下多少 MB。

### CurseForge 的 key：为什么必须由访问者自带

静态站点**没有办法安全地内置 key**：任何写进仓库的东西都会被公开，而 CurseForge 的 key
一旦泄露，别人就能拿它刷你的配额、甚至被封。所以设计是：

- 默认不带 key，搜索只出 Modrinth 的结果，界面上写明「需要你自己的 key」并提供申请入口；
- 访问者自己粘贴 key → 存在**他自己的浏览器 localStorage** → 只发送到 `api.curseforge.com`，不经过任何第三方；
- 换 key 会自动清掉缓存的 CurseForge 结果并重新探测；界面上说明了共用电脑上应该用完「清除」。

（顺带一提：`api.curseforge.com` 是**允许**浏览器跨域调用的——带 Origin 的探测返回了对应来源的
`Access-Control-Allow-Origin`，所以这条路走得通；卡住的只是它家 CDN 的文件字节。）

### 哪些站点依然抓不到

MC百科、9Minecraft、Planet Minecraft 没有开放的跨域接口，浏览器端无从抓取。
这一版照旧**只提供跳转**，不伪造它们的数据 —— 老版本也是这么做的，这条底线没有变。

---

## 社区检索：B 站与贴吧

B 站和百度贴吧是中文圈讨论整合包最多的地方，所以加了「社区检索」面板。但要说清楚一件事实：
**它们的接口不能被网页直接读取**，这不是没找到接口，而是实测过的结论：

| 接口 | 实测结果 |
| --- | --- |
| `api.bilibili.com/x/web-interface/search/type` | **HTTP 412**（反爬风控），且无 `Access-Control-Allow-Origin` |
| `api.bilibili.com/x/web-interface/wbi/search/all/v2` | HTTP 403 |
| `s.search.bilibili.com/main/suggest`（联想词） | 200 真 JSON，但**同样没有跨域许可** |
| `tieba.baidu.com/mo/q/search/thread` | 200 真 JSON，但**没有跨域许可** |
| `tieba.baidu.com/f/search/res` | HTTP 403 |

没有 `Access-Control-Allow-Origin`，浏览器会在把响应体交给 JS 之前就丢掉它；两家还都发
`X-Frame-Options`/CSP 拒绝被 `<iframe>` 嵌入。**静态站点没有任何合法办法绕过**，硬做的唯一后果是
把访问者送去用不可靠的第三方代理。

所以面板做的是三件**真能生效**的事：

1. **查询串翻译**：各站搜法不同。贴吧按主题走（`ATM10 我的世界 整合包 1.20.1`），
   B 站偏紧凑词组，MC 百科用百科口径。`buildSearchTerms()` 会按类型/版本/加载器拼出各站自己的查询串，
   还带一张 `QUERY_ALIASES` 别名表（`机械动力 → Create`、`暮色森林 → Twilight Forest`…）。
   界面上把每站的查询串直接显示出来，可单独复制。
2. **一键开搜**：一次在新标签页打开 B 站搜索、贴吧搜索、对应贴吧、MC 百科四个入口；被浏览器拦了弹窗会明说，而不是静默少开几个。
3. **B 站线路切换**：`bilibili.com` 在部分网络不可达，卡片上可切到港澳台线路（`area=tw`），选择会记住。

另外给了一条**投稿入口**：把搜索词预填进 B 站投稿页标题（`buildBilibiliUploadUrl()`），
方便把自己写的教程发回社区 —— 只预填，绝不自动提交。

### 可选：用中继真的把 B 站条目列出来

如果你愿意提供一个中继，面板下方就能直接列出 B 站搜索结果（标题、UP 主、时间，标注「社区内容·不参与下载速度评分」）。
在「数据源设置 → 社区中继」里填两种地址之一：

| 形式 | 例子 | 说明 |
| --- | --- | --- |
| 自建 RSSHub | `http://127.0.0.1:1200` | `docker run -d -p 1200:1200 diygod/rsshub`，一分钟起好 |
| CORS 转发前缀 | `https://xxx.workers.dev/?url=` | 也支持带 `{url}` 占位符的形式 |

路由用的是 RSSHub 官方的 `/bilibili/vsearch/:kw`（已对照上游仓库确认，`/bilibili/search/...` 并不存在）。
可再填一个 **UP 主 UID**，健康检测就会改用它（`/bilibili/user/video/:uid`）。

两个必须知道的限制：

- **RSSHub 没有贴吧路由**（上游 `lib/routes/` 里根本没有 `tieba` 目录），所以中继只能带来 B 站条目，贴吧永远只有跳转。
- 公共 RSSHub 实例实测当前**基本都返回 503**（上游被限流），所以这里**不预置任何公共实例**，默认关闭。
  自建实例是最可靠的做法。

中继返回的内容会被当作不可信输入处理：实体解码**先于**去标签，`&lt;img onerror=…&gt;` 这类会被清掉，
条目在 DOM 里只用 `textContent` 渲染。

---

## 目录结构

```
web/
├── index.html                 单页应用：搜索框、筛选、权重、工具栏、结果区、设置面板
├── styles.css                 全部样式（含新增的设置面板/提示条/进度条）
├── app.js                     界面与流程：状态、渲染、事件、速度测试编排、推荐分重算
├── 404.html                   GitHub Pages 兜底页（相对路径回首页）
├── .nojekyll                  让 Pages 原样发布静态文件
├── manifest.webmanifest       PWA 元数据
├── assets/icon.svg            站点图标
├── lib/
│   ├── net.js                 带超时/重试/并发的 JSON 请求（含把网络错误翻译成人话）
│   ├── cache.js               TTL 缓存：内存 + localStorage，带条数/字节双预算与降级
│   ├── ratelimit.js           令牌桶 + 并发闸门
│   ├── normalize.js           许可证判定、数字格式化等纯函数
│   ├── scoring.js             推荐分：六个维度加权，与原服务端算法一致
│   ├── speedtest.js           真实分块下载测速 + 按主机缓存 + CORS 回退
│   └── tags.js                版本/加载器下拉数据（含离线兜底列表）
└── sources/
    ├── index.js               数据源注册表 + searchAll() 并发检索/去重 + 下载地址解析
    ├── modrinth.js            Modrinth 检索/标签/版本/直链
    ├── curseforge.js          CurseForge 检索/详情/文件列表（访问者自带 key）
    └── community.js           B站/贴吧查询串翻译、一键开搜、线路切换、可选 RSS 中继
```

**没有构建步骤**：原生 ES module + 原生 CSS，改完刷新即可。也因此**不能使用裸模块名**
（`import x from 'lodash'`），只能用相对路径 —— `test/web-site.test.js` 会强制检查这条。

---

## 测试

```bash
npm run test:web        # 离线：Scoring/缓存/限流单测 + 静态站点与 DOM 契约检查
npm run test:web:live   # 联网：拿真实 API 跑一遍检索、标签、直链、测速
npm run test:web:all    # 两者都跑
```

三组测试各自守的东西：

| 文件 | 覆盖 |
| --- | --- |
| `test/web-lib.test.js` | 推荐分算法（含权重归一化、各维度边界、排序器）、许可证判定、格式化、TTL 缓存（过期/淘汰/持久化/配额降级/无 localStorage） |
| `test/web-community.test.js` | 社区查询串翻译（各站习惯、别名、加载器过滤、空词兜底、URL 编码与转义）、线路切换、投稿链接、RSS/Atom 解析（含 CDATA、实体、注入清理） |
| `test/web-site.test.js` | 用真实 HTTP 服务起 `web/`：每个资源的状态码与 MIME、模块依赖图能否解析、无裸导入、**`app.js` 里的每个 `$('id')` 在 HTML 中确实存在且进了 `dom` 映射表**、无绝对路径、无残留 `/api/` 调用、`.nojekyll`/`404.html` 就位 |
| `test/web-live.test.js` | 真实调用 Modrinth/CurseForge：检索结果结构、标签、直链解析、CDN 采样、按主机复用、错误 key 的诊断文案、CurseForge CDN 的「不可取样」归类 |

在沙箱或受限环境里 `node --test test/` 可能因为子进程管道被拦而报 `spawn EPERM`，
这时用 `npm run test:web`（逐个文件直接运行，不派生子进程）或在正常终端里跑。
