# KiCon Asia 2026 · Live Translate

本机运行的中英实时字幕工具：麦克风或电脑音频 → Qwen 实时识别与翻译 → 控制台 / 独立观众屏幕。

## 模型与接口

截至 2026-09-21，用户提供的官方文章发布的是 **Qwen3.8-LiveTranslate**，该账号 `/models` 也返回 `qwen3.8-livetranslate-flash-realtime`，没有发现 `qwen3.9-livetranslator`。项目实际使用 3.8，不伪造 3.9 调用。将来拿到新模型的准确 ID 和兼容协议后，可修改 `.env` 中的 `QWEN_MODEL` 并重新验证。

- HTTP Base URL：`https://maas.qianwenaiapi.com/compatible-mode/v1`，用于兼容接口与模型查询。
- 音频流端点：`wss://maas.qianwenaiapi.com/api-ws/v1/realtime`。
- Qwen3.8 内置 ASR 原文输出；不调用浏览器 SpeechRecognition，不另拼接文本翻译模型。
- 16 kHz、单声道、PCM16 LE 音频，以约 100 ms 小包输入；输出只启用文字。
- 默认使用 `audio.input.turn_detection.type=server_vad`、600 ms 静音断句。实测默认 `speaker_detection` 在短间隔中英切换场景出现漏句，改为 VAD 后本项目的整段测试通过。当前不宣称有稳定的说话人识别。
- 停止时先冲刷浏览器音频，补充约 4 秒静音，再发 `session.finish`，收到所有 `session.finished` 后结束；20 秒超时会明确提示末句可能未完整。

官方参考：[模型发布](https://qwen.ai/blog?id=qwen3.8-livetranslate) · [客户端协议](https://platform.qianwenai.com/docs/api-reference/speech-translation/livetranslate-realtime/client-events) · [服务端协议](https://platform.qianwenai.com/docs/api-reference/speech-translation/livetranslate-realtime/server-events)。

## 启动

需要 Node.js 22 或更新版本。本机已配置 `.env`；换电脑时先复制 `.env.example` 为 `.env`，填入自己的 Key。

```powershell
npm install
npm start
```

也可双击 `start.cmd`。保持启动窗口运行。

- 控制台：[http://localhost:3210](http://localhost:3210)
- 投屏：[http://localhost:3210/screen](http://localhost:3210/screen)

建议在本机 Chrome / Edge 使用麦克风与屏幕音频共享。内嵌浏览器可能不支持完整音频采集权限。服务默认仅监听 `127.0.0.1`，两块屏幕连接同一台电脑，通过 Windows 扩展显示投屏；本版没有配置跨电脑公网访问。

## 会议使用

1. Windows 显示设置选择“扩展”，把投影仪或第二块显示器接到这台电脑。
2. 在控制台选择麦克风、USB 声卡或调音台输入。设备名未出现时点击“刷新”并授权麦克风。
3. 如需翻译电脑播放的内容，选择“电脑 / 浏览器共享音频”，在浏览器共享对话框中勾选共享音频。屏幕视频不会传给模型，也不落盘。
4. 选择发言语言：单向演讲使用一个实时会话；中英交替模式将相同音频并行送入两个实时会话，目标语种分别为 `en` / `zh`，会增加 API 用量。同语种的那条输出也由模型生成，可能规范标点或措辞；控制台另保留识别原文。
5. 展开“会议术语”，按 `中文 = English` 填写词对，按目标语言自动反向映射；更改在新会话生效。术语是模型提示，不能保证专有名词绝对准确。
6. 点击“开始同传”。界面显示“正在同传”后开始讲话。
7. 打开观众屏幕，拖到扩展屏，点击全屏或按 `F`。浏览器不允许网页全屏时可用 `F11`。
8. 控制台可切换双语、中文、英文、字号、段落数、深浅主题；暂停只冻结投屏字幕，识别与存档继续；黑屏只遮住画面。
9. 点击“停止同传”，等待末句处理完成，再导出 TXT 或分语言 SRT。

“预览演示字幕”会明确显示 DEMO，不采集音频，不调用模型；可先用它检查投屏。

## 字幕、存档与故障处理

- `recordings/*.jsonl` 自动保存原文、译文和每次文本修订，不保存麦克风音频。文件包含会议内容，请按需要自行保管。
- 当前屏幕只保留最近 2000 条字幕以限制内存；**TXT / SRT 从完整本地存档导出**，不受这个显示限制影响。
- 进程重启后，在“字幕与会话记录 → 查看本地存档”下载历史 TXT / SRT。记录文件名使用 UTC 时间。
- 原文与译文按上游 `previous_item_id` 关联元数据；两个翻译会话的分句时机可能不同，投屏采用独立语言区域，不强行按行配对。
- 长句会在字幕区域向上滚出，最新内容持续可见，完整文字在存档中。
- SRT 基于字幕接收时间，适合粗对齐；不是强制音素对齐结果，剪辑前需校准。
- 上游断线、鉴权失败、响应失败、发送积压都会停止并给出可见错误。观众屏幕断线会自动重连并取回快照。
- 为避免悄悄漏音，本版不在上游断线后自动恢复麦克风：网络恢复后手动点击“开始同传”。断线期间不缓存、不补传音频。
- 控制台刷新或关闭会停止其采集，并触发服务端收尾。会议时保持控制台打开，观众屏幕可以独立刷新。
- 同一服务只允许一个采集控制台，其他控制台仍可查看字幕和调整投屏。
- API Key 只保存在服务端 `.env`，已被 `.gitignore` 排除；静态文件采用白名单，前端不收到 Key。

## 验证

### Token 和费用统计

“本次用量”同时显示 `时:分:秒` 会话时长及平均每分钟费用（已回报的预估费用 ÷ 实际经过分钟数）。开始会话时计时，含连接和结束收尾；双向会话不重复计时。暂停字幕或临时黑屏不暂停计时，因为识别仍在运行。停止或异常后时间与均价固定，刷新页面不会重新计时；新会话归零。没有费用回报或尚不足 1 秒时均价显示“—”。费用缺项时均价也标注“部分”。TXT 导出保留相同的时长与均价。

控制台左侧“本次用量”显示 API 回报的输入 / 输出 / 合计 token、模态明细及人民币预估费用。每次 `response.done` 返回用量后更新；流式句子尚未结束时数字暂不变化。中英双向分别接收两个会话的用量后合计，不再额外乘二。相同会话内重复的 response ID 不重复计数，失败响应如果返回有效 usage 也计入。

默认遵循平台服务端文档中“该响应的 Token 用量”的口径，累加各响应的 `response.usage`。如果所接代理明确返回会话累计值，可将 `.env` 的 `QWEN_USAGE_MODE` 设为 `cumulative`，按每条上游连接的最新累计值汇总；不要仅因为数字增长就自动切换口径。

2026-09-21 核实的[千问AI平台公开单价](https://www.qianwenai.com/models/qwen3.8-livetranslate-flash-realtime)：音频输入 40、图片输入 3.3、文本输出 100、音频输出 160，单位均为元/百万 token。费用按各模态的 token × 单价 / 1,000,000 计算。本工具只启用文本输出。

`.env` 可覆盖 `QWEN_PRICE_INPUT_AUDIO`、`QWEN_PRICE_INPUT_IMAGE`、`QWEN_PRICE_OUTPUT_TEXT`、`QWEN_PRICE_OUTPUT_AUDIO`、`QWEN_PRICE_INPUT_TEXT`。公开价格没有单列输入文本单价，默认留空，不擅自视为免费；这部分 token 会显示为“未计价”，费用标注“部分”。只有确认免费时才将相应单价设置为 `0`。修改配置后需重启服务。换用未识别的模型时没有默认价格，需自行配置。

费用是**已定价项目的预估值**，未扣除赠送额度、套餐和折扣，不是实际扣款或账户余额。缺少有效 usage 时显示“等待回报 / 回报不完整”；缺少 token 分类或价格时提示未计入。断线可能导致最后一部分用量未回报，应以平台账单结算。演示模式固定为 0；新会话从 0 重新统计。观众屏幕不显示费用。

用量摘要、原始 usage 和当时的单价随 `recordings/*.jsonl` 存档；TXT 导出包含用量与费用，SRT 仍只含字幕。刷新控制台可取回当前会话用量；服务重启时，如果最近一份存档已结束，会恢复其字幕、时长和费用，保持停止状态。其他会话可从历史 TXT 查看。此功能加入前的历史会话没有保存 usage，无法追溯准确 token。

```powershell
npm test                 # 本地单元测试与模拟上游集成测试，不调用 Qwen
npm run check:api        # 真实鉴权、模型配置、双向术语接受性检查
npm run test:transport   # 服务需先启动；测试演示、字幕广播和本地存档
```

带真实音频的验证（调用模型，会产生 API 用量）：

```powershell
node scripts/test-live-audio.js path/to/16k-mono-pcm16.wav
```

本次已用 Windows 合成的中英文 WAV、共 19.4 秒含静音间隔的输入，验证 ASR、中译英、英译中、双语广播和结束后的末句完整性。结果保存在本机 `artifacts/live-test-result.json`。这是功能测试，不是会场识别准确率或延迟基准；尚未用实际调音台、会场噪声和连续数小时演讲做验收。正式会议前请用演讲人的真实音频、术语和音响线路彩排。

## 代码结构

```text
server/index.js       HTTP、WebSocket 中继、会话生命周期和投屏同步
server/protocol.js    Qwen 事件归并、原文关联和术语配置
server/archive.js     从完整修订日志恢复字幕
public/audio.js       音频设备、共享音频和 AudioWorklet 管线
public/pcm-worklet.js 单声道混音、PCM16 分包
public/resampler.js   跨音频块保持相位的 16 kHz 重采样
public/app.js         控制台与观众屏幕交互
public/display.js     语言选择、TXT / SRT 导出
test/                离线功能与异常路径验证
```
