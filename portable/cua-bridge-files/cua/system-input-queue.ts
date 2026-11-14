/**
 * 同一 Host 进程内的系统输入仲裁：鼠标点击、移动、滚动、拖拽与键盘写入共用一份有界 FIFO 队列。
 *
 * 为什么需要它：CUA 原生提供方按 Agent 各起一个 helper 进程，helper 里的排队只能管住自己那一条通道；
 * 而系统鼠标/键盘/焦点是整个桌面共享的资源，同一个 Host 里两个 Agent（或模型直调 cua 与宿主插件
 * 的桥接调用）同时投递就会互相抢占。因此队列挂在 TS 侧、由 `tool.execute` 的公共入口统一获取，
 * 一个 Host 进程一份。
 *
 * 语义：
 *   - 有界：等待者达到 `limit` 时直接抛 `INPUT_BUSY`，不无限堆积；
 *   - 可取消：排队期间 signal 中止的等待者立刻出队，且**永远不会**执行它保护的输入；
 *   - 公平：严格 FIFO，释放时直接把令牌交给队首，不重新竞争。
 *
 * 跨 Host 进程、跨 helper 进程不在此列（没有常驻 broker），不要声称它覆盖那些场景。
 */

/** 同时等待的输入上限（不含正在执行的那一个）。 */
export const MAX_WAITING_INPUTS = 8

/** 排队溢出时抛出的错误；`code` 与原生 provider 的失败码保持一致。 */
export class InputQueueFullError extends Error {
  readonly code = 'INPUT_BUSY'

  constructor() {
    super('Too many system-input actions are already queued; retry after the current one finishes')
    this.name = 'InputQueueFullError'
  }
}

/**
 * 需要共享系统鼠标/键盘/焦点的请求方法。UIA 专属操作（invoke/setValue/performAction 等）不在此列，
 * 它们走无障碍通道、不抢全局输入。
 *
 * `activate` / `show` 也算：它们**会改变前台窗口**，与随后的点击属于同一类全局状态竞争。
 */
export const SHARED_INPUT_METHODS: ReadonlySet<string> = new Set([
  'click', 'mouseMove', 'scroll', 'drag', 'typeText', 'pressKey', 'sendKeyEvent', 'paste', 'activate', 'show',
])

interface Waiter {
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

function abortedReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/** 有界、可取消、FIFO 的输入闸门。 */
export class SystemInputQueue {
  busy = false
  /** 当前等待中的动作数（不含正在执行者）。 */
  waiting: Waiter[] = []
  limit: number

  constructor(limit: number = MAX_WAITING_INPUTS) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('SystemInputQueue limit must be a positive integer')
    this.limit = limit
  }

  /** 排队长度，便于测试与诊断。 */
  get pending(): number {
    return this.waiting.length
  }

  /**
   * 取得一次输入许可。返回的释放函数幂等，必须在 finally 里调用。
   * @param signal - 调用方取消信号；排队中被取消的等待者不会拿到许可。
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortedReason(signal)
    if (!this.busy) {
      this.busy = true
      return this.releaser()
    }
    if (this.waiting.length >= this.limit) throw new InputQueueFullError()
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiting.indexOf(waiter)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(abortedReason(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiting.push(waiter)
    })
  }

  /** 构造一次性的释放函数；重复调用不会二次放行。 */
  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.handOver()
    }
  }

  /** 把令牌交给队首；没有等待者才真正空闲。 */
  private handOver(): void {
    while (this.waiting.length > 0) {
      const next = this.waiting.shift() as Waiter
      if (next.signal?.aborted) {
        if (next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
        next.reject(abortedReason(next.signal))
        continue
      }
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
      next.resolve(this.releaser())
      return
    }
    this.busy = false
  }
}

/** 每个 Host 进程共享的闸门。 */
export const systemInputQueue = new SystemInputQueue()
