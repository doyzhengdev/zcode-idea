# 2026-10-26 · 七牛 CDN 缓存：内容寻址 + 缓存头修正与告警

- **范围**：`scripts/release.mjs`、`scripts/npm/README.md`
- **触发**：确认“同版本覆盖 + 七牛 CDN 缓存”是否真正解决；实测发现对象头
  `Cache-Control` 被域名缓存规则覆盖
- **提交**：working tree（未提交）

## 问题链路

1. 旧方案 zip 固定 key（`.../stable/zcode-ide-<version>.zip`），同版本重发覆盖同 URL。
2. 七牛 CDN 边缘对该对象缓存 `public, max-age=31536000`；覆盖上传后边缘仍返回旧
   51MB zip，而源站已是 3.8MB，出现“清单/包错配”的窗口。
3. 上传实现里表单字段写的是 `Cache-Control`，七牛只认 `x:Cache-Control`；
   修正后实测**域名级缓存规则仍然覆盖对象头**，HEAD 依旧返回
   `public, max-age=31536000`。
4. 测试域名不支持 CDN 刷新（refresh API 返回 404），无法 purge。

## 解决方式

- **zip 内容寻址**：`<prefix>/plugin/<channel>/<version>/zcode-ide-<version>-<sha12>.zip`。
  内容变 → key 变 → 不命中旧缓存；旧 key 永久对应旧内容。即使 manifest 边缘滞后，
  也只会指向一个完整、哈希匹配的旧 zip，不会错配。
- **manifest/sig 是唯一可变指针**：更新可能因 CDN 缓存而延迟，但不会给出错误内容。
- **修正上传字段**：`Cache-Control` → `x:Cache-Control`（七牛自定义元数据语法）。
- **新增检测告警**：manifest/sig 上传后读取实际 `Cache-Control`，若被域名规则覆盖
  （不含 `no-cache` / `no-store` / `max-age=0`），打印明确警告：
  需要在 CDN 控制台把该路径缓存设为不缓存（TTL=0），或发布后刷新 URL。
- **CDN 刷新**：发布流程仍会对 manifest/sig 调用刷新；测试域名 404 属已知限制，
  生产 HTTPS 域名需确认刷新能力。

## 七牛 CDN 能关闭缓存吗

可以，但要分两层：

1. **对象头**：用 `x:Cache-Control`（或 `chgm` API 设置 `x:Cache-Control`）；
   实测在测试域名上会被域名缓存规则覆盖，单靠对象头不可靠。
2. **域名缓存规则**：在七牛 CDN 控制台的缓存配置里，对
   `.../plugin/*/manifest.json` 与 `.../manifest.sig` 设置 TTL=0 / 不缓存
   （或“遵循源站”）；**TTL=1s 也足够**（客户端最多滞后 1s）。
   改规则后还要对已缓存的旧对象做一次刷新/预热，否则旧的 1 年条目仍可能在边缘命中。
3. **彻底不缓存**：把这两个路径的缓存规则设为不缓存即可；zip 仍建议保持
   `immutable` 长缓存（内容寻址保证 URL 不变内容不变）。

## 随机 query 能破缓存吗

**在这个域名上不能**。实测对同一对象追加随机 query、并带请求头
`Cache-Control: no-cache` / `Pragma: no-cache`，响应仍是
`X-Bdcdn-Cache-Status: TCP_HIT`，`Age` 持续增长 —— 说明缓存键忽略了 query，
请求头也不触发回源。

若在七牛控制台关闭“过滤参数”（让 query 参与缓存键），随机值会强制 MISS，
但每次请求都回源、失去 CDN 意义；对几百字节的 manifest 可接受，但不是首选，
而且依赖域名配置。更稳的是版本化路径（内容寻址）或刷新/短 TTL。

当前测试域名（`tnbe4cmeo.hn-bkt.clouddn.com`）在后台设为 1s 后实测：
manifest 仍返回 `Cache-Control: public, max-age=31536000`、`Age=75~78s`，
说明规则尚未落到该域名，或旧的 1 年缓存条目还没被刷新。测试环境可继续用
“换前缀/换 key”验证；生产域名需确认规则命中的域名/路径并刷新一次。

## 验证

| 命令 | 结果 |
|---|---|
| 上传探针（`x:Cache-Control: no-cache`） | 上传响应回显 `x:Cache-Control`，但 HEAD 仍返回 `public, max-age=31536000`，确认域名规则覆盖 |
| `--apply --push --prefix zcode-ide-test --channel test` | 内容寻址 zip 上传后 HEAD 通过；manifest/sig 输出“CDN 缓存策略覆盖了对象的 no-cache”警告；manifest HEAD 仍返回旧对象大小（227 vs 300），按设计只警告不中止；刷新 404 警告 |
| 旧 stable 对象 | 仍返回旧 51MB 内容与 1 年缓存；manifest/sig 验签通过，线上一致 |
| 后台把缓存设为 1s 后 | 新对象头变为 `max-age=1`，但同 key 覆盖后轮询 24 次（≈16s）仍是旧内容、`Age` 持续增长且 `TCP_HIT`；随机 query 与请求头 `no-cache` 也仍命中缓存。说明该测试域名的边缘 TTL 未按 1s 生效（或规则不在该域名），需要确认域名并刷新旧条目。脚本按 `Age<=5s` 判断短 TTL 生效，否则告警 |

## 风险 / 后续

- 测试域名无法 purge，manifest 更新延迟只能靠换前缀规避；生产必须配置缓存规则/刷新。
- 后台把 TTL 设为 1s 是可行方案，但要确认规则命中的是实际使用的域名与路径，
  并在改规则后刷新一次旧缓存条目；否则 `Age` 会一直增长。
- zip 内容寻址导致旧对象累积，需要生命周期清理策略。

## 相关

- [插件版本改为跟随仓库根 package.json](./2026-10-26-9-plugin-version-source.md)
- [发布脚本合并为 `scripts/release.mjs`](./2026-10-26-6-release-script-merge.md)
