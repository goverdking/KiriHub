# 部署与运行

需要 Python 3.11+；导入 7z 需要 `7z`，普通视频转换需要 `ffmpeg` / `ffprobe`。游戏与运行时需自行合法准备。

1. 将 web/ 放到站点目录；书库初始为空。
2. 将编译好的 krkrsdl2 六个运行时文件放入 `web/engines/krkrsdl2/`。
3. 将引擎兼容脚本放入该运行时的 compat/：backend/generic-startup.tjs 复制为 startup.tjs，backend/web-csv.tjs 以及 engine/overlay/src/config/compat/senren-banka 下的 PolyfillInitialize.tjs、KAGParser.tjs、MenuItem_stub.tjs。可自行添加 OFL 字体为 font.otf 并保留字体许可。
4. 复制 config/config.example.json 为 config/config.json，修改 roots 为本机只读游戏目录。
5. 管理状态放在站点外，例如 `/srv/kirihub-state`。

```sh
python backend/server.py --site web --state /srv/kirihub-state --config config/config.json --port 8182
```

服务只监听 loopback。初始管理员密码生成在 state/admin-password.txt；请使用后在网页修改，不要将该目录纳入版本控制。

使用 nginx 等反向代理同时提供 web/ 静态文件，将 `/api/` 与 `/game-files/` 转发至 loopback 8182。参考 deploy/nginx.example.conf。配置浏览器隔离响应头、正确的 Range 支持，并根据实际外网入口配置 TLS。

添加流程：选择 NAS 本地目录或压缩包 → 扫描 → 浏览器试运行 → 确认标题、正文、声音与操作 → 加入书架。源文件不会被重打包；派生媒体和解压内容存于管理状态目录。
