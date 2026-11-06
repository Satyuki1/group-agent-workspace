# 原生 Harness 工作面组合示意 · V4

生成方式：内置 image_gen，使用 imagegen 技能。
产物：group-chat-harness-pane-v4.png。

本图是依据官方 ui-sidebar-right 与 ui-sidebar-documentpreview 源码说明制作的静态组合示意，不是直接截取或已经嵌入的 Harness 实际组件。实际开发应复用原生组件，不以生成图片推断原生能力。

本次已核查本机缓存版本为 0.1.1-rc.2；它与核查源码的新版右侧结构不同，因此未把旧版预览冒充为新版截图。新结构参考固定提交 8bd073392eef6f54e921a093b95076248eb08cbb。

右侧只保留资源标签、路径与预览；删去自创的群工作区标题、三分类栏、共享云电脑外壳与接管说明。文档正文为示例内容。

## 最终提示词

Use case: ui-mockup, precise UI editing.
Edit the attached approved app screenshot. PRESERVE ALL of the LEFT CHAT LIST and CENTER CONVERSATION exactly as they are. Preserve their dimensions, avatars, words, white/gray/coral palette and spacing. The user likes this minimal Grok Bot style.

Replace ONLY the RIGHTMOST COLUMN with the actual STRUCTURE of DeepSeek Harness's native right sidebar/document preview, following the source-confirmed specification below. This is a native docked resource pane, not a simulated computer, not a custom dashboard, and not a separate branded 'group workspace' component. One seamless app screenshot, same aspect ratio and size as reference. No marketing annotations.

REMOVE completely from the right column:
- the large '群工作区' heading
- the invented three category tabs '文件 / 任务 / 电脑'
- the big '让协作留在群里' headline and explanatory product claims
- all shared-computer controls, take-over buttons, viewer-count labels, avatar presence
- any operating-system desktop, window inside window, dock, screen mockup.

REPLACE with this restrained native Harness document pane:
1. A SINGLE compact 44px-height resource tab bar touches the very top of the right column. No title or other row above it. One selected resource tab with a small markdown document icon, exact filename '竞品观察.md', and small close x. Immediately after it a small plus button. At the far right of the same bar three small native monochrome controls for split pane, expand and collapse. Flat white and faint gray tab styling, fine hairline bottom border. This bar IS the entire top of the right panel.
2. Immediately under tab bar, a compact native document toolbar: a subdued path '产品共创 / 竞品观察.md' with the directory muted and basename slightly darker. Right edge has reload, external-open and file-navigator toggle icons. No invented rounded category controls. No badge. No heading.
3. The rest is a simple full-height white Markdown document preview, with a normal document title '竞品观察', around 24px and medium-bold, left aligned with 28px content padding. It must look like a native plain document viewer, never a landing page. There are just modest document contents:
   small heading '调研范围'
   body '多人聊天、Agent 协作与工作成果。'
   small heading '待比较'
   three unadorned checkbox list lines
   '群聊中的任务分工'
   'Agent 的执行过程'
   '文件与页面预览'
   small heading '参考资料'
   two plain document links, in subdued blue used only as content links:
   '产品功能记录.md'
   '界面参考.png'
   No slogans or self-description, no dashboard numbers, no green statuses.
4. Leave the lower majority of the right document pane blank, as a real short document would. No bottom footer. No AI typing, people count, title subtitle, access explanation, border card, generated 'workspace' marketing text.
5. File navigator is collapsed by default, matching the native Harness document preview behavior. Do not add another permanent sidebar or file tree.

SOURCE-GROUNDED DESIGN FACTS:
DeepSeek Harness ui-sidebar-right has no independent panel title row. Its resource tab bar is the top edge. Resource tabs, add button, split, fullscreen and collapse are native controls. ui-sidebar-documentpreview places path and file actions in a thin toolbar under that bar, then fills the pane with the resource viewer. The reference sidebar width is about 540px, so keep the navigator collapsed. Use this structure faithfully.

This design represents the approved IM shell combined with a Harness-style native resource pane. Keep it exceptionally quiet, buildable and clean. No additional features, captions, stickers or decorative elements. Only modify the right pane and maintain the exact approved conversation and left sidebar.
