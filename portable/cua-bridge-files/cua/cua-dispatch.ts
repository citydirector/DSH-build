/**
 * Host-facing dispatch surface for the platform CUA provider.
 *
 * 一个 Host 里只有一个 computerUse provider 槽。宿主插件（例如 ui-locate）需要“用当前授权截图 + 坐标点击”
 * 时，不能再装第二个 provider，也不能自己起 NativeClient —— 它没有应用授权、没有 Agent 身份、没有取消与
 * 清理责任。所以这里只把**同一个** `ToolDefinition.execute` 暴露出去：授权、Agent 身份、AbortSignal、
 * 客户端生命周期、坐标账本、pending 与退出清理全部沿用上游那一条执行链。
 *
 * 边界（刻意保持最小）：
 *   - 只接受本 Host 里**正在执行**的那一个 execution 对象（`tools/execute` 包装器登记，调用结束即注销）；
 *   - 不缓存 execution，不跨调用复用，不提供任何 HTTP 入口；
 *   - 服务注册在 installCua 的 `dsh-cua.runtime` effect 里，provider 撤销即 withdraw。
 */
import type { Context } from '@deepseek-ai/cordis'
import { ToolContextUnavailableError, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { checkDispatch, DispatchRejection, LiveDispatchRegistry } from './cua-dispatch-guard.ts'

/** 契约版本；宿主必须据此确认字段语义。 */
export const CUA_DISPATCH_VERSION = 1 as const

/**
 * 桥接执行上下文：与 `ToolDefinition.execute` 的第二个形参同形。
 *
 * `ToolRunContext` 自身没有从 `@deepseek-ai/dsh-tools` 导出，所以结构化声明它的两个 hook；
 * 形参用 `unknown`（逆变位置）而不是 `never`，这样调用方整个 `ToolRunContext` 都算兼容。
 */
export type DispatchRunExecution = ToolExecution & {
  deferContext(context: unknown): void
  concludeTurn(): void
}

/** 宿主可见的分发面。 */
export interface CuaDispatchExtension {
  readonly version: typeof CUA_DISPATCH_VERSION
  /**
   * 用请求者自己的 execution 执行一次原生 CUA 请求。
   * @param request - 与 `cua` 工具完全相同的请求对象（未解析，由执行链校验）。
   * @param execution - 本次调用的真实执行上下文；其 agent/signal 会被原样沿用。
   */
  execute(request: unknown, execution: DispatchRunExecution): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 平台 CUA provider 在注册期间提供的受控分发面。 */
    cuaDispatch: CuaDispatchExtension
  }
}

/**
 * 发布 `ctx.cuaDispatch`，并返回撤销函数（由调用方的 effect 持有）。
 *
 * 同时挂一个 `tools/execute` 包装器：它只登记/注销同一个对象身份，不改参数、不改结果、
 * 不改并发顺序 —— 这是「活跃调用」的唯一可信来源。
 *
 * @param ctx - provider 作用域的 Host context。
 * @param tool - installCua 构造的同一个 CUA ToolDefinition。
 */
export function installCuaDispatch(ctx: Context, tool: ToolDefinition): () => void {
  const live = new LiveDispatchRegistry()
  const off = ctx.on('tools/execute', async (exec, next) => {
    live.begin(exec)
    try {
      return await next()
    } finally {
      live.end(exec)
    }
  })
  const dispatch: CuaDispatchExtension = Object.freeze({
    version: CUA_DISPATCH_VERSION,
    execute(request: unknown, execution: DispatchRunExecution): Promise<unknown> {
      try {
        checkDispatch(live, ctx.agents, execution)
      } catch (error) {
        if (error instanceof DispatchRejection) throw new ToolContextUnavailableError(error.message)
        throw error
      }
      return tool.execute(request, execution)
    },
  })
  const withdraw = ctx.provide('cuaDispatch', dispatch)
  return () => {
    withdraw()
    off()
  }
}
