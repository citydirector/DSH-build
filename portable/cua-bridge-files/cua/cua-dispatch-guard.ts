/**
 * 校验一个“转发执行上下文”是否仍是本 Host 的真实活动调用。
 *
 * 这个文件刻意不 import 任何运行时模块：它是纯判定函数，可以被 Node 直接类型擦除执行，
 * 因此测试不需要整套 dsh 依赖就能覆盖伪造/过期上下文。
 *
 * 两层判定缺一不可：
 *   1. 身份 —— `LiveDispatchRegistry` 只在 `tools/execute` 包装器内登记真实执行对象，
 *      调用一结束就删除；宿主复制一份、或调用结束后继续留着的 execution 都不在表里。
 *   2. token —— 执行器铸造的 token 是真 symbol（`ToolExecutionToken = symbol & brand`），
 *      外部无法铸造同值；伪造壳即使抄走 callId，也拿不到同一个 token。
 */

/** `ctx.agents` 的最小形状：只用到身份查询。 */
export interface DispatchAgentLookup {
  get(id: string): unknown
}

/** 被转发执行对象里本模块读取的字段。 */
interface ExecutionShape {
  callId?: unknown
  token?: unknown
  agent?: unknown
  signal?: unknown
}

/** 拒收原因；调用方负责把它翻译成 dsh 的 ToolContextUnavailableError。 */
export class DispatchRejection extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DispatchRejection'
  }
}

/** 通过校验后供调用方使用的最小事实。 */
export interface LiveDispatch {
  callId: string
  signal: AbortSignal
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false
  const signal = value as { aborted?: unknown; throwIfAborted?: unknown; addEventListener?: unknown }
  return typeof signal.aborted === 'boolean'
    && typeof signal.throwIfAborted === 'function'
    && typeof signal.addEventListener === 'function'
}

/**
 * 活跃调用登记表：只认对象身份，调用结束即删除。
 *
 * 与 dsh 自己的 `WeakMap<ToolRunContext, …>` 同构——「活跃」是执行器的事实，不是宿主能声明的东西。
 */
export class LiveDispatchRegistry {
  readonly #live = new Set<unknown>()

  /** `tools/execute` 包装器进入时登记；必须与 `end` 成对。 */
  begin(execution: unknown): void {
    this.#live.add(execution)
  }

  /** 包装器退出时注销（成功、抛错、取消都走这里）。 */
  end(execution: unknown): void {
    this.#live.delete(execution)
  }

  /** 是否仍是登记在册的那**一个对象**。 */
  has(execution: unknown): boolean {
    return this.#live.has(execution)
  }

  /** 当前活跃调用数，便于测试与诊断。 */
  get size(): number {
    return this.#live.size
  }
}

/**
 * 确认 execution 是本次调用真实持有的对象，而不是宿主拼出来的壳。
 * @param live - 由 `tools/execute` 包装器维护的活跃调用表。
 * @param agents - `ctx.agents`；用来确认 agent 仍在注册表里（同一对象身份，不是同名字符串）。
 * @param execution - 宿主传进来的执行上下文。
 */
export function checkDispatch(live: LiveDispatchRegistry, agents: DispatchAgentLookup, execution: unknown): LiveDispatch {
  if (typeof execution !== 'object' || execution === null) {
    throw new DispatchRejection('dsh-cua dispatch requires a tool execution')
  }
  const shape = execution as ExecutionShape
  if (typeof shape.callId !== 'string' || shape.callId.length === 0) {
    throw new DispatchRejection('dsh-cua dispatch execution is missing its call id')
  }
  // 执行器铸造的 token 是真 symbol；字符串、数字或缺失都说明这不是执行器给的上下文。
  if (typeof shape.token !== 'symbol') {
    throw new DispatchRejection('dsh-cua dispatch execution was not minted by the tool executor')
  }
  if (!live.has(execution)) {
    throw new DispatchRejection('dsh-cua dispatch execution is not an active call')
  }
  if (!isAbortSignal(shape.signal)) {
    throw new DispatchRejection('dsh-cua dispatch execution is missing a live cancellation signal')
  }
  const agent = shape.agent
  if (typeof agent !== 'object' || agent === null) {
    throw new DispatchRejection('dsh-cua requires an agent-owned execution')
  }
  const id = (agent as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) {
    throw new DispatchRejection('dsh-cua requires an agent-owned execution')
  }
  if (agents.get(id) !== agent) {
    throw new DispatchRejection('dsh-cua dispatch agent is no longer live')
  }
  // 已经取消的调用不许再进入原生层（中止原因原样抛出）。
  shape.signal.throwIfAborted()
  return { callId: shape.callId, signal: shape.signal }
}
