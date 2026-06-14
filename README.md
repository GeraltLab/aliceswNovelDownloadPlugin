# aliceswNovelDownloadPlugin
爱丽丝书屋网站的小说下载插件，仅适用于google浏览器，小说网址：https://www.alicesw.com

# 小说下载插件（NovelDownloadPlugin）

Chrome 扩展（Manifest V3），仅在 `https://www.alicesw.com/other/chapters/id/{数字}.html` 目录页工作，用于将勾选章节合并下载为 UTF-8 TXT 文件。

## 安装（开发者模式）

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本目录：`NovelDownloadPlugin`

## 使用

1. 在浏览器中打开小说**目录页**，例如：  
   `https://www.alicesw.com/other/chapters/id/46867.html`
2. 页面加载后扩展会**静默解析**书名、作者与章节列表（不会自动弹出面板）
3. 点击浏览器工具栏上的扩展图标，打开右侧 **Side Panel**
4. 勾选要下载的章节（默认全选；可 Shift+点击做区间选择）
5. 调整下载间隔、每 N 章暂停 M 秒后，点击 **下载**，短时间内请求过多会弹出验证码，输入即可继续下载。下载1章，暂停5秒以上不容易被封
6. 全部章节成功后，扩展会清除该标签页的缓存；失败或取消时会保留已下载内容的 TXT 半成品


章节正文通过站点接口 `/home/chapter/info` 获取（与阅读页相同），不再依赖静态 HTML 抓取。

## 文件说明

| 路径 | 说明 |
|------|------|
| `manifest.json` | 扩展配置 |
| `content/catalog.js` | 目录页 DOM 解析 |
| `background/service-worker.js` | 章节抓取、限速、下载 |
| `sidepanel/` | 章节列表与操作界面 |
| `lib/` | 解析与常量 |

## 权限说明（自用）

- `host_permissions`: 仅 `https://www.alicesw.com/*`，用于调用章节 API 与备用页面抓取
- `downloads`: 保存 TXT 到浏览器默认下载目录
- `storage`: 按标签页暂存目录数据（`session` 存储，关闭标签后清除）

## TXT 格式

- 文件名：`《书名》作者：作者名.txt`（非法文件名字符替换为 `_`）
- 每章：章节名单行 → 空一行 → 各 `<p>` 段落各占一行（`textContent`，保留段首空格）
- 章与章之间空一行
