# 2026-09-28 窗口"当前值"会撒谎；真机那阵"PhonePad 一直有信号"其实是 Nuendo 在回灌

用户报：「现在的状态和之前一模一样，N67 始终处于有信号的状态无法被中止，点击 bridge 的
『全部停』也没有作用。LoopMIDI 中的『PhonePad』端口不断有信号传输」。
查完是**两件不同的事**：一件是 Bridge 的显示 bug（已修），另一件**不在 Bridge 这边**
（Nuendo 自己在往同一个端口写），而后者才是"端口一直有信号"的来源。

---

## 1. 修掉的：PC 窗口的"当前值"松开后不清空

`pad_note_off()` 发完 Note Off **不碰 `last_cc_output`**，`pad_all_off()` 也不碰。而窗口那一行
（`Note N67` / `CC1 64`）就是读它渲染的，于是**最后一次按下时的 `Note N67` 会一直挂在窗口上**——
松开、清场、重启都改不掉（只有再按别的格子才会被覆盖）。MIDI 侧其实早就干净了，但窗口在撒谎，
看起来正是"这条 Note 卡住了、点『全部停』也没用"。

改法：`pad_note_off()` 与 `pad_all_off()` 都把 `last_cc_output` 清空（窗口显示 `—` / `cc: --`）。
附两条断言：松开后清空、清场后清空（`bridge_pad_check.py` 72 → 74）。

## 2. 查实的："PhonePad 一直有信号"与 Bridge 无关

用 `tools/pad_monitor.py` + 一个抓包统计脚本量了 5 秒：

| 指标 | 测量值 |
|------|--------|
| 速率 | **4782 条 / 5 秒 ≈ 956 条/秒** |
| 类型 / 力度 | 全部 `note_off`（力度 0）——**一条 Note On 都没有** |
| 通道 | **15（= MIDI 通道 16）**，即面板输出那条通道 |
| 音符 | **固定 16 个**：36,37,38, 42–51, 65,66,67，循环重复 |
| 突发 | ~60 次/秒 × 每次 16 条（≈ 一帧 16.7 ms 一轮） |

**决定性实验**：把两个 `MIDI Deck` 进程**全部杀掉**（`MIDI Deck 还剩: 0`）之后再量 5 秒——
**954 条/秒，音符、通道、突发节律一模一样**。所以写这个端口的是**另一个进程**；当时机器上在跑的
MIDI 应用只有 loopMIDI、MidiSrv 和 **Nuendo15**（13:12 启动），而 loopMIDI/MidiSrv 不会自己发消息。

再对上两条特征：

- **60 Hz（16.7 ms 一轮）** 与 Bridge 里任何一个定时器都不符（只有 50 ms 的窗口轮询与 100 ms 的
  两个看门狗）；Bridge 自己的清场是**48 个连号音符各来一次**并每次都写日志，而日志里那段时间
  一条清场都没有。
- **固定 16 个音符**（不是 36–83 连号）正好是"DAW 里映射了的那十几个控件"的形状。

结论：**Nuendo 在往 PhonePad 写**——MIDI Remote 设备的**输出/回灌**（或某条 MIDI 轨把 PhonePad
同时当输入与输出形成的 thru 环）；它一旦被点着就会自我维持（收到的每条都被再送一遍），
所以"停不下来"。"全部停"、重启 Bridge 都无效，因为**Bridge 没法阻止别的程序写端口**。

**止血**：Nuendo → MIDI Remote 里那个设备，把 **MIDI 输出设为「未连接」**（Spec §6 明确不做状态
回读，不需要反馈端口），或重启 Nuendo / 重新加载该 Remote 设备。之后再用
`python tools\pad_monitor.py --seconds 5` 复核：应当是**一条消息都没有**。

## 3. 文档与产物

- `bridge/server.py`：`pad_note_off()` / `pad_all_off()` 清 `last_cc_output`。
- `tests/bridge_pad_check.py`：+2 条断言（72 → 74）。
- `docs/guide/nuendo-shortcut-pad.md`：故障表新增一行——"端口一直有信号，**关掉 Bridge 也照样有**"
  → 指向 Nuendo 的回灌与判据（固定十几条 note @ ~60 Hz）。
- `bridge/dist/MIDI Deck.exe` 重打包。
