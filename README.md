# MC Mod Finder

我的世界模组 / 整合包**搜索与推荐**站点。按**名称 + 游戏版本 + 类型**跨平台检索，并根据**实测下载速度**与**是否免费**给出推荐排序，每个结果的推荐依据都公开可查。

零依赖（只用 Node 内置模块），克隆下来 `npm start` 就能跑。

```
http://127.0.0.1:8765
```

> **想直接发布成网站、不想跑服务器？用 [`web/`](web/README.md)。**
> 那是同一套功能的**纯前端版**：检索、缓存、限流、推荐打分、真实下载测速全部在访问者浏览器里完成，
> 零依赖零构建，推到 GitHub Pages 就能用（附带 Actions 工作流）。
> 本 README 余下部分讲的是**自托管的服务端版本**，两者推荐算法一致，区别与取舍见 [`web/README.md`](web/README.md)。

---

## 快速开始

```bash
cd mc-mod-finder
npm start            # 默认 http://127.0.0.1:8765
```

也可以直接用 `npm run launch` —— 它会检查服务是否已在运行，没有就在后台起来，然后打开浏览器；`npm run stop` 停掉它。

### 桌面快捷方式

本项目已经在本机桌面放了两个快捷方式：

| 快捷方式 | 行为 |
| --- | --- |
| **MC Mod Finder** | 服务没运行就后台启动（无窗口），就绪后自动打开浏览器；已在运行则直接开浏览器 |
| **MC Mod Finder 停止** | 停掉后台服务，并用弹窗告知结果 |

启动器全程不弹控制台窗口，日志写到：

- `data/server.log` —— 服务自己的日志（带 BOM 的 UTF-8）
- `data/launch.log` —— 每次启动的记录
- `data/stop.log` —— 停止记录

启动失败时不会静默：会自动用记事本打开 `data/server.log`。

想在自己的机器上重建快捷方式，指向这两条命令即可（图标用 `assets/icon.ico`，起始位置设成项目根目录）：

```
wscript.exe "E:\dsh\mc-mod-finder\scripts\launch.vbs"
wscript.exe "E:\dsh\mc-mod-finder\scripts\stop.vbs"
```

图标可以随时用 `npm run icon` 重新生成（`scripts/make-icon.mjs` 会画出 16/24/32/48/64/128/256 七个尺寸打包进 `assets/icon.ico`）。

> **改这两个 .vbs 时请保持纯 ASCII。** Windows Script Host 按系统 ANSI 代码页读取 `.vbs`，写中文会导致解析错位、直接编译报错（这个坑我踩过一次）。所有中文提示都放在 Node 脚本里，那边是 UTF-8 安全的。

快捷方式只监听 `127.0.0.1`，**只有本机能访问**。想让别人也能用，见下面的「让别人也能访问」。

想要 CurseForge 的数据（可选）：

```bash
cp .env.example .env
# 填入 https://console.curseforge.com/ 申请的免费 key
```

没有 key 也能正常使用，只是 CurseForge 会保持禁用并在界面上写明原因 —— 本站不会伪造它的数据。

---

## 让别人也能访问

默认只监听 `127.0.0.1`，也就是**只有本机能打开**。要让别人用，按下面三条路选一条。

### ⚠️ 公开之前必读

1. **`/api/speedtest` 是带宽消耗口。** 它会让服务器真的去下载文件。不限流的话，任何人都能拿它当免费下载器刷你的流量，甚至让你的 IP 被 CDN 限流。本项目**默认已开启限流**（`RATE_LIMIT=1`，普通 120/分钟、测速 8/分钟、测速并发 3），公开部署请保持开启。
2. **走隧道/反代时必须设 `TRUST_PROXY=1`**，否则所有访客在限流器眼里都是 `127.0.0.1`，一个人就能把全站限流用光。但**只有端口不直接对外暴露时**才能开：客户端能直连时会伪造 `X-Forwarded-For`。
3. **CurseForge key 会承载所有访客的请求**，公开前请确认符合对方条款；key 本身只留在服务端，不会下发到浏览器（`/api/sources` 只返回启用状态，不返回 key）。
4. **Modrinth API 礼仪**：官方建议 ≤300 请求/分钟，并要求 User-Agent 能标识调用方。公开部署请填写真实的 `CONTACT`，并把 `SEARCH_CACHE_TTL` 调大（比如 900）。

### 方案 A：局域网 / Radmin VPN（最快，零成本）

```powershell
$env:HOST="0.0.0.0"
npm start
```

然后别人用你的内网地址访问：

- 同一 WiFi / 局域网：`http://10.210.203.34:8765`
- 装了 Radmin VPN 的人：`http://26.35.243.72:8765`

Windows 防火墙可能拦，第一次启动时弹窗选「允许」即可；没弹窗就手动放行：

```powershell
New-NetFirewallRule -DisplayName "MC Mod Finder" -Direction Inbound -LocalPort 8765 -Protocol TCP -Action Allow
```

**局限**：只有同一个网络里的人能用。而且**你这台机器没有公网 IP**（出口是 `153.3.211.102`，那是 NAT/代理的共享地址），所以**没法靠路由器端口转发把它暴露到公网**。

### 方案 B：SSH 反向隧道 / localtunnel（真正公网，无需账号，一条命令）

两个都不需要注册、不需要下载额外程序：

```bash
# 方式一：localhost.run（用系统自带 ssh）
ssh -R 80:localhost:8765 nokey@localhost.run

# 方式二：localtunnel（用 npm，本机 npm 源很快）
npx localtunnel --port 8765
```

终端会打印一个 `https://xxxx.xxx` 公网地址，发给任何人都能打开。

**局限**：地址是临时的，进程一关就失效，重启后地址会变；免费服务有连接数和带宽限制，不适合长期对外。适合「临时给朋友玩一下」。

> 我没有替你执行这一步 —— 它会把你这台机器直接暴露到公网，属于需要你本人确认的操作。

### 方案 C：部署到云端（永久、最正规）

项目零依赖，所以部署极简。仓库里有现成的 `Dockerfile`：

```bash
docker build -t mc-mod-finder .
docker run -p 8080:8080 -e PUBLIC_URL=https://你的域名 mc-mod-finder
```

托管到任意支持 Docker 的平台（Render / Railway / Koyeb / Fly.io / Zeabur 都有免费档），要点：

1. 构建用仓库里的 `Dockerfile`，容器端口 `8080`。
2. 环境变量设 `PUBLIC_URL=https://你的域名`、`CONTACT=你的联系方式`、`TRUST_PROXY=1`（平台通常在前面挂了一层反代）。
3. 需要 CurseForge 数据就加 `CURSEFORGE_API_KEY`（用平台的环境变量/Secret 存，不要写进代码）。
4. 单实例即可；多实例时内存缓存不共享，命中率会下降，建议先保持单实例。

自建服务器 + 域名的话，用 Caddy 拿 HTTPS 只要两行：

```
你的域名 {
    reverse_proxy 127.0.0.1:8765
}
```

Caddy 会自动申请并续期证书。记得服务端设 `TRUST_PROXY=1` 和 `PUBLIC_URL`。

---

## 数据源现状（重要，先说清楚）

「热门模组/整合包网站」里，真正提供公开 API 的其实只有少数几家。我逐个实测过：

| 站点 | 状态 | 说明 |
| --- | --- | --- |
| **Modrinth** | ✅ 已接入并实测通过 | 官方 v2 API，无需 key。模组 / 整合包 / 资源包 / 光影 / 数据包全覆盖。**本站的主力数据源** |
| **CurseForge** | ⚠️ 部分可用（见下节） | 详情 / 文件列表 / 官方直链 / 批量查询全部实测通过；**关键词搜索端点对当前这个 key 返回 403**。已实现按数字 ID 查询作为替代路径 |
| **FTB (api.modpacks.ch)** | ❌ 搜索接口已失效 | `/public/modpack/search/{n}?term=` 实测返回 `ECONNRESET`；只有 `/public/modpack/all` 可用且不含搜索所需字段。**因此没有接入**，改为深链 |
| **MC百科 / 9Minecraft / Planet Minecraft** | ❌ 无公开 API | 不做爬取（不稳定且违反站点条款），改为**一键深链**把你带到对应站点的搜索结果页 |

界面上「在其它站点搜索」那一排就是后两类站点的处理方式：诚实跳转，而不是假装搜到了。

### CurseForge 的真实情况（实测）

拿到 key 之后我把每个端点都跑了一遍。结论是**这个 key 有效，但未被授权访问搜索接口**：

```
✅ 项目详情            GET  /v1/mods/238222                                    200
✅ 文件列表            GET  /v1/mods/238222/files?gameVersion=1.20.1&…          200（总数 195）
✅ 官方直链解析        GET  /v1/mods/238222/files/8964934/download-url          200
✅ 批量按 ID 查询      POST /v1/mods  {"modIds":[238222]}                        200
❌ 关键词搜索          GET  /v1/mods/search?gameId=432&classId=6&pageSize=1      403  Forbidden: API Key missing or invalid
✅ 游戏版本列表        GET  /v1/minecraft/version                                200 ← 该端点不校验 key
✅ 分类列表            GET  /v1/categories                                      200 ← 该端点不校验 key
```

怎么确认「key 有效」而不是被缓存骗了：**每个请求都带唯一 `_cb` 参数绕过 CDN 缓存**，并且用假 key 做对照——详情/文件/直链三个端点真 key 200、假 key 403，搜索端点真假 key 都是 403。所以不是 key 本身的问题，是**这个 key 在 `/mods/search` 上没有权限**。

也排除了限流：响应里没有任何 `Retry-After` 或 `x-ratelimit-*` 头，`server: Kestrel` 直接返回 403，是授权判定而不是限流。

**怎么修**：到 [console.curseforge.com](https://console.curseforge.com/) **重新生成 key**。社区里大量同类 403 都是这样解决的（[itzg/docker-minecraft-server#3591](https://github.com/itzg/docker-minecraft-server/issues/3591) 里有多个「重新生成后就好了」的案例）。重新生成后运行：

```bash
node scripts/probe-curseforge.mjs
```

它会打印上面的权限矩阵，直接告诉你搜索是否恢复。**不需要改任何代码** —— 搜索一旦可用，适配器自动就会用它。

**在那之前的替代方案**：界面上的 **「CurseForge 按数字 ID 查询」** 面板（搜索被拒时会自动展开）。输入数字项目 ID（如 `238222` 是 JEI、`462042` 是整合包），就能拿到按版本+加载器匹配的文件和 **forgecdn 真实直链**，可以正常测速。CurseForge 没有按名称查询的接口，网页 URL 里也不含项目 ID，所以这里只能输入数字 ID —— 这是 API 的限制，不是偷懒。

> **key 的保管**：key 只存在 `.env`（已在 `.gitignore` 里），服务端读取后**不会下发给浏览器** —— `/api/sources` 和 `/api/diagnose` 只返回启用状态和诊断结论，从不回显 key 本身，日志里也不打印。
>
> 但**明文发在任何聊天/截图里的 key 都应视为已泄露**。建议直接到 console.curseforge.com 重新生成一个 —— 一举两得：既换了泄漏的凭据，又很可能顺带修好上面那个搜索 403。

### 顺带发现：forgecdn 拒绝带 Range 的请求

拿到 forgecdn 直链后第一次测速直接失败了。查下来是：

```
edge.forgecdn.net/…/jei.jar  不带 Range  → 302 到 mediafilez.forgecdn.net
edge.forgecdn.net/…/jei.jar  带 Range    → 404
mediafilez.forgecdn.net/…    带 Range    → 206 ✅  accept-ranges: bytes
```

`edge.forgecdn.net` 是个重定向器，而且**遇到 `Range` 头会直接 404**。所以测速器现在会在分块请求被拒（403/404/405/416/501）时，**先不带 Range 解析一次重定向链，再对最终地址做分块测速**。缓存键仍然是调用方给出的原始主机，所以不会重复探测。

修好之后，速度维度终于有了真正的区分度：

```
Modrinth  / jei     296 KB/s   ttfb 1418ms   cdn.modrinth.com
CurseForge / jei     27 KB/s   ttfb 1462ms   edge.forgecdn.net
=> 这次更快的是 cdn.modrinth.com
```

这正是「根据下载速度推荐」最想要的场景 —— 两个平台的内容一样，但下载体验差一个数量级。

---

## 推荐算法

推荐分是 6 个维度的加权和，**每个维度的得分和权重都会显示在结果卡片上**，不是黑盒。

默认权重：

| 维度 | 默认权重 | 计算方式 |
| --- | --- | --- |
| 名称相关度 | 30% | 标题完全命中 1.0 / 前缀 0.95 / 包含 0.85 / slug 0.8 / 作者 0.68 / 简介 0.55；多词查询再按命中比例插值 |
| 下载量 | 20% | `log10` 刻度，1 千 → 0 分，5000 万 → 1 分 |
| **下载速度** | **20%** | `log10` 刻度，50 KB/s → 0 分，5 MB/s → 1 分。**未测速时取中性值 0.55**，既不埋没也不抬举 |
| **免费程度** | **15%** | 直链 + 开源 1.0；直链但许可受限 0.85；只能在网页下载（有广告墙）0.45；付费 0 |
| 更新活跃度 | 10% | 今天更新 1.0，约 3 年未更新 0 |
| 关注人数 | 5% | `log10` 刻度，5 → 0 分，2 万 → 1 分 |

`推荐分 = Σ(维度得分 × 归一化权重) × 100`

界面上 6 个滑条可以实时改权重，改完立刻重排；权重会存进 `localStorage`。把速度拉到 60%、免费拉到 0，排序就会完全按速度走 —— 这正是需求里「根据下载速度以及是否免费进行推荐」的可操作版本。

**测速与推荐是闭环的**：点「为推荐测速」后，服务端实测速度 → 客户端重新请求同一个搜索（命中缓存，~5ms）→ 服务端用新的速度重新算分 → 排序随之变化。实测中 `Create: Enchantment Industry` 就是这样从榜外升到第 2 位的。

### 每一步都能看到理由

卡片展开「推荐依据」会列出：

```
名称高度匹配搜索词 / 下载量 1065.0万 / 1719 人关注 /
实测下载 320 KB/s（一般） / 首字节 1651 ms /
免费直链 + 开源许可 MIT / 11 天前更新
```

---

## 下载速度是怎么测的

不是估算，是真的下载。

1. 解析出该条目**当前游戏版本 / 加载器**对应的那个文件直链（Modrinth 走 `/project/{id}/version` 过滤）。
2. 发一个 `Range: bytes=0-(1MiB-1)` 的请求，**只读最多 1 MiB** 就主动断开，不会把 60MB 的整合包整个拖下来。
3. 分别记录**首字节时间（TTFB）**和**流式读取时间**，然后
   `速度 = 读取字节数 ÷ 流式时间`，**刻意排除 TTFB**。否则一个握手慢但带宽好的 CDN 会被误判成慢。
4. `Accept-Encoding: identity`，避免压缩后的字节数虚高。
5. 并发上限 3，超时 6 秒；**如果到时只读到 ≥32KB，仍然按已读样本给出速率并标注 `truncated`**，而不是判为失败 —— 慢链路不该被当成错误（这个 bug 是在真实联调时发现的：CDN 慢的时候 6 秒只读了 0.91MB，结果 8 条全被标成 `FAILED timeout`）。
6. 分块请求被拒（403/404/405/416/501）时，**先不带 `Range` 解析一次重定向链，再对最终地址分块测速**。forgecdn 就是这种情况，见上文。

两个关键设计：

- **按 CDN 主机缓存速率（默认 10 分钟）**。Modrinth 的所有文件都在同一个 CDN 上，所以给 8 个结果测速实际只发 **1 次**真实请求，其余复用 —— 实测日志：`实测 8 个，真实探测 1 次，读取 1.00 MB`。缓存键用的是**调用方给出的原始主机**（不是重定向后的地址），所以 forgecdn 这类重定向也不会导致重复探测。
- **样本过短会被标记** `lowConfidence`（< 150ms），界面上提示「样本较短，速度值仅供参考」。

### 速度维度什么时候才真正有用

Modrinth 全站共用一个 CDN，所以**同一批 Modrinth 结果的实测速度基本一样**（实测都是 300 KB/s 上下），此时速度维度更像是统一加减分而不是区分项。

**跨平台对比时它才真正产生区分度** —— 同一份 JEI，实测：

```
Modrinth   / jei     296 KB/s   cdn.modrinth.com
CurseForge / jei      27 KB/s   edge.forgecdn.net
```

内容完全一样，下载体验差一个数量级。这正是「根据下载速度推荐」最有价值的场景，也是我把 CurseForge 那条按 ID 查询的路径专门做出来的原因。

---

## 「是否免费」怎么判定

- **Modrinth**：一律可直链下载、无付费墙 → 免费；再用 SPDX 许可判断是否开源（`MIT`/`GPL`/`Apache` 等为开源，`ARR`/`Custom` 标为受限）。
- **CurseForge**：读 `allowModDistribution`。作者关闭第三方分发时 `downloadUrl` 为空 → 判定为「免费但只能在网页下载（含广告）」，得分从 0.85 降到 0.45。
- 界面上勾选「只看可直接下载的免费资源」即可过滤掉需要跳网页的那批。

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 运行状态、数据源开关、缓存命中率、已测速主机 |
| GET | `/api/sources` | 各平台启用状态与未启用原因 |
| GET | `/api/tags` | 可选游戏版本与加载器（用于下拉框） |
| GET | `/api/search` | 主搜索接口 |
| POST | `/api/speedtest` | 对指定条目做真实测速 |
| POST | `/api/cache/clear` | 清空缓存 |

`GET /api/search` 参数：

```
q=create              名称关键词
type=mod,modpack      类型：mod / modpack / resourcepack / shader / datapack / all
version=1.20.1        游戏版本
loader=fabric,forge   加载器（逗号分隔）
sort=score            score / speed / free / downloads / followers / updated / relevance
limit=20   offset=0
freeOnly=1            只看可直链下载
measuredOnly=1        只看已测速
weights={"speed":50,"free":30}   或 w_speed=50&w_free=30
source=modrinth       限定数据源
```

其它接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/diagnose[?force=1]` | 逐个数据源做权限探针。CurseForge 会明确区分 `invalid-key` 与 `search-blocked`，并给出可操作提示 |
| GET | `/api/curseforge/lookup?id=238222&version=1.20.1&loader=fabric` | 按数字 ID 查 CurseForge 项目，返回归一化条目（含 forgecdn 直链），可直接送去测速 |

```bash
# 这个 key 现在能做什么、不能做什么
curl "http://127.0.0.1:8765/api/diagnose"

# 按 ID 查 CurseForge 项目（搜索端点被拒时依然可用）
curl "http://127.0.0.1:8765/api/curseforge/lookup?id=238222&version=1.20.1&loader=fabric"
```

示例：

```bash
curl "http://127.0.0.1:8765/api/search?q=create&type=mod&version=1.20.1&loader=fabric&limit=5"

curl -X POST http://127.0.0.1:8765/api/speedtest \
  -H 'Content-Type: application/json' \
  -d '{"version":"1.20.1","loaders":["fabric"],"limit":8,
       "items":[{"key":"modrinth:kU1G12Nn","source":"modrinth","id":"kU1G12Nn"}]}'
```

---

## 配置

见 `.env.example`，全部可选：端口、CurseForge key、User-Agent、测速采样字节数/超时、缓存 TTL、是否启用磁盘缓存。

搜索与项目详情默认缓存到 `data/cache/*.json`（重启不丢），测速结果缓存 30 分钟。

---

## 测试

```bash
npm test            # 服务端：75 个单测 + 一个拉起真实 HTTP 服务的端到端测试
npm run test:live   # 打真实 Modrinth API 与 CDN 的联机检查（服务端）
npm run test:web    # 纯前端版：离线单测 + 静态站点/DOM 契约检查
npm run test:web:live # 纯前端版：用真实 API 跑检索、标签、直链、测速
```

`npm test` 与 `npm run test:server` 等价（后者逐个文件执行）；`npm run test:web` / `test:web:live`
覆盖的是 `web/` 里的浏览器代码，详见 [`web/README.md`](web/README.md#测试)。

覆盖的关键行为：

- **推荐算法**：权重归一化、各维度单调性、未测速时用中性值、测速失败不归零、**提高速度权重会放大快慢差距**、免费程度影响排序
- **测速数学**：用一个「先延迟 800ms 再按固定速率吐数据」的本地服务器，断言 `速度 = 字节/流式时间` 且**明显高于把 TTFB 算进去的朴素值** —— 这条断言直接锁住了最容易写错的地方
- **超时与截断**：慢链路超时但已有足够样本时必须给出有效速率、保留完整文件大小、并标 `truncated`
- **主机去重**：3 个同主机目标只发 1 次请求，第 4 个命中缓存后 0 次请求
- **限流**：令牌桶补充与容量上限、按客户端隔离、空闲桶淘汰、**默认不信任可伪造的 `X-Forwarded-For`**、突发超限返回 429 且带 `Retry-After`
- **适配器**：mock 掉上游后校验字段归一化、加载器与分类的拆分、版本过滤参数、无匹配版本时回退；CurseForge 侧额外覆盖 **`diagnose` 的四种状态**（无 key / key 无效 / key 有效但搜索未授权 / 全通）、搜索被拒时抛 `SEARCH_BLOCKED`、按 ID 查询的版本与加载器映射、slug 输入给出可操作错误、`download-url` 回退
- **测速的 CDN 兼容**：模拟一个「带 Range 就 404、不带就 302」的重定向器，断言测速器会先解析重定向再分块测量，且缓存键仍用原始主机
- **端到端**：搜索 → 测速 → 重新搜索确认排序用上了新速度；`freeOnly` 过滤；目录穿越必须被拒绝；404/405

> 注：本机沙箱禁止 `child_process` 管道，`node --test test/` 会因为 spawn 被拦。这里是用 `node test/<file>.js` 逐个跑的（`node:test` 支持直接执行）；在普通机器上 `npm test` 正常。

联机检查实测结果：

```
PASS 搜索模组 / 搜索整合包 / 按加载器过滤（719 条 fabric）
PASS 解析下载直链  jei-26.3-neoforge-31.7.0.40.jar (2.24 MB)
PASS 实测下载速度  287 KB/s  ttfb 1683ms  读取 524288 字节  range=true  主机 cdn-alt.modrinth.com
9/9 通过
```

---

## 目录结构

```
server/
  index.js          HTTP 服务、路由、静态文件、搜索/测速接口
  router.js         极简路由 + JSON 请求体解析
  config.js         .env 读取与配置
  http.js           带重试/限流/超时的 JSON 请求
  cache.js          TTL 缓存（内存 + 磁盘）
  limiter.js        并发信号量
  ratelimit.js      按访客 IP 的令牌桶限流 + 代理头处理
  speedtest.js      分块测速 + 按主机聚合的速率缓存
  scoring.js        推荐分算法与「推荐依据」文案
  normalize.js      许可分类、对数刻度、格式化
  sources/
    modrinth.js     Modrinth 适配器（已实测）
    curseforge.js   CurseForge 适配器（详情/文件/直链已实测；搜索端点被 key 拒绝）
    index.js        并发查询 + 跨平台去重 + 失败时附带诊断
public/
  index.html  styles.css  app.js     前端（原生，无构建步骤）
scripts/
  launch.mjs        后台启动 + 等就绪 + 开浏览器
  stop.mjs          停止后台服务（只在确认是本服务时才结束进程）
  launch.vbs        快捷方式入口（纯 ASCII，见上文说明）
  stop.vbs          停止快捷方式入口
  make-icon.mjs     生成 assets/icon.ico
  live-check.mjs    联机冒烟检查
  smoke.mjs         对运行中的服务做端到端检查
  smoke-curseforge.mjs   CurseForge 集成 + 跨 CDN 测速对比
  probe-curseforge.mjs   CurseForge key 权限矩阵（换 key 后跑这个）
assets/
  icon.ico          快捷方式图标（7 个尺寸）
test/               node:test 测试
```

---

## 已知限制

- CurseForge 适配器**未经实跑验证**（没有 key），字段按官方文档写，首次启用请留意报错。
- FTB 搜索接口已失效，未接入。
- MC百科等站点无公开 API，只提供深链。
- 测速反映的是**你本机到该 CDN 的链路**，不代表其他地区用户的速度。
- 同名项目在两个平台都有时会去重（保留下载量更高的那个）。
- 没有账号系统、收藏夹和下载队列；本站只做检索与推荐，下载请到对应平台，尊重作者的许可与分发意愿。

## 许可

MIT
