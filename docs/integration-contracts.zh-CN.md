# Petdex 集成契约与排障

本文记录 Petdex 当前源码对应的用户侧契约。目录和配置示例使用 `~`、环境变量或占位符，不包含具体机器信息。桌面应用、CLI 和图库是三个不同的边界，排障时先确认实际使用的是哪一个。

## 组件职责

| 目标 | 使用方式 | 负责内容 |
| --- | --- | --- |
| 浏览、安装、提交或编辑宠物 | `npx -y petdex ...` | CLI 访问图库、下载宠物并写入本地宠物目录 |
| 显示浮动宠物、选择角色、连接 Agent | [Petdex Desktop](https://petdex.dev/download) | 桌面窗口、生命周期、Hook 安装和运行时状态 |
| 创建新宠物 | [Petdex Create](https://petdex.dev/create) 或 ChatGPT 的 `/pet` | 生成/导出素材，之后再用 CLI 提交 |

CLI 不再负责 `init`、`hooks`、`doctor`、`desktop`、`up`、`down` 或 `select`；这些旧命令只会提示改用桌面应用。不要把 CLI 的安装成功误认为桌面 Hook 已连接。

## 宠物图集格式

每个宠物目录至少包含 `pet.json` 和 `spritesheet.webp`（也接受 `.png`）。每个单元格固定为 `192x208` 像素：

- Classic v1：8 列 × 9 行，规范尺寸 `1536x1872`，`spriteVersionNumber` 省略或为 `1`。
- Hatch v2：8 列 × 11 行，规范尺寸 `1536x2288`，必须声明 `spriteVersionNumber: 2`。
- 需要缩放时，宽度必须能整除 8、高度必须能整除对应行数，并保持 `192:208` 单元格比例；只保持总宽高比例但产生分数单元格的图片不可靠。

服务端、审核器和上传页应使用同一图集判断。版本声明与实际行数不一致会在提交前或审核阶段被拒绝/暂存。审核 contact sheet 会检查 v2 的全部 11 行；额外行不能因为客户端只播放 9 个标准状态而被静默丢弃。

9 个标准状态的行顺序固定为：`idle`、`running-right`、`running-left`、`waving`、`jumping`、`failed`、`waiting`、`running`、`review`。素材质量还需要人工确认默认睁眼、动作连续性、主体比例、透明边界、左右裁切和压缩伪影；尺寸检查不能替代视觉复核。

## 安装与 Codex 深链接

### CLI 安装

```sh
npx -y petdex install <slug>
```

CLI 要求 Node.js 20+，也可使用 Bun。安装会同时写入 `~/.petdex/pets/<slug>/` 和 `~/.codex/pets/<slug>/`。登录、提交和编辑使用 CLI；桌面应用从自身 Settings 安装 Agent Hook。

### `codex://` 的限制

Petdex 生成的 Codex 链接形状是：

```text
codex://pets/install?name=...&description=...&imageUrl=...&spriteVersionNumber=...
```

当前已知解析约束：主机必须为 `pets`，路径必须为 `install`，只能有这四个参数，`imageUrl` 必须是 HTTPS，v2 素材必须显式带 `spriteVersionNumber=2`。下载器要求资源直接返回 HTTP 200，并使用 `image/png` 或 `image/webp`，不会跟随重定向。

即使 URL 完全正确，ChatGPT 桌面端接收安装弹窗的外部 feature gate 仍可能关闭；这种情况下窗口获得焦点但没有弹窗或写盘动作。这不是 Petdex URL 校验失败。当前可用的回退路径是 `petdex://<slug>` 或直接执行 `petdex install <slug>`。

这部分不是 OpenAI 的公开稳定 API。升级 ChatGPT 后，应重新读取 `docs/chatgpt-pet-integration.md` 中的检查步骤，并以实际文件写入结果验收，不要只看页面是否获得焦点。

## Hook 与 Agent 边界

桌面应用维护 `~/.petdex/bin/petdex-hook`、运行时 token 和 `~/.petdex/runtime/hooks-disabled`。Hook 会先排空标准输入，再在本地服务不可用时安静退出，不能阻塞 Agent 的主流程。需要暂时停用时使用桌面应用提供的开关或 killswitch，不要杀掉 Codex、ChatGPT 或 Agent 进程。

Codex 的当前配置由桌面应用原子更新：

```toml
[features]
hooks = true
```

同时维护 `~/.codex/hooks.json`，并保留非 Petdex Hook。配置文件损坏或结构不安全时应拒绝写入，而不是猜测修复。

### OMP（Oh My Pi）

OMP 没有可依赖的 shell-command Hook；桌面应用安装进程内扩展模块：

- 默认目录：`~/.omp/agent/extensions/petdex.ts`；
- 设置 `PI_CODING_AGENT_DIR` 后，以该目录为整个 Agent 根目录；
- `~/.omp/profiles/<name>/agent` 是命名 profile 的目录，但磁盘上没有可靠信息判断当前 `--profile`。因此桌面默认只写默认目录；使用命名 profile 时，应在启动桌面应用的环境中设置 `PI_CODING_AGENT_DIR` 指向实际 profile 根目录，再安装/刷新；
- 扩展内请求使用本机回环地址和短超时，Petdex 不在线时应静默，不得拖住 OMP 主进程。

### 远程 Agent

桌面应用的远程集成只支持 SSH 反向隧道，不提供 HTTP/API 备用通道。远程配置位于 `~/.petdex/remote-agents.json`，当前可同步的远程 Agent 是 `opencode`、`codex` 和 `hermes`。

- 远程账户必须有 POSIX shell；Codex/Hermes 的同步还需要 `python3`，shell Hook 需要 `curl`，探测需要 `ps`；
- Windows 桌面可以运行 Petdex，但 Windows 远程账户不在当前 SSH/POSIX 契约内；不能把 Windows 远程主机当成已验收平台；
- Hermes 默认使用 `~/.hermes`，自定义目录通过 `HERMES_HOME` 或远程配置中的 `agents.hermes.home` 指定，路径必须是绝对路径或以 `~/` 开头；
- 每次隧道建立后，桌面先完成探测、依赖、配置合并和 token 门控，再开放事件流；依赖缺失时保持 gated/retrying，不伪造 Connected；
- 远程写回保留外部 Hook，只更新 Petdex 自己的条目。远程账户若同时运行桌面应用，不要再把它配置为被控远程端，因为写回会替换该账户的 `petdex-hook` 为远程 POSIX 脚本。

## 排障顺序

1. 确认宠物文件是否同时存在于 `~/.petdex/pets/<slug>/` 与 `~/.codex/pets/<slug>/`，并检查 `pet.json` 的版本声明和图集尺寸。
2. 确认实际显示者是 Petdex Desktop，而不是只安装了 CLI；在桌面 Settings 检查 Agent 状态和当前宠物。
3. 若 Hook 卡住，先观察是否仍在排空输入、回环服务是否可达、token 是否存在以及 killswitch 是否被启用；不要停止正在运行的 Codex/ChatGPT 进程。
4. 若 OMP 无事件，核对 `PI_CODING_AGENT_DIR` 与实际 `--profile`，并确认扩展位于对应 `extensions/petdex.ts`。
5. 若远程无事件，先检查 SSH、POSIX 依赖和反向隧道状态；未满足依赖时的 retrying 是保护行为，不是已连接。
6. 若 `codex://` 无弹窗，直接检查目标宠物目录是否写入；没有写入时改用 `petdex install` 或 `petdex://`，不要反复重启 Agent。

## 事实边界

本页描述源码和已记录的 ChatGPT bundle 解析结果。ChatGPT feature gate、桌面发行包、公开图库资源和远程主机依赖都可能变化；它们需要在目标版本/目标平台重新验证，不能由本地单元测试代替。
