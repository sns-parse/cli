/**
 * CLI 冒烟测试（tsx 直跑）：--help / --version / --export-config（离线路径）。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const BIN = join(process.cwd(), 'lib', 'index.js')

function run(args: string[], timeoutMs = 15000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`超时（>${timeoutMs}ms）：${args.join(' ')}`)) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { clearTimeout(timer); resolveP({ code: code ?? -1, out, err }) })
    child.on('error', reject)
  })
}

let passed = 0
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

async function main(): Promise<void> {
  await check('--help 退出码 0 且含用法说明', async () => {
    const r = await run(['--help'])
    if (r.code !== 0) throw new Error(`exit=${r.code} err=${r.err.slice(0, 200)}`)
    if (!/sns-parse <url>/.test(r.out)) throw new Error('帮助文本缺失用法行')
  })
  await check('--version 输出 sns-parse-cli 与版本号', async () => {
    const r = await run(['--version'])
    if (r.code !== 0) throw new Error(`exit=${r.code}`)
    if (!/^sns-parse-cli \d/.test(r.out.trim())) throw new Error(`版本输出异常: ${r.out.trim().slice(0, 60)}`)
  })
  await check('--export-config 产出配置信封（脱敏）', async () => {
    const r = await run(['--export-config', '--api-key', 'sk-test'])
    if (r.code !== 0) throw new Error(`exit=${r.code} err=${r.err.slice(0, 200)}`)
    const env = JSON.parse(r.out)
    if (env.kind !== 'sns-parse-config') throw new Error(`kind 异常: ${env.kind}`)
    if (env.redacted !== true) throw new Error('默认应脱敏')
    if (env.config.apiKey !== '***') throw new Error('apiKey 应被打码')
    if (!env.config.primaryApiUrl.startsWith('https://')) throw new Error('基础默认值缺失')
  })
  await check('未识别链接退出码 1', async () => {
    const r = await run(['https://example.invalid/nothing'])
    if (r.code !== 1) throw new Error(`exit=${r.code}`)
  })
  console.log(`\n全部通过：${passed} 项`)
}

main().catch((e) => { console.error(e); process.exit(1) })
