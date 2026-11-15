# 共用书库 base URL 合同（TB-446 → TB-272）

唯一模块为 `src/lib/discovery/base-url.ts`，供手动添加、旧配置迁移、发现候选及来源身份共用。原草稿 PR：<https://github.com/talebook/moke/pull/150>。交付附件须连同最新完整 head SHA 使用；旧 `a8f3b7fa409607beca872c257bec52f4c57beb47` 尚不支持本文的 IDNA/长 URL 手动输入。

## 导出与引入

```ts
import {
  parseLibraryBaseUrl,
  normalizeLibraryBaseUrl,
  isSameLibraryBaseUrl,
} from '@/lib/discovery/base-url';
import type { ParsedLibraryBaseUrl } from '@/lib/discovery/base-url';
```

| 实际签名 | 行为 |
| --- | --- |
| `parseLibraryBaseUrl(value: string): ParsedLibraryBaseUrl` | 同步返回下列结构，非法输入抛 `Error` |
| `normalizeLibraryBaseUrl(value: string): string` | 同步返回规范化 `baseUrl`，同样抛错 |
| `isSameLibraryBaseUrl(left: string, right: string): boolean` | 比较两个完整规范化地址；任一非法即 `false`，即使两个非法字符串相同 |

`ParsedLibraryBaseUrl` 固定为 `{baseUrl: string, origin: string, protocol: 'http' | 'https', host: string, port: string, pathPrefix: string}`。`port` 始终是字符串，HTTP/HTTPS 默认分别为 `'80'`/`'443'`；IPv6 的 `host` 保留方括号。模块无网络操作，不做 DNS、私网、SRV、TLS、身份、认证或可用性验证。

## 规范化与兼容边界

- 只接受绝对 HTTP(S)，协议和 DNS 主机转小写；Unicode DNS 名由标准 `URL` 的 IDNA 转为 ASCII。公网、loopback、未解析域名均可在此层通过语法检查。
- 共享层没有发现 TXT 的 ASCII/200 字节上限；长手动地址可以通过。DNS 名在 IDNA 后仍须符合普通 DNS label 长度/字符规则。拒绝缩写、十六进制、八进制及 Unicode 数字等会被 `URL` 改写的 IPv4 别名；允许标准点分 IPv4、方括号 IPv6。尾部 DNS 点保留，不合并为无尾点身份。
- 默认端口从 `baseUrl`/`origin` 省略，非默认端口保留；IPv6 用 `URL` 的标准压缩形式。根路径 `''`/`'/'` 统一为 `pathPrefix: ''`，`baseUrl` 无尾 `/`。
- 前缀逐段保留，区分大小写，去一个尾 `/`；`/a` 和 `/b` 是不同书库身份。`origin` 仅为网络来源，不能代替持久化/离线身份或授权完整前缀。
- 路径沿 Talebook 已约定的 `TALEBOOK_BASE_PATH` 语法：`/segment[/segment]`，每段仅 `A-Z a-z 0-9 _ -`。这项是服务端部署合同，手动和发现共用；没有宣称支持任意网站路径。点段、重复斜线、百分号编码路径、Unicode/点号等其他段字符须显式修正，不能由客户端截断或猜测。
- 为避免 `URL` 静默丢信息，拒绝空白/控制字符、反斜线、百分号、userinfo、query、fragment（包括空的 `?`/`#`）。不自动补协议、trim 或截取 origin；UI 若先 trim，须由表单明确执行，迁移不得静默这样改写旧值。

| 输入 | 输出 / 结果 |
| --- | --- |
| `HTTPS://Books.Example:443/` | `baseUrl=https://books.example`，`origin` 相同，`port='443'`，`pathPrefix=''` |
| `http://books.example:80/team/books/` | `baseUrl=http://books.example/team/books`，`origin=http://books.example`，`port='80'`，`pathPrefix='/team/books'` |
| `https://books.example:8443/a` | `baseUrl=https://books.example:8443/a`，`port='8443'` |
| `https://书库.example/team/books` | `https://xn--1jq370b.example/team/books`；等同对应 punycode 输入 |
| `https://8.8.8.8/a`、超过 200 字符的合法简单前缀 | 共享层接受；不表示发现、连接或信任验证通过 |
| 同 origin 的 `https://books.example/a` 和 `/b` | `isSameLibraryBaseUrl=false`；不得合并凭据、书库或离线记录 |
| `http://[fd12:3456:789a::10]:8080/` | `http://[fd12:3456:789a::10]:8080`，`host='[fd12:3456:789a::10]'` |
| `http://u:p@books.example`、`http://books.example?` | `invalid_base_url` |
| `http://books.example/a/../b`、`/a.b`、`/书库` | `invalid_base_path` |
| `http://192.168.1`、`http://bad_host.example`、非法 IPv6 | `invalid_base_host` |
| `http://books.example:0`、`:65536` | `invalid_base_port` |

`Error.message` 为上述四种代码，错误不含原始输入。校验按 URL → 路径 → authority/端口 → 标准 URL/主机顺序执行，多处非法时只报告首先发现的一处；caller 应将代码映射为可理解文案，不依赖错误顺序推断其他字段有效。

## 手动添加与旧配置迁移的 caller 合同

新手动输入捕获 parse/normalize 错误，留在编辑状态，保留完整输入并显示纠正提示；语法通过后才交后继保存/连接流程。不要附加发现的私网/TTL/SRV/ASCII/200 字节政策。保存只持久化，不发 HTTP、不激活服务器；连接由开发者另点已保存条目发起，依 TB-272 已批准语义实现。

迁移必须逐条处理，**保留未通过的原记录、原始地址、关联离线数据及已有元数据**，由列表链标记 `needs-edit` 并禁止自动连接，提供更正/重新确认入口。`needs-edit` 是 caller 应实现的状态要求，本模块没有新增存储字段或迁移函数。本轮不改 store/UI，不能声称该状态已经接入。

成功时先计算规范化完整 `baseUrl`，在同一可回滚迁移内协调引用；根地址保留旧根身份。同 origin 不同 prefix 必须保留；等价地址发生碰撞时显式合并策略/确认，不能覆盖令牌或丢记录。失败时不得 `.filter()` 丢弃、回退到 origin、替换空字符串、改协议、按 `/` 截前缀，或因为 `isSameLibraryBaseUrl` 返回 false 就删除记录。旧版若只存了 origin，缺失前缀无法恢复，须要求重新输入，不能猜测。

构建 API 地址采用 `parsed.baseUrl + '/api/...'`，避免 `new URL('/api/...', parsed.baseUrl)` 丢前缀。网络 origin 授权、完整前缀资源授权与书库身份是不同边界，TB-448 的 Reader 方案仍是前缀在线阅读前置。

## 发现策略与接入顺序

发现 wire 层由 `src-tauri/discovery-core` 的 `normalize_base_url`/`parse_txt` 及候选快照校验，保留 ASCII、URL ≤200 字节、严格路径、私网 IP/SRV/发现地址约束。该 Rust 层是发现协议执行边界，不是另一个手动/迁移 parser；前端消费其已校验候选后共用本模块表达身份。共享解析器接受某个手动 URL，不能使该 URL 绕过 wire 校验。

域名发现候选另须受限系统 DNS 校验：全部结果私网且至少一个匹配有效来源地址；该结果随发现会话/记录/网络变化失效，并在未来显式保存/连接前重校验。系统解析、TLS/服务器信任及保存成功不能互相替代。

唯一集成顺序：稳定本 parser → TB-272 的 TB-293/TB-296 串行承接手动/welcome/access/store/列表/认证/API/来源及迁移 → 固定保存接口交回 TB-446 → 发现“添加并保存”按钮及后续列表点击连接。当前发现按钮继续禁用，本轮未接 `setServer`，未改这些共享入口或 Reader/gitlink。

## 可复现验证

```bash
node --test --experimental-strip-types tests/discovery-base-url.test.mjs
cargo test --manifest-path src-tauri/discovery-core/Cargo.toml --locked
```

第一条是纯 Node 同步解析/身份回归（无需服务器/依赖安装），覆盖 root/default-port/prefix、IDNA/public/长 URL、无效旧值及共同正样例。第二条是独立发现策略/协议回归，包括拒绝发现的超长/非 ASCII URL。本文不把二者当作迁移 UI、真实 DNS/HTTP、TLS、原生或双端通过；真实命令结果以同完整 SHA 的交付报告为准。
