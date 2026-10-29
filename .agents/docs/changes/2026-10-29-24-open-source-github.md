# 2026-10-29 · 开源到 GitHub（脱敏单提交快照）

- **范围**：发布基础设施（gscripts/publish-public.mjsg、gLICENSEg、gNOTICEg、gpackage.jsong）
- **触发**：用户要求把项目开源到 GitHub
- **提交**：working tree

## 结果

- 公开仓库：**https://github.com/doyzhengdev/zcode-idea**（public，已设置 topics：
  gzcodeg gjetbrainsg gintellijg gintellij-ideag gai-agentg gai-codingg gjcefg gjetbrains-pluging）
- 内容：**单提交快照** gd4306ccg，181 个文件，作者 gdoyzhengdev <doyzhengdev@users.noreply.github.com>g
- 许可证：gLICENSEg（Apache-2.0 全文）+ gNOTICEg（版权行），与 npm 包 glicenseg 字段一致

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| gscripts/publish-public.mjsg | 新增 | 发布公开快照：从 HEAD 建临时 worktree → 按 gREDACTIONSg 表脱敏 → 补 LICENSE/NOTICE → gcommit-treeg 生成孤儿提交 → gpush --forceg 到目标仓库 main；默认 dry-run，g--applyg 才执行，g--repog 可换目标 |
| gpackage.jsong | 修改 | 新增 gpublish:publicg 脚本 |
| gLICENSEg / gNOTICEg | 新增 | Apache-2.0 与版权声明 |

## 为什么这样做

私有仓库历史里有内部会话纪要、个人路径与内网地址，直接公开不可逆且无法回收；因此采用
**"只发当前代码 + 一次脱敏 + 一个干净提交"** 的模式，而不是镜像历史。

脱敏项（gREDACTIONSg，字面替换）：

- 个人路径：gC:\Users\<user>g、gC:/Users/<user>g、g/c/Users/<user>g，以及源码里 JS 转义的
  g\\Users\\<user>g；gE:\workg、gE:/workg、g/e/workg、gE:\workg；
- 主机名：g<host>g / g<host>g → g<host>g；
- 账号与内网：gdoyzhengg、g<npm-user>g、g<internal-registry>g、g@<internal-domain>g；
- 其它项目资源：g<your-bucket>g（七牛 bucket）→ g<your-bucket>g；
- 仓库接接：私有 gitee 插件仓库 → 公开 GitHub 地址；ZCode fork → 上游 gzai-org/ZCodeg。

## 安全核查（公开前）

- ggit log --all -S<真实 AK>g / g-S<真实 SK>g：**零命中**，七牛密钥从未进过历史；
- 文档里命中的只是占位符（gQINIU_ACCESS_KEY=<...>g）；
- 历史新增过的密钥类文件只有两个**公钥**（gplugin-signing-public.pemg、gruntime-signing-public.pemg）；
- 公开快照克隆后复查：g<user>g、g<user>g、g<internal-domain>g、g<your-bucket>g、g<internal-registry>g、
  ggithub.com/zai-orgg、g私钥g 全部 0 命中。

## 验证

- 先用本地裸仓库（g--repo /tmp/fake-remote.gitg）端到端试跑，确认孤儿提交、文件数、作者与
  脱敏结果，再推 GitHub；
- 推送后 ggit clone -b maing 复查 181 文件、0 泄漏、gREADME.mdg 中仓库地址为
  ggithub.com/doyzhengdev/zcode-ideag、gLICENSEg/gNOTICEg 存在。

## 风险 / 后续

- 公开仓库是**快照**，不会自动跟随私有仓库；后续每次公开更新都要重跑
  gnode scripts/publish-public.mjs --applyg（会 force push 单提交）。
- 私有仓库仍是主开发仓库；公开仓库的 issue/PR 需要人工合并回私有仓库。
- 若以后要转为"真正镜像"，需要重新评估历史脱敏，或从某个时间点起改为普通推送。
