# CoreUI

本地大模型一键管理工具（Apple 极简版）。在浏览器里完成「检测系统 → 装引擎 → 装模型 → 用模型」四步，就能在自己电脑上跑起 LLM / TTS / STT。

**零依赖、纯本地**：后端是一个 Node 原生 http 服务器，前端是单个 HTML 页面。所有模型与数据都留在你的电脑上，不上传任何服务器。

## 特性

- **傻瓜式四步**：检测系统 → 装引擎（安装包 / 下载）→ 装模型（把文件夹粘进去）→ 用模型（开启 / 关闭 / 切换）。
- **双引擎**：
  - `llama.cpp` — 通用 GGUF 推理运行时（CPU / Metal / CUDA），跨平台。
  - `SwiftLM` — Apple Silicon 专属的 MLX 原生推理服务，OpenAI 兼容，吃 MLX 权重。
- **每模型独立端口**：每个模型有自己固定的端口（8200–8799），互不打架，切换模型自动关旧的开新的。
- **离线安装包**：引擎和模型都可以打成 `.pkg` 安装包，双击即装、无需联网（见 `scripts/packaging/`）。
- **本地优先**：无遥测、无服务器留存，音频与对话内容只存在浏览器与本机。

## 快速开始

```bash
# 启动（默认 5173，建议指定端口避开 Vite 等开发服务器）
cd coreui
PORT=8899 node server.js
# 打开 http://localhost:8899
```

然后按页面左侧的四步走：

1. **检测系统** — 点「开始检测」，看看你的电脑适合跑什么。
2. **装引擎** — 双击引擎安装包（或点卡片上的「下载预编译包」），装完点「测试」确认。
3. **装模型** — 自己下载模型后，把文件夹 / `.gguf` 文件直接粘到对应目录：

   | 模型类型 | 目录 |
   |---|---|
   | GGUF（llama.cpp） | `~/.coreui/models/llama/` |
   | MLX（SwiftLM） | `~/.coreui/models/mlx/` |
   | 语音模型（TTS / STT） | `~/.coreui/models/audio/` |

4. **用模型** — 在「已安装」里找到模型，点「开启」，页面会给出一个本地地址（如 `http://127.0.0.1:8234/v1`，OpenAI 兼容），其他程序就能连它了。

> 配置选型：不同内存/芯片建议用什么引擎和什么参数的模型，看使用说明里的「系统配置明细表」。

## 目录结构

```
coreui/
├── server.js            # 零依赖 Node 后端（http 服务器 + REST API）
├── lib/                 # 核心逻辑
│   ├── paths.js         # 托管目录常量（engine/mlx、engine/llama、models/...）
│   ├── engine.js        # 引擎状态 / 安装 / 测试 / 删除 / 模型启动（每模型独立端口）
│   ├── model.js         # 模型目录扫描、安装、已安装列表
│   ├── detect.js        # 系统检测与推荐
│   ├── audio.js         # TTS / STT 音频服务（llama.cpp + Python）
│   ├── hf.js / download.js / status.js
├── catalog/models.json  # 内置模型目录
├── public/              # 前端单页应用（index.html / app.js / styles.css）
├── scripts/packaging/   # 离线安装包生成器（引擎 / 模型 / 批量）
│   ├── make-engine-pkg.sh   # llama.cpp 引擎安装包
│   ├── make-model-pkg.sh    # 模型安装包（--subdir mlx|llama|audio）
│   └── build-audio-bundles.sh # 批量构建音频模型包
└── dist/                # 构建产物（安装包，不入库）
```

## API 一览

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/detect` | GET | 系统检测（芯片 / 内存 / 磁盘 / 推荐） |
| `/api/engine` | GET | 引擎安装状态 |
| `/api/engine/install` | POST | 安装引擎（`{type, mode: download}`） |
| `/api/engine/test` | POST | 测试引擎能否启动（`{type}`） |
| `/api/engine/remove` | POST | 删除引擎（`{type}`） |
| `/api/models` | GET | 内置模型目录 |
| `/api/model/installed` | GET | 已安装模型（扫描三个子目录） |
| `/api/model/start` / `stop` | POST | 开启 / 关闭模型（`{id}`） |
| `/api/model/remove` | POST | 删除模型（`{id}`） |
| `/api/status` | GET | 安装进度 / 运行状态 |
| `/api/audio/*` | — | 音频服务部署 / 状态 / 停止 |

## 开发

- 环境：Node ≥ 18（ESM）。
- 语法检查：`node --check server.js lib/*.js public/app.js`。
- 无任何第三方运行时依赖，无需 `npm install`。

## License

MIT
