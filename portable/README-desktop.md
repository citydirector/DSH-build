# Windows 桌面端（绿色便携）

同一 Release 里的 `dsh-desktop-win64-*.zip`：**Electron 外壳 + 内置 dsh 运行时**。整棵目录解压即用，功能与 Web 便携版一致，但跑在独立窗口里（默认端口 19387，与 Web 的 3080 不冲突）。

1. 下载 `dsh-desktop-win64-*.zip`，解压到**短路径**目录（如 `D:\dsh-desktop`）。包内 Python 运行时的 `site-packages` 路径较长，放在很深的目录里可能撞上 Windows 的 MAX_PATH 限制
2. 双击 `DeepSeek Harness.exe`
3. 想直接接管现有数据：把便携版 `data/` 的内容复制进包内 `data/`（桌面端用自己的 profile：`data/profiles/desktop`，本包已预置常用配置与自定义预设）

**绿色承诺**：可执行文件旁有 `portable.flag` 时，`DSH_HOME` = 包内 `data/`，Electron 的 `userData`/`sessionData`/`cache`/`logs`/`crashDumps` 也全部重定向到 `data/electron/` —— 不写注册表、不写 C 盘用户目录；删除整个目录即彻底卸载。

## 目录结构

```
dsh-desktop/
├── DeepSeek Harness.exe   # Electron 外壳（已编入便携引导）
├── resources/app.asar     # 外壳与客户端产物（含便携引导：DSH_HOME 重定向 + 会话迁移钩子）
├── resources/app.asar.unpacked/dsh/    # 内置运行时的原生二进制
├── resources/runtime/      # Electron 运行时（pnpm / office-skills / primary-runtime：Python 等）
├── resources/dsh-build/migrate-sessions-v4.mjs   # 会话代际迁移器（构建期生成）
├── update.exe              # 更新器（清单驱动，见下）
├── update.json             # 包身份清单
├── VERSION                 # 当前构建的上游 commit sha
├── portable.flag           # 便携开关
└── data/                   # 用户数据（更新时整棵不动）
    ├── electron/           # Chromium userData 重定向目标
    ├── profiles/desktop/   # 桌面端 profile（含预置配置与预设）
    └── .migrations/        # 会话迁移标记（每个 VERSION 一份）
```

## 更新（`update.exe`，清单驱动）

桌面包内自带 `update.exe`，与便携版是**同一份源码**（`portable/dsh-updater.cs`）；它的身份由包内 `update.json` 决定：

```json
{
  "kind": "desktop",
  "channelTags": { "main": "dsh-master-latest", "dev": "dsh-dev-latest" },
  "assetPrefix": "dsh-desktop-win64",
  "versionFile": "VERSION",
  "mirror": ".",
  "preserve": ["data"],
  "processNames": ["DeepSeek Harness"],
  "expectEntry": "DeepSeek Harness.exe",
  "zipName": "dsh-desktop.zip"
}
```

- 只认 **`dsh-desktop-win64-*`** 资产（不会误拉便携版）；通道 tag 与便携版相同，按 `2` 切 dev
- 覆盖方式：`robocopy /MIR /XD <包>\data` —— **只换程序，`data/` 整棵不动**；覆盖前自动备份到 `data/backups/`
- 桌面端在运行时拒绝更新（进程名来自清单的 `processNames`）；更新包缺 `expectEntry` 时中止，不做半截覆盖
- 没有 `update.json` 的包（便携版）→ 行为与原来逐字节一致：app/node 镜像 + `dsh-portable-win64` + `releases/latest`

## 关闭了上游自带更新

上游 Electron 端自带两条更新通路：electron-updater feed 与 Platform 强制更新策略。自建版在**构建期**把两者关掉：

- unsigned 构建的 electron-builder `publish` 本来就是 `null` → 产物里没有 `app-update.yml`，electron-updater 没有可更新的来源
- `patch-desktop-update.mjs` 把产物 manifest 的 `dshMandatoryUpdatePolicy` 置为 `undefined` → 运行时读不到策略，不请求 Platform、不弹“必须更新”遮罩

`portable/verify-desktop.mjs` 会把这两点当作硬验收项。

## 构建期补丁（`portable/patch-desktop-*.mjs`）

| 补丁 | 作用 |
|---|---|
| `patch-desktop-update.mjs` | 产物 manifest 不嵌 Platform 策略（1 处） |
| `patch-desktop-portable.mjs` | 在 `apps/desktop/src/main.ts` 首行注入便携引导（`desktop-files/dsh-portable-bootstrap.ts`）：DSH_HOME 与 Electron 目录重定向 + 按 VERSION 跑一次会话迁移 |
| `patch-desktop-toolchain.mjs` | 三处“只服务安装器或深层目录”的步骤加显式开关：VS 预检、NSIS 安装器 UI 准备、打包后冒烟 |
| `patch-desktop-runtime-patch.mjs` | 禁止打包流程内部重跑 `build:official`（否则会覆盖已经打好的 P1） |

复用便携版已有的 `portable/patch-native-code.mjs`（P1：native-code 守卫 + v2→v3 白名单），**必须**打在“已构建的 lib”上、且在运行时段打成 tarball 之前。

## 流水线与验收

`portable/build-desktop.mjs`（CI 里由 `desktop` job 调用）：

1. 打四组源码补丁（幂等；锚点变了就报错，绝不静默跳过）
2. `pnpm run build:official`
3. P1：`patch-native-code.mjs` 扫已构建的 `lib`
4. 生成会话迁移器 `migrate-sessions-v4.mjs`
5. 打包：`pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned -- --dir`（免签名、只出解包目录；带 `DSH_DESKTOP_SKIP_INTERNAL_BUILD=1`）
6. 组装绿色包：复制 `win-unpacked` + 写 `portable.flag`/`VERSION`/`update.json` + 放迁移器与 `update.exe` + `data/` 骨架 + 复制 `portable/desktop-seed/`
7. 压缩为 `dsh-desktop-win64-<sha>.zip`，并跑 `portable/verify-desktop.mjs` 做静态验收（24 项：无 feed、manifest 无策略、便携引导已编入、三项运行时补丁都在产物里、数据布局与习惯种子齐全）

本机调试（可选环境变量）：`DSH_DESKTOP_SOURCE` 指上游检出、`DSH_DESKTOP_TAG` 指 sha、`DSH_DESKTOP_OUT` 产出目录、`DSH_DESKTOP_EXTRA_PATH`/`DSH_DESKTOP_TEMP_DIR` 补本机 PATH 与临时目录。
