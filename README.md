# Moke

**Moke** 是 [Talebook](https://github.com/talebook/talebook) 自托管电子书服务器的桌面客户端。在电脑上浏览、搜索、下载你的电子书库，内嵌专业阅读器，离线也能随时打开阅读。

## 功能

- **书库浏览** — 按分类、标签、作者、出版商等方式浏览服务器上的电子书
- **全文搜索** — 快速检索书名、作者、简介等元数据
- **离线下载** — 将书籍下载到本地，断网也能阅读
- **专业阅读** — 内嵌 readest 阅读器，支持 EPUB、PDF 等多种格式
- **局域网友好** — 支持自签名证书和纯 HTTP 局域网服务器
- **完整认证** — 支持访问码、登录、注册等 Talebook 服务器的全部认证方式

## 安装

从 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 安装包格式 |
|---|---|
| Windows | `.msi` / `.exe` |
| macOS | `.dmg` |
| Linux | `.AppImage` / `.deb` |

> **系统要求**：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）

## 使用

1. 启动 Moke，输入你的 Talebook 服务器地址（例如 `http://192.168.1.100:8080` 或 `https://mytalebook.example.com`）
2. 根据服务器设置，输入访问码或登录账号
3. 开始浏览、搜索、下载和阅读

下载的书籍存储在本地，在书架页面可以离线打开阅读。

## 相关链接

- [Talebook 服务器](https://github.com/talebook/talebook) — 自托管电子书服务端，Moke 的数据来源
- [readest](https://github.com/readest/readest) — 内嵌的专业电子书阅读器
- [报告 Bug](../../issues) — 发现 Bug？请告诉我们
- [参与贡献](CONTRIBUTING.md) — 开发者贡献指南

## 支持

如果 Moke 对你有帮助，欢迎请维护者喝杯咖啡~

<div align="center">
  <table>
    <tr>
      <td align="center"><img src="public/contributors/houheya/weixin.jpg" width="200" alt="微信赞赏码" /><br/>微信</td>
      <td align="center"><img src="public/contributors/houheya/alipay.jpg" width="200" alt="支付宝收款码" /><br/>支付宝</td>
    </tr>
  </table>
</div>

## 许可证

GPLv3
