# TableMind UI 设计评审与优化方案

> 评审范围：`frontend/src` 全部页面与共享组件（用户端 7 页 + 管理端 7 页 + shared）
> 评审日期：2026-10-05 · 评审人：UI Designer（像素君）

---

## 一、总体评价

现有 UI 已经具备不错的基础：Taptap 风格定位清晰，主色 `#15bffd` + 评分橙 `#ff8200` 的语义分工明确，卡片化语言统一，移动端有独立首页、底部 TabBar、safe-area 适配和 scroll-snap 等细节，完成度明显高于一般 Demo。

但作为要承载「桌游库 + 社区 + AI 助手」的产品，当前实现存在 **5 项可访问性阻断问题、4 项设计系统一致性缺陷、6 项布局/交互缺陷、4 项状态与品牌打磨项**，共 19 项。以下按优先级展开。

---

## 二、P0 可访问性（WCAG AA 未达标，须优先修复）

### 2.1 主按钮文字对比度严重不足 ⚠️ 最严重

| 组合 | 实测对比度 | WCAG AA 要求 | 结论 |
|---|---|---|---|
| 白字 on `#15bffd`（注册/想玩/发送按钮） | **≈ 2.1 : 1** | 正文 4.5:1，大字 3:1 | ❌ 两项均不达标 |
| 白字 on `#ff8200`（评分徽章） | ≈ 2.5 : 1 | 同上 | ❌ 不达标 |
| `#999` on `#fff`（辅助文字，全局大量使用） | ≈ 2.9 : 1 | 4.5:1 | ❌ 不达标 |
| `#aaa` on `#fff`（日期、说明文字） | ≈ 2.3 : 1 | 4.5:1 | ❌ 不达标 |

`#15bffd` 是高明度青色，本身不适合承载白色文字。涉及文件：`theme.ts`、`UserLayout.tsx`（注册按钮）、`GameDetailPage.tsx`（想玩按钮、评分徽章）、`AiAssistantPage.tsx`（发送按钮）、`GameCard.tsx`（评分徽章）等。

**优化方案：双主色策略** —— 保留 `#15bffd` 作为品牌/装饰色（图标、渐变、大面积背景），新增**文字安全主色**用于按钮与链接：

```ts
// theme.ts
token: {
  colorPrimary: '#0e9fd8',      // 交互主色（加深，白字 ≈ 3.9:1，大号按钮/粗体达标）
  colorLink: '#0b87bd',         // 链接色（白底上 ≈ 4.6:1）
  colorTextSecondary: '#6b7280',// 替代 #999（≈ 4.8:1）✅
}
// 评分徽章加深：#ff8200 → #e06d00（白字 ≈ 3.2:1，粗体大字达标）
// 若需 4.5:1 全量达标：按钮主色进一步加深至 #0672ad（≈ 5.2:1）
export const RATING_ORANGE = '#e06d00';
```

> 建议用 WebAIM Contrast Checker 对最终色值逐一复核。

### 2.2 原生 `<button>` 无焦点样式，键盘不可用

`UserLayout.tsx` 导航按钮、`GameListPage.tsx` 筛选 chips、`MobileTabBar.tsx` 五个 Tab、`MobileHome.tsx` 搜索/下载按钮均为原生 button，全局没有任何 `:focus-visible` 样式 —— 键盘 Tab 导航完全不可见。

```css
/* 建议加入全局样式 index.css */
button:focus-visible, a:focus-visible, [role="button"]:focus-visible {
  outline: 2px solid #0b87bd;
  outline-offset: 2px;
  border-radius: inherit;
}
```

### 2.3 图标按钮缺少可访问名称

`MobileHome.tsx` 搜索圆形按钮、`AdminLayout.tsx` 退出登录 icon-only 按钮（有 `title` 但不够）、`MobileTabBar.tsx` 各 Tab —— 需补 `aria-label`，TabBar 当前项补 `aria-current="page"`。

### 2.4 可点击卡片不是语义化元素

`GameCard`、首页榜单行、评测卡均为 `<div onClick>`：无法键盘聚焦、屏幕阅读器不识别为链接。建议改为 `<a>`/`<Link>` 包裹，或至少加 `role="link" tabIndex={0}` + Enter 键处理。

### 2.5 生成色封面文字对比度不可控

`GameCard.coverStyle` 按 id 取 8 个色相，`hsl(x 80% 55%)` 配白字，部分色相（如黄绿 150°、橙黄 42°）对比度不足 3:1。占位期可降低明度到 45% 并统一加深文字阴影；**长期方案是尽快接入真实封面图**（占位首字仅作 fallback 且需 `aria-hidden`，游戏名已由下方标题提供）。

---

## 三、P1 设计系统一致性

### 3.1 颜色硬编码散落 20+ 处

`#15bffd`、`#e8f8ff`、`#f5f6f7`、`#ff8200` 以字符串字面量散布在所有页面。改一次主色需要全局搜索替换，且 `MobileHome.tsx` 与 `GameCard.tsx` 的封面渐变色相数组已经不一致（8 色 vs 12 色）。

**方案：三层令牌架构**

```
L1 原始令牌  src/shared/tokens.css     → CSS 变量：--tm-blue-500、--tm-space-4…
L2 语义令牌  同文件                     → --color-action、--color-rating、--surface-card…
L3 组件样式  *.module.css              → 消费语义变量，写 hover/focus/media query
```

```css
/* tokens.css 节选 */
:root {
  --tm-blue-500: #15bffd;   /* 品牌装饰 */
  --tm-blue-600: #0e9fd8;   /* 交互主色 */
  --tm-blue-700: #0b87bd;   /* 文字/链接 */
  --tm-orange-600: #e06d00; /* 评分 */
  --text-primary: #1c1c1c;
  --text-secondary: #6b7280;
  --text-tertiary: #9ca3af; /* 仅用于非关键装饰文字 */
  --surface-page: #f5f6f7;
  --surface-card: #ffffff;
  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px; --radius-pill: 999px;
  --shadow-card: 0 2px 8px rgba(0,0,0,.05);
  --shadow-card-hover: 0 8px 24px rgba(0,0,0,.12);
  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
}
```

### 3.2 内联样式 + `onMouseEnter` 直接改 style

`GameCard.tsx`、`HomePage.tsx` 多处用 JS 事件切换 hover 样式。该方式**无法表达** `:focus`、`:active`、媒体查询和暗色模式，且每次渲染重建大量 style 对象。迁移到 CSS Modules 后：

```css
/* GameCard.module.css */
.card { transition: box-shadow .25s ease, transform .25s ease; }
.card:hover { box-shadow: var(--shadow-card-hover); transform: translateY(-3px); }
.card:focus-visible { outline: 2px solid var(--tm-blue-700); outline-offset: 2px; }
```

### 3.3 字号 / 圆角刻度混乱

代码中出现 11、12、12.5、13、13.5、14、15、15.5、17、19、21、22 等十余种字号，圆角 7~22px 共 10 种。建议收敛：

- **字号刻度**：12 / 13 / 14 / 16 / 18 / 22 / 28（7 级）
- **圆角刻度**：8（小元素）/ 12（卡片）/ 16（大卡片、横幅）/ pill（按钮、chips）
- 评分徽章 12.5px → 12px 粗体即可

### 3.4 重复逻辑未抽取

封面渐变生成逻辑在 `GameCard.tsx` 和 `MobileHome.tsx` 各写一份且参数不同；评分徽章样式（`scoreStyle` vs 内联）三处重复。抽到 `shared/Cover.tsx` + `shared/RatingBadge.tsx`。

---

## 四、P1 布局与交互缺陷

### 4.1 桌游库网格与卡片宽度冲突（视觉 bug）

`GameListPage.tsx` 网格 `repeat(auto-fill, minmax(180px, 1fr))` 会把列宽拉伸到 >180px，但 `GameCard` 固定 `width: 180` —— 每行卡片右侧出现不均匀空隙。修复：GameCard 改 `width: 100%`（由网格控制宽度），横向滚动场景由父容器给 `flex: 0 0 180px`。

### 4.2 移动端 AI 助手页高度计算错误

`AiAssistantPage.tsx`：`height: calc(100vh - 64px)`，但移动端布局 TabBar 高 56px 且 `main` 已加 `paddingBottom: 56`，导致输入区与 TabBar 重叠或出现双滚动。建议移动端改为 `height: calc(100dvh - 56px - 48px)` 并使用 `dvh` 单位兼容移动端地址栏伸缩。

### 4.3 分页器硬编码 `total={128}`

与筛选结果完全无关，过滤到 0 条时仍显示 11 页。接入 API 前应根据 `games.length` 计算，并为空结果补空状态（见 5.1）。

### 4.4 横向滚动区无视觉提示

桌面首页「热门桌游」右侧卡片流 `overflowX: auto`，无渐变遮罩/滚动条/箭头，多数用户不知道可以横滑。建议右侧加 40px 白色渐隐遮罩（`mask-image`）或显式滚动按钮。

### 4.5 收藏三状态缺一

`DESIGN.md` 要求「想玩 / 玩过 / 拥有」三清单，详情页只有「想玩」「玩过·写评测」两个按钮，缺「拥有」。建议改为分段控件（Segmented）或下拉按钮组，并显示当前收藏状态。

### 4.6 管理端无响应式

`AdminLayout` Sider 固定 220px 不可折叠；`DashboardPage` 用 `Col span={6}` 写死四列，窄屏溢出。建议：`Col xs={12} lg={6}`，Sider 加 `breakpoint="lg" collapsible`。

---

## 五、P2 状态设计与品牌打磨

### 5.1 缺三类关键状态

- **加载态**：桌游库、详情页接 API 后需骨架屏（antd `Skeleton` / `Card` 骨架）；
- **空状态**：搜索无结果、无收藏、无评测 —— 需要插画 + 引导文案（如「换个关键词试试，或让 AI 帮你推荐」+ 跳转按钮）；
- **错误态**：接口失败、SSE 断流重连提示。

### 5.2 评分体系混用

10 分制数字与 5 星图标混排（`avg_rating / 2` 四舍五入），8.4 分显示 4 星会造成「看起来偏低」的误读。建议详情页去掉 5 星，统一为「大数字 + 评分分布条形图」（BGG 惯例），评分分布也是 DESIGN.md 承诺的功能。

### 5.3 死按钮

移动端首页「下载 App」无任何行为。无 App 可下载时应移除，或改为「添加到主屏幕」引导。

### 5.4 暗色模式（可选，令牌化后低成本）

完成三层令牌改造后，加 `[data-theme="dark"]` 变量组 + antd `theme.darkAlgorithm` 即可支持，建议排入阶段四。

---

## 六、修复路线建议

| 批次 | 内容 | 对应条目 |
|---|---|---|
| 第一批（1 天内） | tokens.css 落地、主色/辅助色加深、全局 focus-visible、aria-label 补齐 | 2.1–2.4、3.1 |
| 第二批 | GameCard 宽度修复、AI 页高度、分页 total、收藏三状态、管理端响应式 | 4.1–4.6 |
| 第三批 | 组件迁移 CSS Modules、字号圆角收敛、Cover/RatingBadge 抽取 | 3.2–3.4 |
| 第四批 | 骨架屏/空态/错误态、评分分布图、暗色模式 | 5.1–5.4 |

---

## 七、亮点（值得保留）

1. 移动/桌面双布局策略清晰，`useIsMobile` 钩子统一收口；
2. 移动端 TabBar 的 `env(safe-area-inset-bottom)`、卡片按下 `scale(.97)` 反馈是超出预期的细节；
3. 管理端与用户端共享主题但布局分离，符合 DESIGN.md 的职责边界；
4. 路由高亮推导（`/games/1 → /games`）等交互逻辑严谨。
