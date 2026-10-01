# 在 DeepSeek Harness 中部署

## 1. 兼容前提

本定制版仅验证 **DSH 0.2.0-rc.2**。查看 DSH 设置中的当前版本。不要为其他运行时直接放宽 peer 范围或开启版本豁免；应先核查接口。

插件需要 DSH 的 llm、默认模型、附件、文件、计时器、Typert 及 Web 客户端服务。至少配置一个有效模型。图像功能需要所选模型声明并实际支持 image。

## 2. 获取和检查

```sh
git clone https://github.com/yq-pop/dsh-prompt-polish-custom.git
cd dsh-prompt-polish-custom
pnpm install --ignore-scripts
pnpm run build
pnpm test
pnpm pack --ignore-scripts
```

`pnpm pack` 生成 `dsh-prompt-polish-0.3.2-local.dsh020rc2.6.tgz`，以实际输出文件名为准。无需运行额外编译器。不要提交 node_modules、用户工作区 `.dsh/`、凭证或安装包。

## 3. 推荐：通过插件管理器安装包

在 DSH 插件管理器/支持本地包安装的入口中选择上一步的 tgz。安装的是包名 `dsh-prompt-polish`，而不是仓库名。启用后，输入栏左侧应出现“优化”和齿轮设置。

如果已有社区原版，请将同包名依赖替换为本地包，不要增加第二个入口。市场临时 `mkt-*` 挂载和正式 bundle 同时存在时可能报重复 service `promptPolish`；应停止重复挂载，保留一个正式入口。

## 4. 本地 profile 安装方式（管理器不可用时）

先通过 DSH 界面确认正在使用的 profile 目录。桌面 macOS 常见路径是 `~/.dsh/profiles/desktop/`，但并非所有系统都相同，不能直接假设。

备份该目录中的 `package.json`、`pnpm-lock.yaml` 和 `cordis.patch.yml`，以及工作区中已有的 `.dsh/prompt-optimizer/settings.json`。以下在**已确认的 profile 目录**执行：

```sh
pnpm add /绝对路径/dsh-prompt-polish-0.3.2-local.dsh020rc2.6.tgz --ignore-scripts
```

然后在 profile 的 `package.json` 中，仅向原有 `dsh.profile.bundles` 数组追加一次 `dsh-prompt-polish`，不要覆盖其他 bundle 或依赖：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["已有的条目保持不变", "dsh-prompt-polish"]
    }
  }
}
```

以上只是片段说明，**不能原样覆盖完整配置**。安装包自带 `cordis.patch.yml`，会插入稳定 id `dsh-prompt-polish`，通常不需要手动再添加插件入口。

包只依赖 zod；peer 由 DSH 提供。不要自动执行额外依赖构建脚本。若安装器打印 Done 却不退出，请先检查文件与进程状态，不要盲目再次安装或终止 DSH 宿主。

## 5. 使升级生效

首次安装可能由当前 profile 的实时加载机制生效。**更新已加载的 Host JavaScript 时，只有刷新页面或禁用/启用插件并不保证清除模块缓存。** 推荐在没有进行中的任务时，通过应用正常退出并重新打开，再刷新当前 GUI；不要对宿主发送未知的信号或启动替代 Web 服务。

熟悉 Cordis HMR 的开发者可进行精确模块缓存清理，但这属于运行时开发操作，不是通用安装步骤。新建或更改 RPC 清单时，Typert Loader 也可能持有旧缓存；正常重启是更稳妥的部署方式。

## 6. 验收

1. 齿轮设置包含“优化模型”“优化展示形式”“图像上下文”。
2. 默认“弹窗展示”，优化后可确认采用或保留原稿。
3. “替换输入框内容”成功后文字变更、按钮绿色“已优化”；点击撤回，下一次重新优化。无自动发送。
4. 模型选择与结果中的“实际模型”一致；无独立选择时跟随全局默认。
5. 开启整体图片但无图片时正常纯文本优化，无“当前输入框没有可用图片”错误。
6. 有图且模型支持视觉时使用整图；不支持时报错而不是换模型。
7. 手动编辑、换图片、切会话和取消后不会被迟到响应覆盖。

不需要使用真实隐私图片验收，可用合成测试图。

## 7. 设置保存与回滚

设置可能在浏览器存储、页面缓存及工作区 `.dsh/prompt-optimizer/settings.json` 保存。升级不需要删除它们。旧 `imageContext: marked` 读取兼容为整体图片，下一次显式保存迁移；区域选择功能已移除。

回滚：重新安装之前备份的 tgz，保持原单一 bundle 入口，然后正常重启 DSH。只在确认需要时恢复配置备份，避免覆盖用户升级后新增设置。不要修改或删除凭证文件。

本地 tgz 依赖使用 `file:/...` 时应保留包文件，未来重新安装依赖需要它。市场“更新”可能覆盖定制功能，应先确认 upstream 功能和兼容版本。
