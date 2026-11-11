# 联机篮球街区

一个可以和朋友联机的 3D 篮球街区游戏。网页和联机服务器在同一个服务里：

- `server.js`：提供游戏网页，并在 `/ws` 上转发每个玩家的实时状态（位置、动作、开枪、换装等）。
- `public/index.html`：游戏本体（单个文件，约 5MB，包含主角的扫描模型）。

朋友不需要任何账号：打开网址、输入名字、选形象，就能和同时在线的人一起玩。

## 在 Render 上部署

**方法一：用 Blueprint（最省事）**

1. 用 GitHub 账号登录 <https://render.com>。
2. 点右上角 **New +** → **Blueprint**。
3. 选择仓库 `Lucky-mingming`。Render 会读取仓库根目录的 `render.yaml`，自动创建名为 `hoops-street` 的 Web Service。
4. 点 **Apply**，等几分钟构建完成。
5. 打开 Render 给的网址（类似 `https://hoops-street.onrender.com`），把它发给朋友。

**方法二：手动建 Web Service**

| 设置项 | 填写 |
| --- | --- |
| Root Directory | `hoops` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Health Check Path | `/healthz` |

## 注意

- Render 免费套餐在 15 分钟没人访问后会休眠，第一个打开的人要等大约 1 分钟才能进入。
- 一个服务最多同时 40 人在线。
- 存档（钱、衣服、车）保存在每个人自己的浏览器里，换设备不会同步。
- 网址公开后，任何拿到网址的人都能看到和下载页面里的扫描模型。

## 本地运行

```bash
cd hoops
npm install
npm start
# 打开 http://localhost:3000
```
