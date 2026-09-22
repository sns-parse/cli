# @sns-parse/cli

sns-parse 的命令行兼容层：像 you-get 一样在终端解析 / 下载全平台视频与图集。

```bash
npx @sns-parse/cli <链接>              # 或安装后使用 bin：sns-parse / video-parser
sns-parse https://v.douyin.com/xxxx/ -d -o ./downloads
sns-parse https://x.com/.../status/123 --twitter-auth-token A --twitter-ct0 B
```

## 架构

- 引擎（fetcher / parser / 翻译 / X 原生解析 / 同源合并 / GIF / TLS 指纹客户端）全部来自 [`@sns-parse/core`](https://www.npmjs.com/package/@sns-parse/core)
- 平台链接识别与配置声明来自**已安装**的 `@sns-parse/platform-*` 碎片包（默认经聚合包 [`@sns-parse/platforms`](https://www.npmjs.com/package/@sns-parse/platforms) 全量安装，可自选裁剪）
- 扩展配置声明来自已安装的 `@sns-parse/ext-*`（默认经 [`@sns-parse/extensions`](https://www.npmjs.com/package/@sns-parse/extensions) 聚合安装）
- 配置默认值由 core 配置声明动态生成，与 Koishi 层同源；`--config` / `--export-config` 与插件 `parse/config` 命令共用同一信封格式，可互迁

## 主要选项

| 选项 | 说明 |
| --- | --- |
| `-d, --download` | 下载视频/图集/封面/音乐（多视频推文全量） |
| `--json` | JSON 输出解析结果 |
| `--api-key <key>` | api-new.ifphp.com 网关 Key（自动切换新网关） |
| `--proxy <url>` | HTTP 代理 |
| `--merge-images` | 同源切图识别合并（需 ffmpeg） |
| `--twitter-auth-token/--twitter-ct0` | X 登录态（解析需登录推文；TLS 指纹由 @char46/tlsget-rs 处理） |
| `--config <file>` | 加载配置信封覆盖 |
| `--export-config [--include-secrets]` | 导出配置信封 |

完整列表见 `sns-parse --help`。

## 可选依赖

- `@char46/tlsget-rs`：Chrome TLS 指纹（解析需登录的 X 推文时必需）
- `ffmpeg-static`：`--merge-images` 与动图 GIF 转换

## 开发（pnpm）

```bash
pnpm install
pnpm build
pnpm test
```

## 许可

MIT
