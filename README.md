# CoreUI

**本地部署大模型的一站式管理工具**。在浏览器里完成「检测系统 → 装引擎 → 装模型 → 用模型」四步，就能在自己电脑上跑起 LLM / TTS / STT。

- **一站式 llama 引擎**：内置 llama.cpp（GGUF）引擎管理，检测 / 安装 / 测试 / 删除，点几下就搞定。
- **一站式 SwiftLM 引擎**：内置 Apple MLX 原生推理引擎 SwiftLM 管理，Apple Silicon 上即开即用。
- **本地部署大模型**：零依赖、纯本地，模型与对话内容不上传任何服务器。

> 关键词：本地部署大模型 · 一站式 llama 引擎 · 一站式 SwiftLM 引擎 · 本地 LLM 管理 · Apple MLX · GGUF

**零依赖、纯本地**：后端是一个 Node 原生 http 服务器，前端是单个 HTML 页面。所有模型与数据都留在你的电脑上。

## 特性

- **傻瓜式四步**：检测系统 → 装引擎（官方下载）→ 装模型（把文件夹粘进去）→ 用模型（开启 / 关闭 / 切换）。
- **双引擎**：
  - [`llama.cpp`](https://github.com/ggml-org/llama.cpp) — 通用 GGUF 推理运行时（CPU / Metal / CUDA），跨平台。
  - [`SwiftLM`](https://github.com/SharpAI/SwiftLM) — Apple Silicon 专属的 MLX 原生推理服务，OpenAI 兼容，吃 MLX 权重。
- **每模型独立端口**：每个模型有自己固定的端口（8200–8799），互不打架，切换模型自动关旧的开新的。
- **官方下载**：引擎与模型均从官方渠道获取（llama.cpp / SwiftLM 的 GitHub 发布页、HuggingFace）。
- **本地优先**：无遥测、无服务器留存，音频与对话内容只存在浏览器与本机。

## 如何安装 CoreUI（这个工具本身）

1. **装 Node.js**：到 [nodejs.org](https://nodejs.org) 下载 LTS 版（≥ 18）并安装。
2. **拿到代码**：`git clone https://github.com/veritasian/coreui.git`，或点 GitHub 页面右上角「Code → Download ZIP」解压。
3. **跳过依赖安装**：本项目零第三方依赖，不需要 `npm install`。
4. **启动**：在项目目录运行

   ```bash
   node server.js              # 默认端口 5173
   PORT=8899 node server.js    # 或指定端口（推荐，避开 Vite 等开发服务器）
   ```

5. **打开浏览器**：访问 `http://localhost:8899`，按页面左侧四步操作即可。

## 系统支持（Windows / Linux 能不能装？）

| 平台 | 管理工具 | llama.cpp 引擎 | SwiftLM 引擎 |
|---|---|---|---|
| macOS（Apple Silicon） | ✅ | ✅ Metal 加速 | ✅ MLX 原生 |
| macOS（Intel） | ✅ | ✅ CPU | ❌ |
| Windows 10 / 11 | ✅ | ✅ CPU（CUDA 需自行装驱动与工具链） | ❌ |
| Linux | ✅ | ✅ CPU / CUDA | ❌ |

- **管理工具本身**（Node 后端 + 浏览器页面）在任何装了 Node ≥ 18 的系统上都能跑，检测逻辑原生支持 macOS / Windows / Linux。
- **llama.cpp** 全平台可用：Apple Silicon 用 Metal、NVIDIA 显卡用 CUDA、无独显就用 CPU（此时建议选小模型）。
- **SwiftLM** 只支持 Apple Silicon（macOS arm64），Windows / Linux 装不了。
- **引擎获取**：各平台都可用引擎卡片上的「下载预编译包」按钮（自动从官方 GitHub 发布页获取），或自己下载官方预编译二进制放进 `~/.coreui/engine/` 对应子目录。

## 快速开始

```bash
# 启动（默认 5173，建议指定端口避开 Vite 等开发服务器）
cd coreui
PORT=8899 node server.js
# 打开 http://localhost:8899
```

然后按页面左侧的四步走：

1. **检测系统** — 点「开始检测」，看看你的电脑适合跑什么。
2. **装引擎** — 点卡片上的「下载预编译包」（自动从官方 GitHub 发布页获取），装完点「测试」确认。
3. **装模型** — 自己下载模型后，把文件夹 / `.gguf` 文件直接粘到对应目录：

   | 模型类型 | 目录 |
   |---|---|
   | GGUF（llama.cpp） | `~/.coreui/models/llama/` |
   | MLX（SwiftLM） | `~/.coreui/models/mlx/` |
   | 语音模型（TTS / STT） | `~/.coreui/models/audio/` |

4. **用模型** — 在「已安装」里找到模型，点「开启」，页面会给出一个本地地址（如 `http://127.0.0.1:8234/v1`，OpenAI 兼容），其他程序就能连它了。

> 配置选型：不同内存/芯片建议用什么引擎和什么参数的模型，看使用说明里的「系统配置明细表」。

## 引擎参数说明

以下为底层引擎的常用参数。CoreUI 已按推荐值自动处理，多数情况无需改动；需要微调时直接改引擎的启动配置即可。

| 参数 | 引擎 | 说明 |
|---|---|---|
| `--model` | 两者 | 模型文件路径（CoreUI 自动传入） |
| `--port` | 两者 | 服务端口。CoreUI 为每个模型自动分配**固定端口（8200–8799）**，同一模型永远同一端口，互不打架 |
| `--ctx-size`（`-c`） | llama.cpp | 上下文长度（token）。越长能记住的对话越多，也越吃内存；8K–32K 是常见区间 |
| `--threads`（`-t`） | llama.cpp | CPU 推理线程数，默认用满 |
| `--n-gpu-layers`（`-ngl`） | llama.cpp | 把多少层放到 GPU。Apple Silicon / NVIDIA 设为最大值（999）基本全 GPU，显存不够再调小 |
| `--vision` | SwiftLM | 开启多模态（图像输入） |
| `--audio` | SwiftLM | 开启音频输入输出 |
| `temperature`（接口参数） | 两者 | 采样温度。越低越保守稳定，越高越有创造力，默认约 0.7 |

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
└── public/              # 前端单页应用（index.html / app.js / styles.css）
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

## Acknowledgements

- [llama.cpp](https://github.com/ggml-org/llama.cpp) — GGUF 推理引擎与 `llama-server`，CPU / Metal / CUDA 全平台加速。
- [SwiftLM](https://github.com/SharpAI/SwiftLM) — Apple MLX 原生推理服务，OpenAI 兼容接口。
- [Apple MLX](https://github.com/ml-explore/mlx) — Apple Silicon 上的机器学习框架。
- [Hugging Face](https://huggingface.co) — 模型下载与内置目录的数据来源。
- GGUF 格式与 llama.cpp 生态的全体贡献者。

## License

MIT
