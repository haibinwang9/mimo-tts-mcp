# MiMo TTS MCP Server

通过 Model Context Protocol（MCP）调用小米 MiMo 语音合成模型，为 Claude Code、Codex、Cursor、Windsurf、VS Code 等 MCP 客户端提供语音合成能力。

覆盖 MiMo 三个 TTS 模型：预置音色、文本设计音色、音频样本复刻音色。

## 三个工具与三个模型的对应关系

| 工具 | 模型 | 音色来源 | 唱歌模式 |
|---|---|---|---|
| `text_to_speech` | `mimo-v2.5-tts` | 9 个内置音色 | 支持 `(唱歌)` |
| `design_voice_to_speech` | `mimo-v2.5-tts-voicedesign` | 文本描述凭空生成 | 不支持 |
| `clone_voice_to_speech` | `mimo-v2.5-tts-voiceclone` | 本地 mp3/wav 样本 | 不支持 |
| `list_voices` | — | 返回音色/模型/配置目录，不需要 API Key | — |

## 安装

```bash
npm install
npm run build
```

MCP 客户端配置（stdio）：

```json
{
  "mcpServers": {
    "mimo-tts": {
      "command": "node",
      "args": ["/absolute/path/to/mimo-tts-mcp/dist/bin/mimo-tts-mcp.js"],
      "env": {
        "MIMO_API_KEY": "your-mimo-api-key"
      }
    }
  }
}
```

Claude Code 一行添加：

```bash
claude mcp add mimo-tts -s user \
  -e MIMO_API_KEY=your-mimo-api-key \
  -- node /absolute/path/to/mimo-tts-mcp/dist/bin/mimo-tts-mcp.js
```

API Key 在 <https://platform.xiaomimimo.com/console/api-keys> 创建。TTS 系列目前限时免费。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `MIMO_API_KEY` | 是（调用时） | — | MiMo API Key；也接受 `XIAOMIMIMO_API_KEY` |
| `MIMO_BASE_URL` | 否 | `https://api.xiaomimimo.com/v1` | 改用 Token Plan 或自建网关时覆盖 |
| `MIMO_TTS_OUTPUT_DIR` | 否 | `~/mimo-tts` | 落盘目录，**同时也是写入沙箱边界**。支持 `~` 展开，相对路径按进程 cwd 解析后转成绝对路径 |
| `MIMO_TTS_TIMEOUT_MS` | 否 | `180000` | 单次请求超时 |
| `MIMO_TTS_ALLOW_ANY_PATH` | 否 | 未设置 | 设为 `1` 才允许写入 `MIMO_TTS_OUTPUT_DIR` 之外的任意路径 |

`list_voices` 不需要 Key，在 Key 缺失时仍可用于自检配置。

## 工具参数

### `text_to_speech`

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 要播报的文本。可在开头加风格标签 `(怅然)`、`(东北话)`、`(唱歌)`，在句中插入 `[轻笑]`、`[长叹一口气]` 等音频标签 |
| `voice` | 否 | 内置音色 ID，默认 `mimo_default` |
| `instructions` | 否 | 自然语言风格指令，走 `user` 消息，支持「角色/场景/指导」导演模式 |
| `format` | 否 | `wav`（默认）或 `mp3` |
| `output_path` | 否 | 输出文件路径，省略时写入 `MIMO_TTS_OUTPUT_DIR`；默认必须落在该目录内 |
| `file_name` | 否 | 省略 `output_path` 时使用的文件名主体 |

内置音色：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`（中文）；`Mia`、`Chloe`、`Milo`、`Dean`（英文）。

### `design_voice_to_speech`

| 参数 | 必填 | 说明 |
|---|---|---|
| `voice_description` | 是 | 音色设计描述，1–4 句，覆盖性别年龄、音色质感、情绪语气、语速节奏，可选人设/场景/年代 |
| `text` | 条件 | 要播报的文本；当 `optimize_text_preview` 为 `true` 时可省略 |
| `optimize_text_preview` | 否 | 让模型润色文本，或在无文本时自动生成播报稿 |
| `format` / `output_path` / `file_name` | 否 | 同上 |

### `clone_voice_to_speech`

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 要播报的文本 |
| `sample_path` | 是 | 本地音色样本绝对路径，仅支持 `.mp3` / `.wav`，建议 5–30 秒，Base64 后需小于 10 MB |
| `instructions` / `format` / `output_path` / `file_name` | 否 | 同上 |

样本在每次调用时读取并转成 `data:audio/...;base64,...` 传给 API；文件只读不写。

## 安全模型

`output_path` 与 `file_name` 来自模型输出，因此按不可信输入处理：

- **路径限制**：默认只允许写入 `MIMO_TTS_OUTPUT_DIR`（默认 `~/mimo-tts`）。该变量既决定默认落盘位置，也定义沙箱边界，因此建议按项目单独设置，例如 `"MIMO_TTS_OUTPUT_DIR": "/path/to/project/audio"`。越界路径、`..` 穿越、以及指向目录外的符号链接子目录都会被拒绝。确实需要写任意位置时显式设置 `MIMO_TTS_ALLOW_ANY_PATH=1`。
- **从不覆盖**：目标已存在时不覆盖，自动改用 `-2`、`-3` 后缀，并用 `wx` 标志打开，因此也不会跟随已存在的符号链接写到别处。这样即使模型给出 `~/.bashrc` 这类路径，也只会新建一个同名新文件，不会破坏原文件。
- **文件名净化**：`file_name` 中的路径分隔符会被清除，无法借它跳出目录。
- **样本只读**：`sample_path` 仅用于读取，从不写入。
- **密钥只走环境变量**：代码不读取配置文件、不写入磁盘、不打印日志；错误信息中不会回显 Key。

如果你的 MCP 客户端会执行模型生成的路径，建议保持默认（不放宽 `MIMO_TTS_ALLOW_ANY_PATH`）。

## 返回值

```json
{
  "ok": true,
  "model": "mimo-v2.5-tts",
  "voice": "冰糖",
  "file": "/home/user/mimo-tts/20261020-110928-冰糖.wav",
  "format": "wav",
  "bytes": 148524,
  "duration_seconds": 1.55,
  "sample_rate": 24000,
  "streamed": true,
  "latency_ms": 1830
}
```

音频只写文件不内联 base64，避免把大 payload 灌进上下文。WAV 的 `duration_seconds` 由本地计算；mp3 需要逐帧解析才能精确，故不返回。若目标文件已存在，`file` 会带 `-2` 之类的后缀，这是正常行为而非错误。

## 实现要点

- 端点：`POST {baseUrl}/chat/completions`，认证头 `api-key`，OpenAI Chat Completions 兼容。
- 消息分工：`assistant` 存合成文本，`user` 存风格指令/音色描述。预置音色模型下 `user` 可省略；voicedesign 下 `user` 必填且不接受 `audio.voice`。
- `wav` 走流式路径：MiMo 仅在 `stream: true` 时输出原始 `pcm16`，因此按 SSE 收集 `choices[0].delta.audio.data`、丢弃尾部不足一个采样的残字节，再本地封装 44 字节 WAV 头（24 kHz / 16-bit / 单声道）。
- voicedesign 与 voiceclone 的流式接口目前降级为「推理完成后一次性返回」，流式拿不到音频时自动回退到非流式请求。
- `mp3` 走非流式路径，直接取 `choices[0].message.audio.data`。

## 开发

```bash
npm run dev        # tsx 直接跑 stdio server
npm run typecheck
npm test           # vitest：请求体构造、SSE 拼帧、WAV 头、落盘路径与写入沙箱、MCP 工具契约
npm run build
```

## 参考

- 参考工程：<https://github.com/runapi-ai/gemini-tts-mcp>
- 快速开始：<https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5>
- API 参考：<https://mimo.mi.com/docs/zh-CN/api/audio/tts>
- 预置音色：<https://mimo.mi.com/models/zh-CN/mimo-v2.5-tts>
- 音色设计：<https://mimo.mi.com/models/zh-CN/mimo-v2.5-tts-voicedesign>
- 音色复刻：<https://mimo.mi.com/models/zh-CN/mimo-v2.5-tts-voiceclone>
