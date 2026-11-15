# 律动版大肥鱼（形象包）

Mr.Q 基于 Pal-AI-Lab/Coopanion 内置形象 `whale`（DeepSeek 大肥鱼）改的一份立绘，加了 12 个宿主没有的动作：
蹦迪、律动、打拍子、闭眼听、跟着哼、跟拍挥、余韵、凑近听、怔住、退半步、捂耳朵听、坐着哼。

## 来源与授权

- 角色原设「溟月」（上善无形）；DeepSeek 女仆装二创 ZipZipPipe。
- 立绘贴图来自 Coopanion 内置包 `packages/cortico-world-desktop-pet/web/whale/`。原包附带的
  `THIRD_PARTY_NOTICES.md` 写明：**这些贴图不在该包的 AGPL 授权范围内**，随 Coopanion 分发，
  想在别处使用请自行确认原设与各家标志的权利（围裙上的商标图形归各自公司所有）。
- 这份包跟着扩展发，是为了在 Coopanion 里用它；不改变上述任何权利归属。
  署名与来源同时写在 `figure.json` 的 `author` / `credits` 里。
- 与宿主内置 whale 逐文件比对（md5）：除 `figure.json`、`figure.js` 两个文件（动作实现）外，
  其余 485 个文件逐字节相同。

## 文件

| 文件 | 是什么 |
|---|---|
| `figure.json` | 词表、动作（`motion`）、打扮项 |
| `figure.js` | 画法（`export createWhaleBody`） |
| `model.json` / `tex/` / `feat/` / `schemes/` / `outfits/` / `thumbs/` | 立绘、表情件、配色与缩略图 |
| `installed-by.json` | 装的时候才写：哪个扩展装的、什么版本、什么时候 |

## 为什么不打包成 zip 发

形象包没有地方发 —— 扩展市场只收 world / bot / provider，`catalog.json` 里 355 个包
一个 `figure` 都没有，标签词表里也没这一类。所以只能跟着扩展走，由扩展在启动时装进
`<部署>/data/figures/groove/`。
