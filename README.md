# dsh-adobe-bridge

让 **DeepSeek Harness (DSH)** 直接操作本机的 **After Effects / Illustrator / Photoshop**——不是截图点鼠标，而是执行脚本、导出帧、把画面读回来。

Drive Adobe After Effects, Illustrator and Photoshop from [DeepSeek Harness](https://github.com/deepseek-ai) with real scripts, not GUI automation.

![AE demo](docs/demo-ae.png)

## 为什么需要它

- AE **没有** COM 接口，只能用 ExtendScript，而 ExtendScript 需要一个能持续对话的通道；
- AI / PS 有 COM，但每次手动拼 PowerShell 很痛苦；
- 这个插件把两者封装成四个工具，任何 DSH 会话里直接调用。

## 工作方式

```
DSH 会话
  │  adobe_ae_eval / adobe_ai_eval / adobe_ps_eval
  ▼
dsh-adobe-bridge（DSH 插件，宿主进程内）
  │                         │
  │ AE：127.0.0.1:8791      │ AI/PS：PowerShell + COM
  ▼                         ▼
AE CEP 面板               Illustrator / Photoshop
  │ evalScript
  ▼
After Effects 工程（合成/图层/关键帧/渲染）
```

- 插件**自带**本地桥（默认端口 `8791`），不需要额外跑服务端；
- 如果已经有独立桥占用端口，会自动复用它；
- 只监听 `127.0.0.1`，不对外网开放。

## 安装

### 1. 装插件

```powershell
dsh plugin --profile <你的配置档> add github:kcj07247-cpu/dsh-adobe-bridge
```

或本地路径：

```powershell
dsh plugin --profile <你的配置档> add file:C:/path/to/dsh-adobe-bridge
```

然后**完全重启 DSH**，新会话里应能看到四个 `adobe_*` 工具。

### 2. 装 AE 的 CEP 面板（只有 AE 需要）

以**普通用户**（不要管理员）运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-cep.ps1
```

脚本会：

1. 把 `cep-extension/` 复制到 `%APPDATA%\Adobe\CEP\extensions\com.dsh.aebridge`；
2. 打开 CEP 调试模式（写 `HKCU\Software\Adobe\CSXS.9~13\PlayerDebugMode = 1`）。

然后重启 After Effects，菜单：**窗口 → 扩展 → DSH AE Bridge**（Window → Extensions → DSH AE Bridge）。

面板打开后会自动轮询本地桥，`adobe_status` 会显示 `AE panel: online`。

> AI / PS 不需要面板，插件会通过 COM 自动启动它们。

### 3. 环境要求

- Windows（COM 与 CEP 都是 Windows 优先；AE 面板本身跨平台，但本项目只测了 Windows）；
- Adobe **2020 及以上**（AE 17+，CEP 9+）；
- DSH 桌面版，带 `@deepseek-ai/dsh-tools`。

## 工具

| 工具 | 说明 |
|---|---|
| `adobe_status` | 桥是否运行、AE 面板是否连接 |
| `adobe_ae_eval` | 在运行中的 AE 里执行 ExtendScript，返回字符串 |
| `adobe_ai_eval` | 在 Illustrator 里执行脚本（COM，自动启动） |
| `adobe_ps_eval` | 在 Photoshop 里执行脚本（COM，自动启动） |

### 示例：在 AE 里做一张卡片并导出

```js
(function () {
  var comp = app.project.items.addComp("Demo", 1920, 1080, 1, 5, 25);
  var layer = comp.layers.addShape();
  var group = layer.content.addProperty("ADBE Vector Group");
  var rect = group.content.addProperty("ADBE Vector Shape - Rect");
  rect.property("ADBE Vector Rect Size").setValue([900, 420]);
  rect.property("ADBE Vector Rect Roundness").setValue(44);
  var fill = group.content.addProperty("ADBE Vector Graphic - Fill");
  fill.property("ADBE Vector Fill Color").setValue([1, 0.478, 0.349]);
  layer.property("ADBE Transform Group").property("ADBE Position").setValue([960, 540]);

  comp.openInViewer();
  comp.saveFrameToPng(1.0, new File("C:/temp/ae-demo.png"));
  return "ok";
})()
```

脚本返回后读 `C:/temp/ae-demo.png` 就能看到结果。

## 踩坑记录（都已处理，写下来省得再撞）

| 现象 | 原因 / 处理 |
|---|---|
| `颜色数组没有 3 个值` | AE 的文本/形状颜色数组必须是 **3 个分量**（0–1），不要带 alpha |
| AE 坐标总是反的 | AE 合成坐标原点在**左上**；Illustrator 在**左下** |
| 导出的 PNG 是 0 字节 | `saveFrameToPng` 异步写入，等 1–2 秒再读 |
| 脚本写文件失败 | 先在脚本里执行 `app.preferences.savePrefAsLong("Scripting & Expressions", "Allow Scripts to Write Files and Access Network", 1)` |
| COM 报 `CO_E_SERVER_EXEC_FAILURE` | 应用被沙箱/权限挡住；直接在用户会话里启动一次应用即可 |
| 面板不在 Extensions 菜单 | 检查 `PlayerDebugMode`、扩展目录名与 `ExtensionBundleId` 是否一致 |
| 删图层时脚本静默失败 | 合成在 viewer 里时不要 `layer.remove()`，新建合成更稳 |

## 限制

- AE 面板必须保持打开；AE 重启后需要重新打开面板；
- 脚本是**异步**的：调用返回不代表文件已落盘；
- 复杂视觉仍需要人来定审美——这个插件解决的是“能不能操作”，不是“好不好看”。

## License

MIT
