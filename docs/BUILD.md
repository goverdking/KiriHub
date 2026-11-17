# 引擎构建

这是已有本地构建的源码公开，不是已经完成跨平台构建自动化的稳定发行版。

引擎基于 upstream-lock.json 中固定的 krkrsdl2 与 KrkrZ 提交。公开重建分支用于部分插件参考；不用把其整套 pthread/JSPI Web 架构替换进本项目。

```sh
python tools/prepare_engine.py --destination .build/engine-src
```

该命令 clone 固定上游、初始化子模块，再应用两层补丁和新增代码。已有上游本地仓库可用 `--local-source PATH` 离线准备干净源码快照；不会更改原开发树。

最后验证的工具链是 Emscripten 6.0.9。需要准备同一工具链编译的 Wasm 依赖根目录，包含 libgdiplus、Cairo、GLib、fontconfig、FreeType 2.13.3、WebP、FFmpeg（avformat/avcodec/avutil/swscale/swresample）、压缩及其传递依赖、Boost 头文件。

```sh
emcmake cmake -S .build/engine-src -B .build/engine-web -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DKIRIHUB_DEPS_ROOT=/path/to/vcpkg_installed/wasm32-emscripten \
  -DKRKRSDL2_EMSCRIPTEN_ENABLE_THREADS=OFF \
  -DKRKRSDL2_EMSCRIPTEN_ENABLE_ASYNCIFY=ON
cmake --build .build/engine-web --target krkrsdl2.js --parallel 2
```

GDI/Cairo 库要求与引擎匹配的 Wasm 异常/longjmp ABI；不要与 JavaScript 异常模式或另一版本 FreeType 混合链接。

产物是 index.html、krkrsdl2.js、krkrsdl2.wasm、lazyfs.js、web-profile.js、web-video.js。前端与后端不包含这些二进制，也不附游戏。

## 验证边界

`tests/engine/` 是用于本地验证的 TJS 测试。生成合成 XP3/媒体并启动浏览器的跨机器测试入口仍需整理；docs/evidence 是测试快照，不是 CI 已重跑整套 Wasm 测试的声明。

CI 当前运行公开源检查和不依赖 NAS 的后端发布门槛测试。首次构建前请阅读上游及 LICENSES 中各依赖许可。
