<img src="assets/icon.svg" width="64" height="64" alt="">

# Pi Advisor

为 [Pi](https://pi.dev) 增加一个顾问模型。在主模型需要规划、排查反复出现的错误或检查完成情况时，通过 `advisor` 工具征求第二意见，再继续执行任务。

灵感来自 [Claude Code Advisor](https://code.claude.com/docs/en/advisor)。这是 Pi 原生扩展，通过客户端调用另一个模型；不依赖 Anthropic 的服务端 Advisor API。

## 安装

需要 Node.js 22.19+，开发及验证版本为 `@earendil-works/pi-coding-agent` 1.6.0。

在本项目目录执行：

```bash
pi install .
```

重启 Pi，或在已有会话中 `/reload`。也可以只加载一次：

```bash
pi -e ./extensions/index.ts
```

## 使用

默认关闭。运行 `/advisor`，从已配置认证的模型列表选择顾问。也可以指定完整的 `provider/model-id`，或没有歧义的完整 model ID：

```text
/advisor
/advisor anthropic/claude-opus-4-6
/advisor status
/advisor off
```

模型 ID 以你的 Pi 模型列表为准（`pi --list-models`）。跨供应商、自定义模型、同一模型作为第二意见均可使用；不推断模型能力排名，也不提供易随版本变化的 `opus` 等简称。通过 `/advisor` 设置的选择写入 `~/.pi/agent/advisor.json`，跨会话生效；设置了 `PI_CODING_AGENT_DIR` 时使用该目录。

启动时可临时覆盖保存的默认值，作用于当前进程：

```bash
pi --advisor anthropic/claude-opus-4-6
pi --advisor off
```

非交互模式下 `/advisor` 输出当前状态；`/advisor provider/model-id` 和 `/advisor off` 仍可修改默认值。

启用后主模型决定何时调用，不会每一轮强制咨询。你也可以直接提示：

```text
先咨询 advisor，检查这个迁移方案的风险，然后继续实现。
完成后请让 advisor 检查测试证据，指出遗漏。
```

顾问只提供建议，没有文件、终端或其他工具权限。主模型收到建议后继续工作，并应根据实际证据判断是否采纳。咨询期间状态栏显示 `Advising`，工具结果包含 `Reviewed`、`Declined` 或 `Advisor unavailable`，可展开阅读建议。

## 上下文、费用与限制

- 每次咨询发送主模型系统提示和当前活动分支的对话，包括文本、工具调用及结果。压缩前历史使用 Pi 已生成的摘要；不会重新加载全部旧历史或其他分支，也不会读取未进入对话的磁盘文件。
- 对话以引用的 JSON 文本传递，兼容跨供应商调用；不复用供应商签名，图片标记为省略。此版本适用于文本和代码审查。
- 文本和工具结果不会被插件截断。若超出顾问上下文窗口，返回不可用信息；可压缩对话后再咨询。
- 复用 Pi 的模型注册表、认证、OAuth、自定义供应商及请求配置。不额外保存凭据。选择跨供应商顾问会将上述上下文发送给该供应商。
- 每次咨询会产生额外模型用量。用量保存在工具结果的 `details.usage` 中；不并入 Pi 主模型的 `/stats` 统计。
- 最长咨询时间为 120 秒，输出上限为 4096 tokens（或模型更低的上限）。输出触顶时明确提示内容可能不完整。
- 支持取消；关闭或更改顾问、切换会话会取消正在进行的咨询。调用失败会返回可读信息，主模型可继续任务。不会自动重试咨询。

配置示例：

```json
{
  "model": "anthropic/claude-opus-4-6"
}
```

将 `model` 设为 `null` 关闭。配置文件无效时提示警告并保持关闭；`/advisor` 可重新保存有效配置。

## 开发

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

测试覆盖配置持久化、模型解析、启用/关闭、上下文传递、错误/拒绝/截断响应，以及取消时丢弃过期建议；不需要真实 API 凭据。
