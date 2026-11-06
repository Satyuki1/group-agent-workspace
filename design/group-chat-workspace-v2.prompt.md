# 群聊共享工作区 UI · V2

生成方式：内置 image_gen，通过 imagegen 技能生成。
产物：group-chat-workspace-v2.png。静态视觉概念稿。

本版按用户反馈，贴近 Grok Bot 的清爽风格：浅灰会话栏、大面积白色、少量红色强调、单行输入框、安静的文档工作区。减少标签、状态面板与工具栏。保留 V1 供对照。

## 最终提示词

Use case: ui-mockup. Redesign the first attached UI mockup radically, using the SECOND attachment (Grok Bot screenshot) as the primary aesthetic reference. User says the first mockup is ugly and too busy. Produce a much cleaner, calmer, more beautiful Chinese desktop IM application screenshot. Preserve only the product concept: chats left, human-and-agent conversation middle, group workspace right. Completely replace the dense design language.

OUTPUT: One single full application screenshot, wide landscape 16:10, front-facing, high resolution with crisp Chinese. No surrounding device, no presentation title, no diagram or annotations. A realistic macOS desktop application, restrained and understated. This should closely evoke the clean, almost empty Grok Bot reference, with natural generous spacing, simple soft gray chat bubbles and a SMALL amount of warm coral-red as the sole action accent. Do not use the blue enterprise-dashboard styling from the first attachment.

LAYOUT:
Left 21%, center 47%, right 32%. One-pixel light-gray vertical separators. Backgrounds white and barely off-white only. 40% of screen should be quiet negative space. Near-black primary text, warm gray secondary text. Clean PingFang-like typography, normal weight body, medium weight names. No thick borders. No gradients. No drop shadows except a barely visible composer shadow. No repeated colored pills, no AI badges, no status chips, no summary banner, no task cards, no progress bars, no comparison table, no analytics, no dense toolbars. Hierarchy through whitespace and alignment, never nested cards.

LEFT SIDEBAR:
Very pale neutral gray background.
Tiny macOS traffic lights at upper left. Magnifying glass and plus inside understated small white circles at upper right. Below, a simple black rounded avatar icon and small title '我的空间'. Do not take excessive vertical height for branding.
Exactly six conversation rows, nicely spaced, avatars 40px. Each has a short name and one muted preview, small unobtrusive time if room. Selected row is a very light gray rounded rectangle, NOT colored.
Rows:
'产品共创群' / '调研员：竞品观察已更新'
'我的助理' / '今天的安排已经整理好了'
'林悦' / '我们先把聊天体验做好'
'设计讨论' / '第一版界面已经准备好'
'调研员' / '找到了几个值得参考的产品'
'每日计划' / '明天有 2 项待办'
Avatars: restrained simple abstract blob shapes for agents, one human portrait for 林悦, one tiny 2x2 mosaic for group, no extra badge over avatars. Selected group has one muted red organic star-like simple avatar to echo the reference. Do not fill each row with extra metadata.
Bottom account row one small portrait, '我的工作空间', a tiny settings outline. No footer boxes.

CENTER CONVERSATION:
Top clean 72px header, title '产品共创群' centered, a tiny down chevron beside it; one ellipsis icon at far right. No member counters, no avatar stack, no banner, no tabs here.
Chat content starts comfortably below the header with small centered muted '今天 14:28'.
Four short natural messages total, generous vertical breathing room:
1 Right-aligned warm coral red bubble with white readable text: '我们做一个能让人和 Agent 一起工作的产品。' Round corners, no loud outline.
2 Left tiny black abstract agent avatar, subtle sender label '群助理', light warm-gray bubble: '可以。我先整理竞品，设计师同步准备界面。'
3 Left small gray agent avatar, sender '调研员', light warm-gray bubble: '对比结果整理好了。聊天要自然，工作区随群共享。'
Beneath this third message, ONE very minimal attachment row, thin neutral border, no colored background, file line icon, title '竞品观察.md', small secondary '刚刚更新', arrow icon at right. It belongs to this message and is narrower than chat pane.
4 Left tiny human portrait, sender '林悦', simple light-gray bubble: '先把聊天体验做好。'
No delegation diagram, no task ownership panel, no animated typing row. Broad empty breathing room below the latest message.
Bottom composer like the Grok Bot reference: one slim floating elongated pill at bottom inset 24px. Plus at far left, '@' icon, placeholder '发消息，或 @ 一位伙伴', microphone near right, a compact CORAL RED circular send button with white up-arrow. Only one row, no separate footer, no Enter hint, no toolbar clutter.

RIGHT GROUP WORKSPACE:
Same bright white, integrated into app; feels like a quiet open document, not a dashboard.
Top has title '群工作区' at left and one small expand icon at right, aligned to center header.
Under header, simple three compact text tabs centered '文件' '任务' '电脑'; '文件' active with a soft light-gray capsule, no colored underline.
Below a small filename line with file outline icon and '竞品观察.md', a tiny ellipsis at right. Subtle horizontal divider.
Open document directly on the white pane, no outer card or shadow, generous side padding 32px.
Modest document title '让协作留在群里' (not oversized). One gray metadata line '调研员 · 刚刚更新'.
Then only three short editorial sections with generous spacing:
heading '聊天是入口'
body '人和 Agent 在同一个群里，直接讨论、提问和分工。'
heading '成果就在右侧'
body '文件、页面和应用集中在群工作区，边聊边看。'
heading '任务持续进行'
body 'Agent 在后台完成工作，有结果时再回到群里。'
A tiny subtle inline text link at bottom of document '查看参考资料 ↗', muted gray.
Leave significant empty space below. At bottom, a very faint single-line footnote '群成员共享此工作区'. No cards, no file tree, no progress indicators, no extra sidebar.

VISUAL BAR:
Quiet, intimate, fluid, immediately understandable, mature desktop chat app. Use the restraint and soft round messaging language of the Grok Bot reference. Stylish through proportion, typography and empty space. Make it feel a product someone would use all day, not a feature showcase. All text crisp and correctly spelled. Keep the entire app visible with no cropped footer. Output only the redesigned screen.
