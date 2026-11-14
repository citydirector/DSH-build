// patch-cua-ui-locate-bridge.mjs <upstream-repo-root> [--check]
//
// 给官方 CUA 加一条「宿主可直接用」的受控通路，并给坐标点击加后台投递选项。做四件事，全部幂等：
//
//   1. 分发面：新增 `packages/experimental/cua/src/cua-dispatch.ts`（+ 纯判定 `cua-dispatch-guard.ts`），
//      把 installCua 里**同一个** ToolDefinition.execute 暴露成 `ctx.cuaDispatch`。授权、Agent 身份、
//      AbortSignal、原生客户端、坐标账本、pending 与退出清理都沿用上游那一条链，不新增 provider、
//      不新起 NativeClient、不提供 HTTP 入口；随 provider effect 撤销。
//   2. 系统输入仲裁：新增 `system-input-queue.ts`，并在 tool.execute 的公共 dispatch 入口按方法
//      （click/mouseMove/scroll/drag/typeText/pressKey/sendKeyEvent/paste/activate/show）取有界 FIFO 令牌。
//      一个 Host 进程一份，取消的排队动作不执行，溢出返回 INPUT_BUSY；剪贴板锁保持原样。
//   3. 后台投递：`click` 增加 `deliveryMode: 'background' | 'foreground'`（协议 schema + 能力位 +
//      guidance）。原生 Windows 只新增 PostMessage 分支：不激活、不动系统指针、不碰键盘；
//      **白名单**——根窗口必须是 #32770 标准对话框、命中点下的控件必须是标准 Win32 控件类，
//      且命中窗口与目标同进程；有修饰键 / holdMs / elementId / 名单外类名 / 类名取不到一律
//      BACKGROUND_UNAVAILABLE，绝不自动降级前台。
//   4. 宿主侧文件不在这里打补丁：ui-locate 的 Host 插件在它自己的仓库里维护。
//
// 红线：不 fork 上游、只以补丁形式存在；锚点缺失或命中多次一律抛错（宁可构建失败）；
// 已打过就跳过（幂等）；`--check` 只读校验不写盘。
import { createHash } from 'node:crypto'

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'

import { dirname, join, relative, sep } from 'node:path'

import { fileURLToPath } from 'node:url'

import { applyEditsToFiles, applyEditsToText } from './lib/apply-edits.mjs'

const LABEL = 'patch-cua-ui-locate-bridge'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES = join(HERE, 'cua-bridge-files')

const CUA = 'packages/experimental/cua/src'
const WINDOWS = 'packages/experimental/cua-windows'

/** 需要拷进上游树的新文件（源文件在本仓，随包一起走）。 */
const COPIES = [
  { from: join(FILES, 'cua/cua-dispatch.ts'), to: `${CUA}/cua-dispatch.ts` },
  { from: join(FILES, 'cua/cua-dispatch-guard.ts'), to: `${CUA}/cua-dispatch-guard.ts` },
  { from: join(FILES, 'cua/system-input-queue.ts'), to: `${CUA}/system-input-queue.ts` },
]

/** 锚点替换。每条都必须恰好命中一次，`to` 已存在则跳过。 */
const EDITS = [
  {
    name: 'cua: import 分发面与输入闸门',
    file: `${CUA}/index.ts`,
    from: "import { fixedScreenshotTarget, installCuaTools } from './tool-registration.ts'",
    to: "import { fixedScreenshotTarget, installCuaTools } from './tool-registration.ts'\n"
      + "import { installCuaDispatch } from './cua-dispatch.ts'\n"
      + "import { SHARED_INPUT_METHODS, systemInputQueue } from './system-input-queue.ts'",
  },
  {
    name: 'cua: 发布 ctx.cuaDispatch（随 runtime effect 撤销）',
    file: `${CUA}/index.ts`,
    from: '    yield installCuaTools(ctx, config, tool, guidance, programGuidance)\n  }, \'dsh-cua.runtime\')',
    to: '    yield installCuaTools(ctx, config, tool, guidance, programGuidance)\n'
      + '    yield installCuaDispatch(ctx, tool)\n  }, \'dsh-cua.runtime\')',
  },
  {
    name: 'cua: 系统输入统一走有界队列',
    file: `${CUA}/index.ts`,
    from: '          const dispatch = async (signal: AbortSignal) => {\n'
      + '            const scoped = { ...execution, agent, signal, nativeClient, coordinates: owner.coordinates }\n'
      + '            const result = await callNative(request, scoped, route?.useSystemPointer)\n'
      + '            signal.throwIfAborted()\n'
      + '            return result\n'
      + '          }',
    to: '          const dispatch = async (signal: AbortSignal) => {\n'
      + '            const scoped = { ...execution, agent, signal, nativeClient, coordinates: owner.coordinates }\n'
      + '            // 系统鼠标/键盘/焦点是整台桌面共享的：模型直调与宿主桥接共用同一份有界 FIFO 令牌。\n'
      + '            const release = SHARED_INPUT_METHODS.has(request.method) ? await systemInputQueue.acquire(signal) : undefined\n'
      + '            try {\n'
      + '              const result = await callNative(request, scoped, route?.useSystemPointer)\n'
      + '              signal.throwIfAborted()\n'
      + '              return result\n'
      + '            } finally {\n'
      + '              release?.()\n'
      + '            }\n'
      + '          }',
  },
  {
    name: 'cua: getCapabilities 上报 deliveryModes',
    file: `${CUA}/index.ts`,
    from: '          keyboard: [...capabilities.keyboard],\n'
      + '          browser: capabilities.browser,\n'
      + '          coordinateSpace: capabilities.coordinateSpace,\n'
      + '        }',
    to: '          keyboard: [...capabilities.keyboard],\n'
      + '          browser: capabilities.browser,\n'
      + '          coordinateSpace: capabilities.coordinateSpace,\n'
      + '          deliveryModes: [...(capabilities.deliveryModes ?? [\'foreground\'])],\n'
      + '        }',
  },
  {
    name: 'cua: click 增加 deliveryMode',
    file: `${CUA}/protocol.ts`,
    from: 'const click = { ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional(),\n'
      + '  holdMs: z.number().int().nonnegative().optional()\n'
      + "    .describe('Milliseconds between each mouse press and release; omitted for an ordinary click.') }",
    to: 'const click = { ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional(),\n'
      + '  holdMs: z.number().int().nonnegative().optional()\n'
      + "    .describe('Milliseconds between each mouse press and release; omitted for an ordinary click.'),\n"
      + "  deliveryMode: z.enum(['background', 'foreground']).optional()\n"
      + "    .describe('How a coordinate click reaches the target. background posts window messages without activating the window or moving the system pointer; a target that cannot take it fails with BACKGROUND_UNAVAILABLE instead of falling back.') }",
  },
  {
    name: 'cua: 能力声明增加 deliveryModes',
    file: `${CUA}/types.ts`,
    from: '> & { systemPointer?: boolean }',
    to: "> & { systemPointer?: boolean; deliveryModes?: readonly ('background' | 'foreground')[] }",
  },
  {
    name: 'cua-windows: 声明后台投递能力',
    file: `${WINDOWS}/src/index.ts`,
    from: "  browser: false,\n  coordinateSpace: 'screenshot-pixels',\n}",
    to: "  browser: false,\n  coordinateSpace: 'screenshot-pixels',\n  deliveryModes: ['foreground', 'background'],\n}",
  },
  {
    name: 'cua-windows: guidance 说明后台投递',
    file: `${WINDOWS}/src/guidance.ts`,
    from: '/** Native operation instructions; the shared Host adds guidance for declared capabilities. */\n'
      + 'export const GUIDANCE = `${PLATFORM_GUIDANCE}',
    to: '/** Background delivery semantics; kept beside the guidance the Host already prefixes. */\n'
      + 'const DELIVERY_GUIDANCE = \'Coordinate clicks also accept deliveryMode "background" (window messages only: no activation, no system-pointer move, no keyboard state) or "foreground" (the normal simulated path, which keeps its own foreground check). background is limited to unmodified left or right single/double clicks on pixel coordinates inside a proven standard Win32 stack: a "#32770" dialog root with a Button/Edit/Static/ComboBox/SysListView32/SysTreeView32/ToolbarWindow32/ReBarWindow32/msctls_* control under the point. Modifiers, holdMs, element clicks, an obscured coordinate, a window owned by another process, or any other root/control class (games, Chromium/Electron content, WinUI3/UWP, custom-drawn surfaces) fail with BACKGROUND_UNAVAILABLE and never fall back automatically.\'\n'
      + '\n'
      + '/** Native operation instructions; the shared Host adds guidance for declared capabilities. */\n'
      + 'export const GUIDANCE = `${PLATFORM_GUIDANCE}\n'
      + '\n'
      + '${DELIVERY_GUIDANCE}',
  },
  {
    name: 'cua-windows: 原生声明 PostMessage/ScreenToClient/GetClassName',
    file: `${WINDOWS}/native/entry/Win32.cs`,
    from: '    [DllImport("user32.dll")] internal static extern nint WindowFromPoint(Point point);',
    to: '    [DllImport("user32.dll")] internal static extern nint WindowFromPoint(Point point);\n'
      + '    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "PostMessageW")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool PostMessage(nint window, uint message, nint wParam, nint lParam);\n'
      + '    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ScreenToClient(nint window, ref Point point);\n'
      + '    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(nint window, StringBuilder name, int capacity);',
  },
  {
    name: 'cua-windows: click 分支消费 deliveryMode',
    file: `${WINDOWS}/native/entry/DesktopExecutor.cs`,
    from: '                    var modifiers = Modifiers(parameters);\n'
      + '                    (WindowState Window, double X, double Y) pointer;',
    to: '                    var modifiers = Modifiers(parameters);\n'
      + '                    var delivery = OptionalString(parameters, "deliveryMode") ?? "foreground";\n'
      + '                    if (delivery != "foreground" && delivery != "background")\n'
      + '                        throw new NativeFailure("INVALID_ARGUMENT", "deliveryMode must be background or foreground");\n'
      + '                    if (delivery == "background" && (parameters.TryGetProperty("elementId", out _) || hold is not null))\n'
      + '                        throw new NativeFailure("BACKGROUND_UNAVAILABLE", "Background delivery supports plain pixel clicks; element clicks and holdMs need the explicit foreground path");\n'
      + '                    (WindowState Window, double X, double Y) pointer;',
  },
  {
    name: 'cua-windows: 后台点击走消息投递',
    file: `${WINDOWS}/native/entry/DesktopExecutor.cs`,
    from: '                    else pointer = Coordinate(app, parameters, context);\n'
      + '                    if (hold is { } held) await Input.HoldClick(app, pointer.Window, pointer.X, pointer.Y, button, count, modifiers, held, context);',
    to: '                    else pointer = Coordinate(app, parameters, context);\n'
      + '                    if (delivery == "background")\n'
      + '                    {\n'
      + '                        Input.ClickBackground(app, pointer.Window, pointer.X, pointer.Y, button, count, modifiers, context);\n'
      + '                        return new { dispatched = true, foregroundChanged = (bool?)null, deliveryMode = "background" };\n'
      + '                    }\n'
      + '                    if (hold is { } held) await Input.HoldClick(app, pointer.Window, pointer.X, pointer.Y, button, count, modifiers, held, context);',
  },
  {
    name: 'cua-windows: Input.cs 引入 StringBuilder',
    file: `${WINDOWS}/native/entry/Input.cs`,
    from: 'using System.Runtime.InteropServices;\nusing DeepSeek.Cua.Protocol;',
    to: 'using System.Runtime.InteropServices;\nusing System.Text;\nusing DeepSeek.Cua.Protocol;',
  },
  {
    name: 'cua-windows: 新增后台点击实现',
    file: `${WINDOWS}/native/entry/Input.cs`,
    from: '    internal static async Task HoldClick(AppState app, WindowState window, double x, double y, string button, int count, string[] modifiers, int holdMs, RequestContext context)',
    to: [
      '    private const uint WmLButtonDown = 0x0201, WmLButtonUp = 0x0202, WmLButtonDblClk = 0x0203;',
      '    private const uint WmRButtonDown = 0x0204, WmRButtonUp = 0x0205, WmRButtonDblClk = 0x0206;',
      '    private const uint MkLButton = 0x0001, MkRButton = 0x0002;',
      '',
      '    /// 后台投递只覆盖**已证明会处理 posted pointer 消息**的标准 Win32 栈：',
      '    /// 根窗口必须命中 BackgroundRootClasses，命中点下的子窗口必须命中 BackgroundControlClasses。',
      '    /// 游戏自绘层、Chromium/Electron 内容层、WinUI3/UWP 的 CoreInput 派发器都不在名单内 → 一律拒绝。',
      '    /// 名单只在真正验证过某个类之后才增补；取不到类名同样拒绝，不猜测“也许能收”。',
      '    private static readonly string[] BackgroundRootClasses =',
      '    [',
      '        "#32770", // 标准对话框：消息泵由 User32 的 dialog manager 自己驱动',
      '    ];',
      '',
      '    private static readonly string[] BackgroundControlClasses =',
      '    [',
      '        "Button", "Edit", "Static", "ComboBox", "ComboBoxEx32", "RichEdit20W", "RichEdit50W",',
      '        "SysListView32", "SysTreeView32", "SysHeader32", "ToolbarWindow32", "ReBarWindow32",',
      '        "msctls_trackbar32", "msctls_updown32", "msctls_progress32", "msctls_statusbar32", "msctls_hotkey32",',
      '    ];',
      '',
      '    /// 后台投递：只 post 窗口消息。不激活窗口、不移动系统指针、不改键盘状态。',
      '    /// 投递成功只代表消息进了队列，不代表目标处理了它——验证责任在调用方（再次截图比像素）。',
      '    internal static void ClickBackground(AppState app, WindowState window, double x, double y, string button, int count, string[] modifiers,',
      '        RequestContext context)',
      '    {',
      '        if (modifiers.Length != 0)',
      '            throw new NativeFailure("BACKGROUND_UNAVAILABLE", "Background delivery cannot hold modifier keys without touching global keyboard state; use deliveryMode=foreground explicitly");',
      '        if (button != "left" && count != 1)',
      '            throw new NativeFailure("UNSUPPORTED", "Only left clicks support double-click");',
      '        var geometry = window.RequireObservation(app, context);',
      '        var point = WindowState.Point(geometry, x, y);',
      '        var hit = Win32.WindowFromPoint(point);',
      '        if (hit == 0) throw new NativeFailure("BACKGROUND_UNAVAILABLE", "No window answers at the target coordinate");',
      '        var root = Win32.GetAncestor(hit, 2);',
      '        if (root != window.Handle)',
      '            throw new NativeFailure("WINDOW_OBSCURED", "Another window covers the target coordinate; restore or raise the selected window and observe again");',
      '        // 归属校验：命中窗口必须属于被观察的那一个进程，防止同一坐标上盖着别人的窗口。',
      '        // GetWindowThreadProcessId 返回线程 id（uint），不是 bool —— 只能看 out 的 pid。',
      '        Win32.GetWindowThreadProcessId(hit, out var hitProcess);',
      '        if (hitProcess != (uint)window.ProcessId)',
      '            throw new NativeFailure("BACKGROUND_UNAVAILABLE", "The window under the coordinate belongs to another process; re-observe the target");',
      '        var rootName = ClassName(root);',
      '        if (rootName.Length == 0 || Array.IndexOf(BackgroundRootClasses, rootName) < 0)',
      '            throw new NativeFailure("BACKGROUND_UNAVAILABLE", $"Root window class {Describe(rootName)} is outside the proven background set; background delivery refuses unknown input stacks and never falls back — use deliveryMode=foreground explicitly if the focus change is acceptable");',
      '        var name = ClassName(hit);',
      '        if (name.Length == 0 || Array.IndexOf(BackgroundControlClasses, name) < 0)',
      '            throw new NativeFailure("BACKGROUND_UNAVAILABLE", $"Control class {Describe(name)} is outside the proven background set; background delivery refuses unknown input stacks and never falls back — use deliveryMode=foreground explicitly if the focus change is acceptable");',
      '        if (!Win32.ScreenToClient(hit, ref point))',
      '            throw new NativeFailure("BACKGROUND_UNAVAILABLE", "The target window rejected client coordinate conversion");',
      '        var lparam = (nint)((point.Y << 16) | (point.X & 0xFFFF));',
      '        var messages = button switch',
      '        {',
      '            "left" => (Down: WmLButtonDown, Up: WmLButtonUp, DoubleClick: WmLButtonDblClk, Held: (nint)MkLButton),',
      '            "right" => (Down: WmRButtonDown, Up: WmRButtonUp, DoubleClick: WmRButtonDblClk, Held: (nint)MkRButton),',
      '            _ => throw new NativeFailure("INVALID_ARGUMENT", "Unknown mouse button"),',
      '        };',
      '        context.Check();',
      '        Post(hit, messages.Down, messages.Held, lparam);',
      '        Post(hit, messages.Up, 0, lparam);',
      '        if (count == 2)',
      '        {',
      '            Post(hit, messages.DoubleClick, messages.Held, lparam);',
      '            Post(hit, messages.Up, 0, lparam);',
      '        }',
      '        // 投递期间窗口若被换掉，这次动作就不再属于原目标。',
      '        window.RequireCurrent(app, context);',
      '    }',
      '',
      '    private static string ClassName(nint window)',
      '    {',
      '        var buffer = new StringBuilder(256);',
      '        var length = Win32.GetClassName(window, buffer, buffer.Capacity);',
      '        return length > 0 ? buffer.ToString() : "";',
      '    }',
      '',
      '    /// 诊断用：类名取不到时回一个能读懂的占位，而不是把空串塞进错误消息。',
      '    private static string Describe(string name) => name.Length == 0 ? "<unavailable>" : name;',
      '',
      '    private static void Post(nint window, uint message, nint wParam, nint lParam)',
      '    {',
      '        if (!Win32.PostMessage(window, message, wParam, lParam))',
      '            throw new NativeFailure("INPUT_BLOCKED", "The target window rejected the posted pointer message");',
      '    }',
      '',
      '    internal static async Task HoldClick(AppState app, WindowState window, double x, double y, string button, int count, string[] modifiers, int holdMs, RequestContext context)',
    ].join('\n'),
  },
]

/** 只读校验：逐条比对锚点与幂等状态，不写任何文件。 */
function verify(root) {
  const report = []
  for (const copy of COPIES) {
    if (!existsSync(copy.from)) throw new Error(`${LABEL}: missing injected file ${copy.from}`)
    report.push(`${copy.to}: ${existsSync(join(root, copy.to)) ? 'present' : 'to copy'}`)
  }
  const files = [...new Set(EDITS.map((edit) => edit.file))]
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    const own = EDITS.filter((edit) => edit.file === file)
    const pending = own.filter((edit) => !text.includes(edit.to))
    if (pending.length === 0) {
      report.push(`${file}: applied`)
      continue
    }
    for (const edit of pending) {
      const shapes = Array.isArray(edit.from) ? edit.from : [edit.from]
      const counts = shapes.map((from) => text.split(from).length - 1)
      if (!counts.includes(1) || counts.some((count) => count > 1)) {
        throw new Error(`${LABEL}: ${edit.name}: expected exactly 1 occurrence in ${file}, found ${JSON.stringify(counts)}`)
      }
    }
    report.push(`${file}: ${pending.length} pending`)
  }
  return report
}

/**
 * 给一份上游 checkout 打补丁。
 * @param {string} root - 上游仓根目录。
 * @param {{ check?: boolean }} [options] - check 为真时只校验，不写盘。
 * @returns {string[]} 每个文件的处理结果。
 */
export function patchCuaUiLocateBridge(root, options = {}) {
  if (options.check === true) return verify(root)
  for (const copy of COPIES) {
    if (!existsSync(copy.from)) throw new Error(`${LABEL}: missing injected file ${copy.from}`)
    const target = join(root, copy.to)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target) && readFileSync(target, 'utf8') === readFileSync(copy.from, 'utf8')) continue
    copyFileSync(copy.from, target)
  }
  const { applied } = applyEditsToFiles(root, EDITS, LABEL)
  const files = [...new Set(EDITS.map((edit) => edit.file))]
  return files.map((file) => `${file}: ${applied.filter((name) => {
    const edit = EDITS.find((candidate) => candidate.name === name)
    return edit !== undefined && edit.file === file
  }).length} edits`)
}

/**
 * helper 源码身份：整棵 `cua-windows/native` 树的摘要（相对路径 + 内容，忽略 bin/obj）。
 *
 * 为什么需要它：helper 是 `dotnet publish` 出来的二进制，上游 SHA 相同并不代表产物相同——
 * 本次本地 native 补丁（PostMessage 后台分支）会改变行为。把这份摘要写进 helper 清单，
 * 才能区分「上游同一个 SHA 的旧 helper」与「打过本补丁的新 helper」。
 *
 * @param {string} root - 上游仓根目录。
 * @returns {{ digest: string, files: Record<string, string> }} digest 形如 `sha256:…`，files 逐文件摘要。
 */
export function hashNativeTree(root) {
  const dir = join(root, 'packages/experimental/cua-windows/native')
  if (!existsSync(dir)) throw new Error(`${LABEL}: missing native tree ${dir}`)
  const files = []
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'bin' || entry.name === 'obj') continue
        walk(full)
        continue
      }
      if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  const overall = createHash('sha256')
  const perFile = {}
  for (const full of files) {
    const key = relative(dir, full).split(sep).join('/')
    const bytes = readFileSync(full)
    perFile[key] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    overall.update(`${key}\u0000`).update(bytes).update('\u0000')
  }
  return { digest: `sha256:${overall.digest('hex')}`, files: perFile }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const digest = args.includes('--digest')
  const root = args.find((value) => value !== '--check' && value !== '--digest')
  if (root === undefined) throw new Error(`用法: node ${LABEL}.mjs <upstream-repo-root> [--check] [--digest]`)
  const parts = patchCuaUiLocateBridge(root, { check })
  if (digest) {
    const native = hashNativeTree(root)
    console.log(JSON.stringify({ kind: 'cua-helper-native-source', digest: native.digest, fileCount: Object.keys(native.files).length, files: native.files }))
    console.log(`${LABEL}: ${parts.join(' | ')} | native ${native.digest}`)
  } else {
    console.log(`${LABEL}: ${parts.join(' | ')}`)
  }
}
