#!/usr/bin/env node
/**
 * @sns-parse/cli — sns-parse 命令行兼容层。
 *
 * - 引擎（fetcher/parser/翻译/X 原生解析/合并/GIF/TLS 指纹）全部来自 @sns-parse/core
 * - 平台定义与扩展配置声明来自「已安装」的 @sns-parse/platform-* / ext-* 碎片包
 *   （安装聚合包 @sns-parse/platforms / extensions 即全量；亦可自选碎片）
 * - 配置默认值由 core 配置声明动态生成（与 Koishi 层同源）
 */
import axios from 'axios'
import { createWriteStream, existsSync, readFileSync } from 'fs'
import { mkdir, stat, writeFile } from 'fs/promises'
import { join, resolve, extname } from 'path'
import {
  linkTypeParser,
  createRuntime,
  createCoreExtensions,
  getPlatformConfig,
  parseUrl,
  generateFormattedText, formatDuration, formatPublishTime,
  setLogger, consoleLogger, setVerboseLogging, debugLog,
  langName,
  mergeImages, type MergeLayout,
  shutdownTlsClient,
  collectPlatformDefinitions, loadExtensionContributions,
  mergeConfigContributions, platformConfigContributions, defaultsFromContributions,
  engineConfigContributions,
  createConfigEnvelope, serializeConfigEnvelope, parseConfigInput, mergeConfig,
  fetchTweetTree, type TweetTree,
  fetchUserTimeline, fetchUserConnections, resolveTwitterUser,
  type TimelineEntry, type TwitterConnectionUser, type TimelineTab,
  type ParsedData,
} from '@sns-parse/core'

const PLUGIN_NAME = 'sns-parse'

// CLI 侧专属基线（引擎/扩展/平台配置默认值全部来自 core DSL 声明，见 contributedDefaults）
const BASE_DEFAULTS: Record<string, any> = {
  debug: false,
}

/**
 * 汇总引擎+已安装扩展+平台声明的配置默认值
 * （与 koishi 层 collectConfigContributions 同源；引擎组来自 core 的 engineConfigContributions）
 */
function contributedDefaults(defs: ReturnType<typeof collectPlatformDefinitions>): Record<string, any> {
  const lists = [engineConfigContributions(), loadExtensionContributions()]
  if (defs.length) lists.push(platformConfigContributions(defs))
  return defaultsFromContributions(mergeConfigContributions(lists))
}

interface CliArgs {
  url: string
  positional: string[]
  download: boolean
  output: string
  json: boolean
  info: boolean
  debug: boolean
  api: string | undefined
  apiKey: string | undefined
  proxy: string | undefined
  dedicatedFirst: boolean
  mergeImages: boolean
  twitterAuthToken: string | undefined
  twitterCt0: string | undefined
  exportConfig: boolean
  includeSecrets: boolean
  configFile: string | undefined
  tree: boolean
  tab: string | undefined
  kind: string | undefined
  limit: number | undefined
  connType: string | undefined
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: '', positional: [], download: false, output: '.', json: false, info: false, debug: false,
    api: undefined, apiKey: undefined, proxy: undefined, dedicatedFirst: false,
    mergeImages: false, twitterAuthToken: undefined, twitterCt0: undefined,
    exportConfig: false, includeSecrets: false, configFile: undefined,
    tree: false, tab: undefined, kind: undefined, limit: undefined, connType: undefined,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-d': case '--download': args.download = true; break
      case '-i': case '--info': args.info = true; break
      case '--json': args.json = true; break
      case '--debug': args.debug = true; break
      case '-o': case '--output': args.output = argv[++i]; break
      case '--api': args.api = argv[++i]; break
      case '--api-key': args.apiKey = argv[++i]; break
      case '--proxy': args.proxy = argv[++i]; break
      case '--tree': args.tree = true; break
      case '--tab': args.tab = argv[++i]; break
      case '--kind': args.kind = argv[++i]; break
      case '--limit': args.limit = Number(argv[++i]) || undefined; break
      case '--conn-type': args.connType = argv[++i]; break
      case '--dedicated-first': args.dedicatedFirst = true; break
      case '--merge-images': args.mergeImages = true; break
      case '--twitter-auth-token': args.twitterAuthToken = argv[++i]; break
      case '--twitter-ct0': args.twitterCt0 = argv[++i]; break
      case '--export-config': args.exportConfig = true; break
      case '--include-secrets': args.includeSecrets = true; break
      case '--config': args.configFile = argv[++i]; break
      case '-v': case '--version': printVersion(); process.exit(0)
      case '-h': case '--help': printHelp(); process.exit(0)
      default:
        if (a.startsWith('-')) { console.error(`未知选项: ${a}`); process.exit(1) }
        positional.push(a)
    }
  }
  args.url = positional[0] || ''
  args.positional = positional
  return args
}

function printVersion(): void {
  const pkg = require('../package.json')
  console.log(`sns-parse-cli ${pkg.version}`)
}

function printHelp(): void {
  console.log(`
sns-parse CLI — 像 you-get 一样解析/下载视频（兼容别名 video-parser）

用法:
  sns-parse <url> [选项]
  sns-parse <推文链接> --tree              推文树（递归引用链 + 回复链）
  sns-parse user <screenName> [选项]       用户时间线（推文/回复/点赞）
  sns-parse follows <screenName> [选项]    关注/粉丝列表

X 扩展选项（需 --twitter-auth-token + --twitter-ct0，或经 --config 配置）:
  --tree                 推文树：引用链（quoted，递归）+ 回复链（上溯至根），树形输出
  --tab <t>              user 命令的标签页：tweets（默认）| replies | likes（仅当前登录用户）
  --kind <k>             user 命令的内容筛选：text | video | image | retweet | reply
  --conn-type <t>        follows 命令列表类型：followers（默认）| following
  --limit <n>            条数上限（user 默认 20，follows 默认 50）

选项:
  -d, --download         下载视频/图集/封面/音乐到本地（多视频推文全量下载）
  -i, --info             仅显示信息（默认行为，可不加）
  -o, --output <dir>     下载目录（默认当前目录）
  --json                 以 JSON 输出解析结果
  --api <url>            覆盖默认主解析 API
  --api-key <key>        api-new.ifphp.com 网关 API Key（配置后自动切换新网关）
  --proxy <url>          HTTP 代理，如 http://127.0.0.1:7890
  --dedicated-first      优先使用平台专属 API
  --merge-images         同源切图纯内容识别合并：网格/竖堆/横拼布局各自经接缝连续性验证
                         （低频趋势延续+纹理可验证性），取证据最强者；均不过逐张发送（需 ffmpeg）
  --twitter-auth-token <t>  X 登录态 auth_token（解析需登录推文；TLS 指纹由 tlsget-rs 处理，随包自动安装）
  --twitter-ct0 <t>         X 登录态 ct0（与 auth_token 配对，同时用作 csrf token）
  --export-config        导出配置信封 JSON 到标准输出（默认脱敏；配合 --include-secrets 输出明文）
  --include-secrets      配合 --export-config：输出密钥明文
  --config <file>        从配置信封/配置 JSON 文件加载覆盖（与插件 parse/config import 同格式）
  --debug                开启调试日志（含同源合并证据链）
  -v, --version          显示版本
  -h, --help             显示帮助

示例:
  sns-parse https://www.bilibili.com/video/BV1xx411c7mD
  sns-parse https://v.douyin.com/xxxx/ -d -o ./downloads
  sns-parse https://x.com/.../status/123 --twitter-auth-token A --twitter-ct0 B

平台支持随已安装的 @sns-parse/platform-* 碎片包扩展（默认经聚合包全量安装）。
`.trim())
}

function buildConfig(overrides: Record<string, any>, defs: ReturnType<typeof collectPlatformDefinitions>): any {
  // 未提供的选项（undefined）不得覆盖基线值（否则信封导出会缺键）
  const compact = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined))
  return {
    ...BASE_DEFAULTS,
    ...contributedDefaults(defs),
    ...compact,
  }
}

function parseProxy(proxyStr: string): any {
  const m = /^(https?):\/\/([^:\/]+)(?::(\d+))?/.exec(proxyStr)
  if (!m) { console.error('代理格式错误，应为 http://host:port'); process.exit(1) }
  return { enabled: true, protocol: m[1], host: m[2], port: Number(m[3] || 8080), auth: {} }
}

function sanitize(name: string): string {
  return (name || '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

function inferExt(url: string, fallback: string): string {
  const ext = extname(new URL(url, 'http://x/').pathname).toLowerCase()
  if (['.mp4', '.m4v', '.flv', '.webm', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp3', '.m4a', '.aac'].includes(ext)) return ext
  return fallback
}

function bar(cur: number, total: number): string {
  if (!total) return ''
  const pct = Math.min(100, Math.round(cur / total * 100))
  return `${pct}% (${(cur / 1048576).toFixed(1)}MB/${(total / 1048576).toFixed(1)}MB)`
}

async function downloadOne(url: string, filepath: string, label: string): Promise<void> {
  if (!url) return
  process.stdout.write(`  ↓ ${label}: ${url}\n`)
  try {
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      maxRedirects: 5,
    })
    const total = Number(res.headers['content-length'] || 0)
    let received = 0
    await new Promise<void>((resolveP, reject) => {
      const ws = createWriteStream(filepath)
      res.data.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total) process.stdout.write(`\r  ${bar(received, total)}      `)
      })
      res.data.pipe(ws)
      ws.on('finish', () => { process.stdout.write('\n'); resolveP() })
      ws.on('error', reject)
      res.data.on('error', reject)
    })
    process.stdout.write(`  ✓ 已保存: ${filepath}\n`)
  } catch (e: any) {
    process.stdout.write(`  ✗ 下载失败: ${e.message || e}\n`)
  }
}

function printInfo(p: ParsedData, type: string): void {
  const line = (k: string, v: any) => v === '' || v === 0 || v == null ? null : `${k}: ${v}`
  const rows = [
    `平台类型: ${type} (${p.type})`,
    line('标题', p.title),
    line('作者', p.author ? `${p.author}${p.uid ? ` (ID: ${p.uid})` : ''}` : ''),
    line('简介', p.desc),
    p.translation ? `翻译（${p.translationProvider || '?'}，${langName(p.lang) || '?'}）：${p.translation}` : null,
    line('时长', p.duration > 0 ? formatDuration(p.duration) : ''),
    line('发布时间', p.publishTime ? formatPublishTime(p.publishTime) : ''),
    ['点赞', '评论', '收藏', '转发', '播放'].map((n, i) => {
      const val = [p.like, p.comment, p.collect, p.share, p.play][i]
      return val ? `${n}: ${val}` : null
    }).filter(Boolean).join('  ') || null,
    p.videos.length > 1
      ? `清晰度:\n${p.videos.map((v, i) => `  [${i}] ${v.quality}${v.bit_rate ? ` (${v.bit_rate}bps)` : ''}  ${v.url}`).join('\n')}`
      : null,
    p.video ? `视频地址: ${p.video}${p.isGif ? '（动图）' : ''}` : null,
    p.extraVideos?.length
      ? `更多视频 (${p.extraVideos.length}):\n${p.extraVideos.map((v, i) => `  [${i + 1}] ${v.url}${v.isGif ? '（动图）' : ''}`).join('\n')}`
      : null,
    p.images.length ? `图集 (${p.images.length}):\n${p.images.map((u, i) => `  [${i}] ${u}`).join('\n')}` : null,
    p.live_photo.length ? `实况 (${p.live_photo.length}): ${p.live_photo.map(lp => lp.image).join(', ')}` : null,
    p.cover ? `封面: ${p.cover}` : null,
    p.music.url || p.music.title ? `音乐: ${p.music.title || ''}${p.music.author ? ' - ' + p.music.author : ''}${p.music.url ? '\n  ' + p.music.url : ''}` : null,
  ]
  console.log(rows.filter(Boolean).join('\n'))
}

function layoutDesc(layout: MergeLayout): string {
  if (layout.kind === 'grid') return `${layout.cols}x${layout.rows} 宫格`
  return layout.kind === 'v' ? '垂直堆叠（水平切分）' : '水平拼接（垂直切分）'
}

async function downloadAll(p: ParsedData, type: string, outDir: string, merged: { buffer: Buffer; layout: MergeLayout } | null = null): Promise<void> {
  await mkdir(outDir, { recursive: true })
  const base = sanitize(p.title) || `${type}_${Date.now()}`
  console.log('\n开始下载:')
  // URL 级去重：封面=图集首图、实况图=封面等场景不重复下载
  const downloaded = new Set<string>()
  const dl = async (url: string, filepath: string, label: string) => {
    if (!url) return
    if (downloaded.has(url)) {
      console.log(`  ↷ 跳过重复（与此前已下载内容相同）: ${label}`)
      return
    }
    downloaded.add(url)
    await downloadOne(url, filepath, label)
  }
  if (p.video) {
    const useV = p.videos[0]?.url || p.video
    await dl(useV, join(outDir, `${base}${inferExt(useV, '.mp4')}`), '视频')
  }
  // 多视频推文：其余视频全量下载（主视频无后缀，其余 _2 _3…）
  for (let i = 0; i < (p.extraVideos?.length || 0); i++) {
    const u = p.extraVideos![i].url
    await dl(u, join(outDir, `${base}_${i + 2}${inferExt(u, '.mp4')}`), `视频 ${i + 2}/${p.extraVideos!.length + 1}`)
  }
  if (p.images.length) {
    // --merge-images：同源切图合并成功时保存合并图，替代逐张分片
    if (merged) {
      const f = join(outDir, `${base}_merged.jpg`)
      await writeFile(f, merged.buffer)
      console.log(`  ✓ 已保存合并图（${p.images.length} 片 → ${layoutDesc(merged.layout)}）: ${f}`)
      for (const u of p.images) downloaded.add(u)
    } else {
      for (let i = 0; i < p.images.length; i++) {
        await dl(p.images[i], join(outDir, `${base}_${i + 1}${inferExt(p.images[i], '.jpg')}`), `图片 ${i + 1}/${p.images.length}`)
      }
    }
  }
  if (p.live_photo.length) {
    for (let i = 0; i < p.live_photo.length; i++) {
      await dl(p.live_photo[i].image, join(outDir, `${base}_live_${i + 1}${inferExt(p.live_photo[i].image, '.jpg')}`), `实况图 ${i + 1}`)
      if (p.live_photo[i].video) await dl(p.live_photo[i].video!, join(outDir, `${base}_live_${i + 1}.mp4`), `实况视频 ${i + 1}`)
    }
  }
  if (p.cover) await dl(p.cover, join(outDir, `${base}_cover${inferExt(p.cover, '.jpg')}`), '封面')
  if (p.music.url) await dl(p.music.url, join(outDir, `${base}_music${inferExt(p.music.url, '.mp3')}`), '音乐')
}

/* ===================== X 扩展：推文树 / 用户时间线 / 关注列表 ===================== */

function brief(text: string, n = 200): string {
  const t = (text || '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function nodeStats(p: ParsedData): string {
  return [
    p.like ? `❤ ${p.like}` : '',
    p.share ? `🔁 ${p.share}` : '',
    p.comment ? `💬 ${p.comment}` : '',
    p.images.length ? `🖼 ${p.images.length}` : '',
    p.video ? '🎬' : '',
  ].filter(Boolean).join('  ')
}

function tweetNodeLines(node: TweetTree, prefix: string): string[] {
  const p = node.tweet
  const head = `${p.author || '?'}${p.uid ? ` @${p.uid}` : ''}${p.publishTime ? ' · ' + formatPublishTime(p.publishTime) : ''}`
  const lines: string[] = [`${prefix}${head}`]
  const body = brief(p.desc, 240) || '(无正文)'
  for (const ln of body.split('\n')) lines.push(`${prefix}  ${ln}`)
  const stats = nodeStats(p)
  lines.push(`${prefix}  ${stats}${stats ? '  ' : ''}${node.id ? `https://x.com/i/web/status/${node.id}` : ''}`)
  if (node.quoted) {
    lines.push(`${prefix}  ├─ 引用 ↴`)
    lines.push(...tweetNodeLines(node.quoted, `${prefix}  │ `))
  }
  return lines
}

function printTweetTree(tree: TweetTree): void {
  const chain: TweetTree[] = []
  for (let n: TweetTree | undefined = tree; n; n = n.replyTo) chain.unshift(n)
  const quotedDepth = (n: TweetTree): number => (n.quoted ? 1 + quotedDepth(n.quoted) : 0)
  console.log(`▶ 推文树（回复链 ${chain.length} 层，最深层含引用链 ${quotedDepth(tree)} 级）\n`)
  chain.forEach((n, i) => {
    const focused = i === chain.length - 1
    console.log(`${focused ? '▶ 当前' : `↰ 上文 ${i + 1}/${chain.length - 1}`}`)
    console.log(tweetNodeLines(n, '  ').join('\n'))
    if (!focused) console.log('  └─ 回复于 ↑')
    console.log('')
  })
}

function configOverrideFromFile(args: CliArgs): Record<string, any> {
  if (!args.configFile) return {}
  try {
    return parseConfigInput(readFileSync(args.configFile, 'utf8')).config
  } catch (e: any) {
    console.error(`✗ 读取配置失败（${args.configFile}）：${e?.message || e}`)
    process.exit(1)
  }
}

async function runTree(args: CliArgs, cfg: Record<string, any>): Promise<void> {
  if (!args.url || !/\/status(?:es)?\//.test(args.url)) {
    console.error('✗ --tree 需要一条 X/Twitter 推文链接')
    process.exit(1)
  }
  const authToken = args.twitterAuthToken || cfg.twitterAuthToken
  const ct0 = args.twitterCt0 || cfg.twitterCt0
  const creds = authToken && ct0 ? { authToken: String(authToken), ct0: String(ct0) } : undefined
  if (creds) process.stdout.write('▶ 使用登录态（GraphQL；无登录态则走公开 syndication）\n')
  try {
    const tree = await fetchTweetTree(args.url, axios.create({ timeout: 30000 }), creds as any, undefined)
    printTweetTree(tree)
    process.exit(0)
  } catch (e: any) {
    console.error('✗ 拉取推文树失败:', e?.message || e)
    process.exit(1)
  }
}

const KIND_LABELS: Record<string, string> = { text: '文字', video: '视频', image: '图片', retweet: '转推', reply: '回复' }

async function runUser(args: CliArgs, cfg: Record<string, any>): Promise<void> {
  const screenName = (args.positional[1] || '').replace(/^@/, '')
  if (!screenName) { console.error('用法: sns-parse user <screenName> [--tab tweets|replies|likes] [--kind text|video|image|retweet|reply] [--limit N]'); process.exit(1) }
  const tab = (args.tab || 'tweets') as TimelineTab
  if (!['tweets', 'replies', 'likes'].includes(tab)) { console.error('✗ --tab 仅支持 tweets | replies | likes'); process.exit(1) }
  const kind = args.kind
  if (kind && !['text', 'video', 'image', 'retweet', 'reply'].includes(kind)) { console.error('✗ --kind 仅支持 text | video | image | retweet | reply'); process.exit(1) }
  const authToken = args.twitterAuthToken || cfg.twitterAuthToken
  const ct0 = args.twitterCt0 || cfg.twitterCt0
  if (!authToken || !ct0) { console.error('✗ user 命令需要 X 登录态：--twitter-auth-token + --twitter-ct0（或经 --config 配置）'); process.exit(1) }
  const creds = { authToken: String(authToken), ct0: String(ct0) }
  const limit = args.limit ?? 20
  process.stdout.write(`▶ @${screenName} 时间线（${tab === 'likes' ? '点赞（仅当前登录用户可查自己的）' : tab === 'replies' ? '推文+回复' : '推文+转推'}${kind ? `，筛选 ${KIND_LABELS[kind]}` : ''}，上限 ${limit}）\n`)
  try {
    const info = await resolveTwitterUser(screenName, creds)
    console.log(`▶ ${info.name} @${info.screenName} · 粉丝 ${info.followers}${info.description ? ' · ' + brief(info.description, 80) : ''}\n`)
    let entries: TimelineEntry[] = await fetchUserTimeline({ screenName, tab, limit: kind ? Math.min(200, limit * 5) : limit, creds })
    if (kind) entries = entries.filter((e) => e.kinds.includes(kind as any)).slice(0, limit)
    if (!entries.length) { console.log('（无匹配条目）'); process.exit(0) }
    entries.forEach((e, i) => {
      const tags = e.kinds.map((k) => KIND_LABELS[k]).join('/')
      const date = e.tweet.publishTime ? formatPublishTime(e.tweet.publishTime) : ''
      console.log(`[${i + 1}] ${date} [${tags}]`)
      const body = brief(e.tweet.desc, 160) || '(无正文)'
      for (const ln of body.split('\n')) console.log(`    ${ln}`)
      console.log(`    ${nodeStats(e.tweet)}  ${e.url}`)
      console.log('')
    })
    process.exit(0)
  } catch (e: any) {
    console.error('✗ 拉取时间线失败:', e?.message || e)
    process.exit(1)
  }
}

async function runFollows(args: CliArgs, cfg: Record<string, any>): Promise<void> {
  const screenName = (args.positional[1] || '').replace(/^@/, '')
  if (!screenName) { console.error('用法: sns-parse follows <screenName> [--conn-type followers|following] [--limit N]'); process.exit(1) }
  const type = args.connType === 'following' ? 'following' : 'followers'
  const authToken = args.twitterAuthToken || cfg.twitterAuthToken
  const ct0 = args.twitterCt0 || cfg.twitterCt0
  if (!authToken || !ct0) { console.error('✗ follows 命令需要 X 登录态：--twitter-auth-token + --twitter-ct0（或经 --config 配置）'); process.exit(1) }
  const creds = { authToken: String(authToken), ct0: String(ct0) }
  const limit = args.limit ?? 50
  process.stdout.write(`▶ @${screenName} 的${type === 'following' ? '关注列表' : '粉丝列表'}（上限 ${limit}）\n`)
  try {
    const users: TwitterConnectionUser[] = await fetchUserConnections({ screenName, type, limit, creds })
    if (!users.length) { console.log('（无条目——列表不可见或为空）'); process.exit(0) }
    users.forEach((u, i) => {
      console.log(`[${i + 1}] ${u.name} @${u.screenName}${u.verified ? ' ✓' : ''} · 粉丝 ${u.followers}${u.followedBy ? ' · 关注了你' : ''}`)
      if (u.description) console.log(`    ${brief(u.description, 100)}`)
    })
    process.exit(0)
  } catch (e: any) {
    console.error('✗ 拉取列表失败:', e?.message || e)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  setLogger(consoleLogger)
  if (args.debug) setVerboseLogging(true)

  // X 扩展子命令与 --tree（自带配置读取，不走平台解析链）
  const cmd = args.positional[0]
  if (cmd === 'user' || cmd === 'follows') {
    const cfg = configOverrideFromFile(args)
    if (cmd === 'user') await runUser(args, cfg)
    else await runFollows(args, cfg)
  }
  if (args.tree) {
    await runTree(args, configOverrideFromFile(args))
  }

  // 平台定义来自已安装碎片包（聚合包默认全量）
  const defs = collectPlatformDefinitions()
  const linkRules = defs.flatMap(d => d.rules.map(pattern => ({ pattern, type: d.type })))

  if (args.exportConfig) {
    const cfg = buildConfig({
      primaryApiUrl: args.api,
      apiKey: args.apiKey || '',
      platformDedicatedFirst: args.dedicatedFirst && args.url ? { [args.url]: true } : {},
      proxy: args.proxy ? parseProxy(args.proxy) : { enabled: false },
      debug: args.debug,
      twitterAuthToken: args.twitterAuthToken,
      twitterCt0: args.twitterCt0,
    }, defs)
    const env = createConfigEnvelope(cfg, { pluginName: PLUGIN_NAME, includeSecrets: args.includeSecrets })
    process.stdout.write(serializeConfigEnvelope(env) + '\n')
    process.exit(0)
  }

  if (!args.url) { printHelp(); process.exit(1) }

  if (!linkRules.length) {
    console.error('✗ 未发现任何已安装的平台包（@sns-parse/platform-*）。请安装聚合包：npm i @sns-parse/platforms')
    process.exit(1)
  }
  const matches = linkTypeParser(args.url, linkRules)
  if (!matches.length) {
    console.error('✗ 无法识别该链接对应的平台')
    process.exit(1)
  }
  const { type, url } = matches[0]
  process.stdout.write(`▶ 平台: ${type}\n▶ 链接: ${url}\n▶ 正在解析...\n\n`)

  let config = buildConfig({
    primaryApiUrl: args.api,
    apiKey: args.apiKey || '',
    platformDedicatedFirst: args.dedicatedFirst ? { [type]: true } : {},
    proxy: args.proxy ? parseProxy(args.proxy) : { enabled: false },
    debug: args.debug,
    twitterAuthToken: args.twitterAuthToken,
    twitterCt0: args.twitterCt0,
  }, defs)

  if (args.configFile) {
    try {
      config = mergeConfig(config, parseConfigInput(readFileSync(args.configFile, 'utf8')).config)
    } catch (e: any) {
      console.error(`✗ 读取配置失败（${args.configFile}）：${e?.message || e}`)
      process.exit(1)
    }
  }

  const rt = createRuntime({}, config, {
    defs,
    defaultExtensions: createCoreExtensions(),
  })

  let exitCode = 0
  try {
    const conf = getPlatformConfig(rt, type)
    const result = await parseUrl(rt, url, type, conf.fieldMapping, conf)
    if (!result.success) {
      console.error('\n✗ 解析失败:', result.msg)
      exitCode = 1
    } else {
      const parsed = result.data
      debugLog('解析结果', parsed)

      // --merge-images：同源切图识别与合并（独立选项，默认关闭）
      let merged: { buffer: Buffer; layout: MergeLayout } | null = null
      if (args.mergeImages && parsed.images.length >= 2) {
        merged = await mergeImages(rt, parsed.images)
        if (!args.json) {
          if (merged) {
            console.log(`▶ 同源切图: ${parsed.images.length} 片 → 已合并（${layoutDesc(merged.layout)}，${Math.round(merged.buffer.length / 1024)}KB）`)
          } else {
            console.log('▶ 同源切图: 未检测到（图片非同源切分或 ffmpeg 不可用）')
          }
        }
      }

      if (args.json) {
        console.log(JSON.stringify(parsed, null, 2))
      } else {
        printInfo(parsed, type)
        if (parsed.video || parsed.images.length || parsed.live_photo.length) {
          process.stdout.write('\n--- 文字消息预览 (unifiedMessageFormat) ---\n')
          console.log(generateFormattedText(parsed, config.unifiedMessageFormat) || '(空)')
        }
      }

      if (args.download) {
        await downloadAll(parsed, type, resolve(args.output), merged)
      }
    }
  } catch (e: any) {
    console.error('\n✗ 解析失败:', e?.message || e)
    if (args.debug && e?.stack) console.error(e.stack)
    exitCode = 1
  }

  // 关闭 TLS 指纹模拟资源，避免进程悬挂
  await shutdownTlsClient().catch(() => {})
  process.exit(exitCode)
}

main()
