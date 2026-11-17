# KiriHub

**自托管的视觉小说游戏库，以及面向浏览器单线程运行的 KiriKiri 引擎适配实验。**

Self-hosted visual novel library and an experimental single-thread browser port of KiriKiri.

目标是在 NAS 上管理自己拥有的游戏，通过网页启动，尽量保持原始游戏资源不变。当前只接入 KiriKiri，后端保留多引擎适配入口。本项目独立于名为 WebGAL 的其他项目，不是其官方分支。

> 开发中：识别 XP3 不代表完整兼容。当前还不能承诺任意 Krkr 游戏即传即玩，完整游戏流程与移动端回归仍在推进。

## 目前有什么

- 桌面与手机布局的游戏书架、收藏、游玩状态和全屏启动页。
- Python 标准库后端：管理本地游戏目录、ZIP / 7z 导入、XP3 主包识别、资源映射与 Range 请求。
- 按 XP3 内容识别启动入口，支持主包改名；原游戏文件保持原样。
- 普通视频的独立转码缓存；试运行存档与正式存档隔离。
- 浏览器画面检测和人工试玩确认的发布门槛。
- krkrsdl2 / KrkrZ 补丁与静态插件源码：KAGParser、CSV、字体、文字布局、GDI 绘图、透明 AMV 和视频事件适配。

Wasm 运行时保持 pthread 关闭、非共享内存，使用 Asyncify。后端扫描任务可使用线程，这与浏览器引擎的线程模型不同。

## 本地预览书架

需要 Python 3.11+。仓库默认提供空书架，不附游戏、封面或存档。

```sh
python tools/dev_server.py web 8300
```

打开 <http://127.0.0.1:8300/>。此命令提供前端与 Range/隔离响应头；管理 API 需要另外启动后端和反向代理。

```sh
python -m unittest discover -s backend -p "test_probe_contract.py" -v
```

后端配置、反向代理示例与启动命令见 [部署说明](docs/DEPLOYMENT.md)。引擎源码准备和编译限制见 [构建说明](docs/BUILD.md)。

## 引擎进展

| 领域 | 当前状态 |
| --- | --- |
| CSV、字体接口、KAG 解析、文字布局 | 已接入原生实现，有针对性契约测试 |
| VideoOverlay | 准备、帧事件、分段循环、Layer 输出已测试 |
| GDI / LayerExDraw | 常见绘图、裁剪、变换、混合、渐变、图片、中文字形已测试；仍有缺项 |
| AlphaMovie / AMV | 两类透明通道格式、逐帧解码、循环与定位已用合成素材测试 |
| Motion / Emote | 待实现，是下一阶段重点 |
| XP3Filter / PackinOne | 待补依赖与绑定 |
| 完整游戏与移动端 | 尚未建立系统性的兼容覆盖率 |

当前本机记录了 **145 项检查**：58 项契约、31 项绘图、36 项 AMV、16 项视频和 4 项后端发布门槛检查。这些是针对接口及合成素材的检查，不能换算为游戏兼容率；公开源码整理后的自动测试状态见 CI。

![由合成素材绘制的形状、渐变与中文字形](docs/images/synthetic-rendering.png)

详细边界、已知问题和下一步见 [路线图](docs/ROADMAP.md)。

## 源码组织

```text
web/                  书架、启动页与管理前端（空书库）
backend/              导入、扫描、资源服务与发布门槛
engine/patches/       对固定上游版本的两层补丁
engine/overlay/       新增引擎代码、插件与宿主兼容脚本
tests/engine/         不依赖商业游戏的 TJS 测试
docs/evidence/        针对合成素材的检查结果快照
tools/                本地预览、源码准备与发布检查工具
LICENSES/             上游与依赖许可证
```

## 来源与贡献

基于 [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2)、[KrkrZ](https://github.com/krkrsdl2/krkrz)，部分插件适配参考 [fenghengzhi/krkr2 的公开重建分支](https://github.com/fenghengzhi/krkr2)。这不代表已与手机原版 Kirikiroid2 完全等价。固定提交见 [upstream-lock.json](engine/upstream-lock.json)。

项目使用 AI 辅助开发。欢迎审查实现、补充不含商业资产的测试、完善构建流程，以及报告游戏版本与运行日志。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

原创 KiriHub 代码使用 MIT；上游源码、插件与依赖保留各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。请勿提交游戏本体、解密密钥、付费素材、用户存档或账号凭据。
