// asar-format.mjs
//
// asar 容器格式的最小共享实现：头部 pickle 的解析/序列化、条目读取与遍历。
// `verify-desktop.mjs`（校验打包产物）与 `repair-windows-acl-runner-console.mjs`（重打包归档）
// 读的是同一个格式，放这里单一来源 —— 这个格式（头 pickle 的 8 字节前缀、JSON 长度、
// 数据区起点、块间**没有**对齐填充）很容易在第二份实现里写错。
//
// 只做纯计算，不做 I/O：调用方自己决定整块读进内存还是按描述符流式读。

/**
 * 4 字节向上取整：asar 的 pickle 负载按 4 字节对齐。
 * @param value - 字节数。
 * @returns 对齐后的字节数。
 */
function align4(value) {
  return Math.ceil(value / 4) * 4
}

/**
 * 解析 asar 头部。
 * @param sizePickle - 归档开头的 8 字节（payload 长度 4 + 头 pickle 长度）。
 * @param headerPickle - 紧随其后的头部 pickle，长度必须等于 sizePickle 里记录的值。
 * @returns 头部对象与数据区起点偏移。
 */
export function parseAsarHeader(sizePickle, headerPickle) {
  if (sizePickle.readUInt32LE(0) !== 4) throw new Error('asar: unexpected size-pickle payload')
  const headerSize = sizePickle.readUInt32LE(4)
  if (headerPickle.length !== headerSize) throw new Error('asar: header pickle length mismatch')
  const jsonSize = headerPickle.readUInt32LE(4)
  if (headerSize !== align4(jsonSize) + 8) throw new Error('asar: header pickle and json length disagree')
  const header = JSON.parse(headerPickle.toString('utf8', 8, 8 + jsonSize))
  if (header.files === undefined) throw new Error('asar: header has no files map')
  return { header, dataOffset: 8 + headerSize }
}

/**
 * 从整块归档缓冲区解析头部。
 * @param buffer - 归档的全部字节。
 * @returns 头部对象与数据区起点偏移。
 */
export function parseAsarBuffer(buffer) {
  return parseAsarHeader(buffer, buffer.subarray(8, 8 + buffer.readUInt32LE(4)))
}

/**
 * 序列化头部。
 * @param header - 头部对象。
 * @returns 数据区之前要写出的两个 pickle，以及新的数据区起点偏移。
 */
export function packAsarHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const headerSize = align4(json.length) + 8
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerSize, 4)
  const headerPickle = Buffer.alloc(headerSize)
  headerPickle.writeUInt32LE(headerSize - 4, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  return { sizePickle, headerPickle, dataOffset: 8 + headerSize }
}

/** 按 slash 路径取一个文件条目。 */
function entryAt(header, path) {
  let node = header
  for (const part of path.split('/')) {
    node = node?.files?.[part]
    if (node === undefined) throw new Error(`asar: ${path} not found`)
  }
  if (typeof node.offset !== 'string' && typeof node.offset !== 'number') throw new Error(`asar: ${path} is a directory`)
  return node
}

/**
 * 读归档里的一个文件。
 * @param buffer - 归档的全部字节。
 * @param path - 归档内相对路径。
 * @returns 该文件的字节切片。
 */
export function readAsarFile(buffer, path) {
  const { header, dataOffset } = parseAsarBuffer(buffer)
  const node = entryAt(header, path)
  const start = dataOffset + Number(node.offset)
  return buffer.subarray(start, start + Number(node.size))
}

/**
 * 按头部顺序列出全部文件条目。
 * @param header - 头部对象。
 * @returns 路径与条目对象的列表；条目对象是头部的原引用，可原地改写后重新序列化。
 */
export function walkAsarEntries(header) {
  const entries = []
  const visit = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files !== undefined) visit(entry, path)
      else entries.push({ path, entry })
    }
  }
  visit(header, '')
  return entries
}
