# 源账号视觉模板逆向与确定性生成管线

## 结论与范围

当前问题不是模型没有视觉能力，而是视觉观察被压缩成全局风格字段，再套进通用卡片布局；缺少能表达原图结构的模板模型，以及以原图为基准的独立验收。

目标应从“模仿风格”改为“从原图编译模板，再填入新内容”。固定品牌资产尽量原样复用；动态内容按原模板的字体、几何、颜色和容量规则生成。

本文件是研究与设计，不表示实现或验收已经完成。本次只读代码与本地图片，未调用模型、未访问小红书、未修改数据库或运行设置。已有工作区改动保留。

## 1. 本地原图证据

检查图片：

- `data/media/corpus/339/0.jpg`
- `data/media/corpus/339/1.jpg`
- `data/media/corpus/339/2.jpg`
- `data/media/corpus/340/0.jpg`
- `data/media/corpus/340/1.jpg`
- `data/media/corpus/340/2.jpg`

以上均为 1080 x 1440。使用 sharp 解码像素，四张内页通过行像素中位数检测到深色页脚始于 y=1313，高度为127px。边缘存在 JPEG 压缩过渡，不应只取一列连续同色像素判断边界。

| 项目 | 339 样本 | 340 样本 | 设计含义 |
| --- | --- | --- | --- |
| 封面底色 | 白色 | 白色 | 不是通用浅蓝渐变 |
| 内页底色 | 采样 #FAFAFA | 视觉为浅灰白 | 封面与内页需独立 token |
| 页脚 | #333333，约127px | #333333，约127px | 固定品牌组件可共享，但保存各自测量证据 |
| 顶部品牌区 | 图形 WOW + 右侧两行文字 | 同类品牌区 | 不能用普通字体 WOW 代替 |
| 封面主标题 | 黑字主题 + 蓝底白字强调块 | 同类标题结构 | 强调块不是文本下方半透明高亮 |
| 内页编号 | 大号浅蓝 01/02，左侧 | SHIFT · 01 / STRUCTURE · 02，细字与横线 | 至少存在两种模板族，不能多数投票合并 |
| 内容结构 | 比较列表、蓝色面板、引用、胶囊关系图 | 双栏对比、配图、分隔列表 | 分栏应属于区域，不是账号唯一整数 |
| 封面底部 | 三组固定中英文服务文案 | 大面积案例配图 | 账号共用品牌不代表共用封面底部 |

339 内页编号的实际像素采样为 #D8E9FB / #D8E9FD；蓝色强调块的一处封面采样为 #0683FF。它们是 JPEG 样本像素，不等于已经反推出原始设计文件色值。必须用平坦区域统计和跨样本证据建立色值范围，不能强行统一成一个通用调色板色号。

现存 `data/media/_sample/smoke-render/` 样张尺寸也为1080 x 1440。观察到普通文字 Logo、渐变背景、封面标题下沉、不同的强调表达、内页编号与标题重叠以及大面积不符合原图的留白。样张是既有产物，未在本次重新运行渲染；当前代码缺陷另行只读核对。

## 2. 当前无法复刻的根因

### 2.1 把模板族压缩成一个账号风格

`server/src/generate/design/contract.ts:83` 的账号模板是全局字段，缺少 template family、逐页角色、区域树、几何、字体资产和证据引用。`server/src/corpus/profile.ts:475` 附近通过聚合选择单一编号与分栏，无法保留339与340两套不同的编号体系。

这不是增加提示词能解决的问题：输出结构本身装不下原图信息。

### 2.2 图片输入存在，不等于建立了逐页视觉档案

`server/src/corpus/analyze.ts:284`、`server/src/corpus/analyze.ts:372` 与 `server/src/llm/vision.ts:56` 存在图片采样/数量限制；`server/src/corpus/profile.ts:540` 的画像聚合不能代替每页建模。缺少按图片哈希与提取器版本标记的覆盖清单，历史已蒸馏记录不能自然视为新视觉模板已提取。

四图请求上限应是分批传输限制，而不是整篇后续页面永久不可见。

### 2.3 固定资产被当作可重写的文字

`server/src/generate/cards.ts:354` 附近绘制的是文字 Logo。真实图形 Logo 的轮廓、字距、倾斜与普通字体不同。当前结构也无法保存精确品牌资产裁切、版权来源与字体文件哈希。

原图已有的固定品牌区不应每次让模型重述，再用近似字体重画。

### 2.4 渲染器仍主动“美化”，不是遵循原图

`server/src/generate/cards.ts:219`、`server/src/generate/cards.ts:253` 保留通用主题背景/样式路径。`server/src/generate/design/resolve.ts:146` 的默认 account template 蓝色 accent 还可能覆盖无模板来源的主题色。

复刻模式应禁止通用主题、默认渐变和通用装饰介入。只有缺乏已验证模板且明确选择通用模式时才走原有主题。

### 2.5 内容类型布局代替源模板构图

`server/src/generate/layouts.ts:151`、`server/src/generate/layouts.ts:157` 的封面 flex 分配会把标题压向下部；`server/src/generate/pipeline.ts:188` 使用通用布局选择。

“cover/list/steps”只描述内容类型，不足以描述原图中标题、强调块、比较矩阵、照片、固定服务文案的具体结构。

### 2.6 编号信息没有真正控制输出

`server/src/generate/cards.ts:382` 使用页索引逻辑；`server/src/generate/layouts.ts:120` 的编号绝对定位叠加外层 padding，导致位置偏移。即使编号数值正确，字体、字号、颜色、与标题的空间关系也可能错误。

编号必须区分图片序号、章节序号、页内条目序号。它们不能共用一个 idx。

### 2.7 分栏不是全局开关，fit 不能悄悄删内容

`server/src/generate/layouts.ts:98`、`server/src/generate/layouts.ts:218`、`server/src/generate/layouts.ts:264` 的分栏并非覆盖所有布局。`server/src/generate/pipeline.ts:19`、`server/src/generate/pipeline.ts:73` 的容量处理存在静默裁切内容的风险。

原图一页可以同时存在全宽标题、两栏比较、单栏结论、局部配图。需要区域树与槽位容量，而非全局 columns=2。

### 2.8 页脚条修了，正文安全区仍未建立

`server/src/generate/design/contract.ts:120`、`server/src/generate/design/contract.ts:121` 当前默认页眉128px、页脚126px；`server/src/generate/cards.ts:356` 与 `server/src/generate/cards.ts:357` 已有两行品牌文字。旧的“78px、只有一行”结论不再适用于当前实现。

但 `server/src/generate/cards.ts:221`、`server/src/generate/cards.ts:430` 的内容空间未完整扣除页脚。dense 下正文底部可达1364，页脚顶为1314，理论重叠50px。需要真正的保留区约束，而非仅移动另一个 footer 标签。

### 2.9 验收验证的是自己的参数，不是原图

`server/src/diagnostics/smoke-render-pixels.ts:151` 在编号不存在时可能跳过断言；`server/src/diagnostics/smoke-render-pixels.ts:161` 检查HTML含有同一spec文字，不等于最终图片文字正确。`server/src/diagnostics/check-layout.ts:125` 未覆盖所有普通文字/品牌区碰撞。

`server/src/generate/render-compare.ts:65` 使用登录 profile，也不符合完全隔离的离线渲染要求。

编译通过、HTML包含文字、采样到深灰像素，只能证明局部功能运行，不能证明源账号模板复刻成立。

## 3. “完美复刻”的可执行定义

不承诺只有压缩图片就能对任意新文案做到数学上的整图逐像素一致。字体缺失、JPEG压缩、不同文案行长和图片素材变化都会造成不可避免的差异。

应把承诺拆成三层：

1. 固定品牌资产：在同画布与同坐标、无缩放、无额外压缩的条件下，可做到复用资产解码像素一致。Logo、品牌两行文字、固定装饰和该模板族特有的固定服务文案优先走此层。
2. 源页面离线重建：使用原文和已授权原素材回放，校准动态文字、版式、颜色与图片位置。只用于本地测试，不作为新稿发布。
3. 新内容模板一致：新文案按同一模板几何、字体体系、颜色角色、编号与容量约束排版，不拿不同内容整图做相似度硬比较。

字体没有找到时标记 `font_unverified`，不把近似字体视为已完成1:1。栅格图不能唯一反推出原字体、图层与约束；能够获得原设计文件/授权字体时，应直接导入，而不是继续猜测。仅凭现有图片时允许一次校准，不能用“全自动”掩盖不确定性。

## 4. 新管线

```text
本地语料图片清单 + 来源/哈希
            |
      逐页证据提取
  OCR + 像素几何 + 视觉语义
            |
       PageEvidence IR
            |
  聚类、异常检查、低置信度校准
            |
  BrandKit + TemplateFamily Registry
            |
  原文回放 -> 独立校验 -> verified版本
            |
       新文案 DocumentPlan
            |
       类型化槽位填充
            |
  实际字体测量 / 分页 / 安全区检查
            |
     隔离、确定性离线渲染
            |
   几何 + OCR + 资产 + 视觉验收
            |
    passed候选图 / blocked报告
```

### 4.1 素材清单与覆盖率

每张图片建立记录：sourceId、noteId、pageIndex、原文件路径、SHA-256、尺寸、文件有效性、提取器版本、模型/提示版本、处理状态、失败原因。

先用全部本地图片做轻量检测和候选聚类，再按模板族选择代表图进行重型视觉解析。保留同篇页序与跨页关系，不只看封面加前三页。未知/离群页面进入 unknown，不硬塞已知模板。

UI分别显示：笔记文本蒸馏覆盖率、逐页视觉解析覆盖率、已验证模板覆盖率。三个指标不能合并成一个“98%”。

### 4.2 三种互补证据

- OCR负责可检索文字、行与字的边界框、顺序和识别置信度，不负责凭空识别准确字体。
- sharp负责平坦色块、条带边界、线宽、间距、图块边界等可测信息；避免用整图主色权重替代强调色。
- 视觉模型负责语义关系：封面/内页、编号/栏目名、左右比较、引用、固定品牌、配图与装饰。输入整页加局部高分辨率裁切；局部坐标必须能映射回原画布。

每个字段保存 `value + evidenceRef + method + confidence + extractorVersion`。证据冲突保留多个候选；模型不能以主观描述覆盖像素几何，OCR不能把Logo当普通文字字体。

### 4.3 逐页中间表示 PageEvidence

保留 region tree，而非一句“蓝白、双栏、现代简洁”：

- 页面角色、模板族候选、父子区域与阅读顺序。
- 每个区域的原画布bbox与允许误差；测量框区分可见墨迹框与排版容器框。
- text/panel/image/logo/rule/numbering 等区域类型。
- 文本内容、字体候选、权重、字号区间、行高、字距、对齐、颜色角色。
- panel的填色、边框、圆角、内边距；image的来源、裁切、fit和锚点。
- 同页约束：对齐、等宽、列间距、间隔、保留区、不可相交关系。

提取输出是数据，不是自由生成HTML/CSS，不直接执行模型返回的代码。

### 4.4 三层模板模型

**BrandKit：账号固定身份**

保存原样品牌资产、黑/白Logo版本、两行品牌文字、画布比例、授权字体资源与哈希。页眉/页脚作为可选品牌组件，组件的位置和大小由模板族决定，避免强迫全部历史图片用相同条高。

资产只允许明确的固定品牌区域，禁止把整张旧图片作为背景盖上新文案。裁切保存原图坐标及来源；平台水印不误认成品牌Logo。没有干净且可用的授权素材时标记资产待校准，不把清除水印当默认处理步骤。

**TemplateFamily：一套真实版式语言**

例如暂定 `wow-ip-trend-v1` 对应339，`wow-brand-case-v1` 对应340，最终由更多样本确认，而非仅凭两篇认定全量分类完成。

每个family保存 cover/inner/ending 等pageVariant，以及区域树、精确颜色角色、字体度量、强调方式、编号组件、分栏与图像槽位。固定坐标与自适应约束共存：品牌区锁定，正文允许在已观察范围内伸缩。

复刻模式不再受 still-paper/signal-proof/bridge-canvas 的有限主题枚举约束。既有通用设计合同保留给通用模式；复刻模式使用独立版本化契约，禁止被 coerce 自动量化成近似palette。

**DocumentPlan：一篇新稿的页序与内容结构**

明确选择一个兼容的family，记录页面角色、pageVariant、sectionOrdinal、itemOrdinal和imageIndex。模型只能从已验证模板中选择并填槽，不能临时发明标题位置、颜色或栏数。不同family只有经过显式兼容规则才可混用。

### 4.5 固定资产与动态字形分开

固定Logo与两行品牌文案优先整块复用，避免字体误差；背景不匹配时保存独立组件或分别建立已观察的浅/深版本，不盲目去底或矢量化。

动态标题和正文必须用真正字体排版。字体候选通过同文字局部回放比较笔画、宽度、字重、行高与字距；多个候选难以区分时记录未确认状态。字体文件本身的许可另行核查。

### 4.6 文案适配，而不是样式适配

模板槽位规定：语义类型、最大行数、真实像素宽高、条目范围、是否必填、是否可分拆、允许字号范围、强调范围。

先生成符合槽位的文本，再用加载完成的真实字体测量。溢出的处理顺序：

1. 在模板已允许范围内调整断行。
2. 请求保持语义的缩写，记录版本差异。
3. 换同family内已验证的容量变体。
4. 在允许的位置拆成多页，维护编号与结论完整性。
5. 仍无法适配则blocked，不裁切必需条目、不侵入页脚、不无限缩小字体。

“全部条目仍存在、关键结论未删、必填槽位完整”必须作为结构性断言。

### 4.7 确定性渲染

首期沿用现有 HTML/CSS + Chromium，不为复刻再造排版引擎。建立专用模板组件，关闭通用渐变、texture、motif、随机构图和默认主题覆盖。

显式划分品牌保留区与正文区域，先布局再检测。所有坐标以模板原始画布为依据；不要让多层padding重复偏移。编号与标题用共同grid约束，不能独立浮动碰运气。

使用全新离线browser context，不使用 `PROFILE_DIR`。禁止外网请求，不加载XHS会话。锁定浏览器版本、字体哈希、viewport=模板画布、deviceScaleFactor、locale、时区；等待字体/图片解码完成，关闭动画与时间变化，输出PNG母版再按需要导出JPEG。

如果未来需要SVG导出，可局部采用resvg-js；不要同时引入多套文字度量引擎作为首期复杂度。

## 5. 独立验收与失败闸门

### 5.1 测试数据必须独立

按笔记/发布时期划分模板建立集与留出集，不能同篇相邻页分别进入训练与验收造成泄漏。加入历史版本、缺失资产、长标题、多栏、无编号与栏目式编号样本。

golden与关键几何来自原图证据或独立校准，不从待测spec重新生成预期值。校验器版本与模板版本分别记录。

### 5.2 原文回放验收

在本地用原文、原素材重建，输出原图/结果/叠加/差分/区域测量报告。检查固定品牌资产、整体构图、文字bbox、基线、换行、色块、分栏与留白。

JPEG压缩和抗锯齿需要容差；原始设计文件不存在时不得声称全图零差异。不能仅用一个SSIM分数掩盖Logo错误或编号缺失。

### 5.3 新文案验收

不比较新旧正文像素，改为验证模板约束：品牌资产是否正确、角色颜色是否正确、布局变体是否正确、所有槽位是否满足容量、编号与页序是否正确、内容是否被删或遮挡。

从最终PNG重新OCR关键文字，结合源内容结构检查必填项；OCR置信度低时标记需复核，不能把HTML含字符串当最终图片可读。

### 5.4 建议初始阈值（待校准，非已验证结果）

| 层 | 建议起点 | 闸门 |
| --- | --- | --- |
| 固定资产 | 同尺寸无缩放时解码像素一致，记录hash/坐标 | 错资产、错位置、漏品牌直接fail |
| 品牌条/主要区域几何 | 1080x1440下边界误差不超过2px | 不符合则fail或校准 |
| 平坦角色色 | 使用区域中位色与感知色差，先以Delta E 2000 <= 2试校准 | 不用单个压缩像素判通过 |
| 编号 | 模板族、文本、位置、大小、色彩全部匹配 | 缺失/错序/碰撞直接fail |
| 排版 | 必填槽位完整；相交、裁切、品牌区侵入为0 | 任一违反直接fail |
| 原文动态文字 | 同字体/同文本时校准行数、bbox与基线 | 字体不明不标精确verified |
| 差分/SSIM | 分区域辅助报警，不设未经校准的统一总分通关线 | 不能覆盖硬失败 |

模板状态：`extracted -> needs_calibration -> replay_passed -> verified`。新内容状态：`planned -> fitted -> rendered -> passed | blocked`。

生产只能使用verified模板生成passed候选。模板缺失不能静默退回通用主题后仍贴“1:1复刻”。视觉模型可以诊断差异，但不能修改golden或通过降低阈值给自己放行。自动修正最多有限轮次，仍不达标保留差分并阻断。

## 6. 开源参考与选型

推荐最小栈：现有sharp与Chromium渲染 + 一个本地中文OCR worker + pixelmatch独立差分；视觉模型继续使用现有多模态客户端。

| 项目 | 许可 | 用途与限制 |
| --- | --- | --- |
| PaddleOCR / PP-OCRv5 | 仓库Apache-2.0；官方server_det/server_rec模型卡分别标Apache-2.0 | 中文文字与bbox主选；本地Python worker会增加Windows环境和依赖维护；OCR不等于模板逆向 |
| sharp | Apache-2.0 | 已有像素测量、资产裁切与合成；底层libvips为LGPL-2.1-or-later，打包分发需单独遵守其义务 |
| Playwright | Apache-2.0 | 沿用现有浏览器排版与截图，固定环境；它不是模板提取器 |
| pixelmatch | ISC | PNG局部差分；对齐、尺寸、JPEG容差和mask需要我们建立 |
| ssim.js | MIT | 后置辅助结构相似度；不能证明文字或Logo完全正确 |
| resvg-js | MPL-2.0 | 可选固定SVG资产栅格化；不替代HTML复杂中文排版 |
| Penpot | MPL-2.0 | 可选人工校准模板/导出SVG工具，不作为运行时依赖，不部署服务 |

不作为核心：

- `abi/screenshot-to-code`（MIT）：可参考截图解析与生成流程，但模型生成代码没有天然的几何、字体与资产精确保证，还可能引入复杂/不稳定样式。适合辅助草稿，不适合作为复刻验收闭环。
- Satori（MPL-2.0）：有价值，但不等同完整浏览器CSS；现有项目已经使用Chromium，首期切换引擎会增加中文字形和度量回归。
- RapidOCR（Apache-2.0）：可作ONNX部署备选，但转换权重必须逐文件核对来源、哈希和许可；其README所指模型许可清单在本次调研中不可用，不据仓库许可推断所有权重都已清。
- OpenCV.js（OpenCV 4.x为Apache-2.0）：复杂透视/轮廓任务再引入；本批干净图文卡片先用sharp，不增加首期包体与运行成本。
- 无LICENSE或NOASSERTION项目：只参考思路，不复制源码。此前两个模板/风格参考项目仍受此限制。

代码许可、模型权重许可、字体许可、账号图片/品牌资产使用权分别记录，不能相互替代。

## 7. 落地顺序

### 阶段A：一套模板先实现真正闭环

以339为第一个模板族：建立原图golden、Logo/品牌组件、封面固定服务文案、页眉页脚保留区、精确区域树、动态字体候选与原文回放。绕过通用主题，先证明一套模板可精确重建。

退出条件：原文回放通过独立硬约束；新文案至少覆盖长标题、满容量列表、两栏和多页编号测试；未确认字体/资产不能隐藏。

### 阶段B：加入第二个真实模板族

用340验证栏目式编号、照片布局、双栏比较和行式列表。建立DocumentPlan与按区域分栏，证明系统不是把339参数换到340上。

退出条件：两个family互不污染，编号、背景、图像槽位与封面底部组件不互相套用；留出原图可验证。

### 阶段C：扩展到账号全语料

按图片哈希与提取器版本增量分析全部本地页面，分批调用OCR/视觉，不重新抓取。建立视觉覆盖率、unknown队列、校准工作台、模板版本与回归测试。

退出条件：报告可解释每一页属于哪个模板族、证据在哪、是否可生产；未知页面不虚报完成。

### 阶段D：生产生成接入

在pipeline内选择verified family，生成受约束新文案、测量fit、隔离渲染与验收。失败显示明确阶段与差分，保留历史通过版本。生成候选与真实发布完全分离，不因视觉通过自动发布。

## 8. 建议模块边界

以下是设计位置，不表示文件已创建：

```text
server/src/visual/evidence/      # manifest, OCR, geometry, vision, evidence IR
server/src/visual/templates/     # brand kit, family schemas, registry, versions
server/src/visual/planner/       # document plan, typed slots, content fit
server/src/visual/render/        # deterministic HTML components, isolated renderer
server/src/visual/verify/        # golden, geometry, OCR, assets, diff, gates
server/src/diagnostics/visual/   # replay, holdout validation, reports
```

现有 `analyze.ts` 保存文本蒸馏与视觉证据引用；`profile.ts` 聚合文案风格与family索引，不再压扁视觉布局；`pipeline.ts` 调用planner/render/verify；通用cards/themes保持独立fallback模式。新schema必须测试序列化、coerce/resolve往返不丢数据，生产默认模板与普通主题不互相覆盖。

## 9. 官方参考来源

- PaddleOCR：[仓库与用法](https://github.com/PaddlePaddle/PaddleOCR)、[Apache-2.0 LICENSE](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)。
- PP-OCRv5指定官方权重：[server_det模型卡](https://huggingface.co/PaddlePaddle/PP-OCRv5_server_det/blob/main/README.md)、[server_rec模型卡](https://huggingface.co/PaddlePaddle/PP-OCRv5_server_rec/blob/main/README.md)。各自声明Apache-2.0，不扩展推断其他模型或转换文件。
- sharp：[仓库](https://github.com/lovell/sharp)、[LICENSE](https://github.com/lovell/sharp/blob/main/LICENSE)。底层libvips：[许可说明](https://github.com/libvips/libvips/blob/master/README.md)、[LICENSE正文](https://github.com/libvips/libvips/blob/master/LICENSE)。
- Playwright：[仓库](https://github.com/microsoft/playwright)。
- pixelmatch：[仓库](https://github.com/mapbox/pixelmatch)、[ISC LICENSE](https://github.com/mapbox/pixelmatch/blob/main/LICENSE)。
- ssim.js：[仓库](https://github.com/obartra/ssim)。
- resvg-js：[仓库](https://github.com/yisibl/resvg-js)。
- Penpot：[仓库](https://github.com/penpot/penpot)。
- 截图转代码参考：[仓库](https://github.com/abi/screenshot-to-code)、[MIT LICENSE](https://github.com/abi/screenshot-to-code/blob/main/LICENSE)。

### 工具推荐

- 阶段：源模板建立与设计校准。
- 使用：版本化模板数据与证据作为机器可执行真源；需要可视化手工校准时，可选Penpot导入/导出资产与几何，不启动服务。
- 不使用：Storybook作为原图模板真源；它只能展示实现组件和状态，不能代替源图证据。
- 许可：Penpot为MPL-2.0，允许商业使用，修改并分发其覆盖文件时需遵守文件级义务。
- 第一步：为339建立一份带原图证据的模板族及离线原文回放，而不是先搭设计平台。
- 限制：Penpot不能从压缩图片自动恢复原字体与完整设计约束；仍需上述提取和校准。
