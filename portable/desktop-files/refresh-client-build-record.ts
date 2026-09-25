/**
 * DSH-build: refresh the client build record after post-build patches changed client artifacts.
 *
 * P1（patch-native-code）会改动个别客户端产物（例如 packages/api/session-controller/lib/client.js），
 * 而 .dsh-build/client-build-environment.json 是 build:official 结束时按当时的产物算的摘要；
 * 上游 release:pack 会校验两者一致。这里用与 build:official 相同的 public 环境重算记录，
 * 让校验看到的是**真实**产物，而不是绕过它。
 */
import { repositoryClientBuildEnvironment, resolveClientBuildEnvironment, writeClientBuildRecord } from './client-build-environment.ts'

const root = process.cwd()
const profile = process.env.DSH_BUILD_CLIENT_PROFILE
const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root, process.env), profile)
const record = writeClientBuildRecord(root, environment)
console.log(`dsh-build: refreshed client build record (${String(record.artifacts.fileCount)} artifacts)`
  + ` with ${String(Object.keys(record.environment).length)} public value(s)`)
