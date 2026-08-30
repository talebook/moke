/**
 * 赞助名单数据（「关于」页「赞助名单」区域）。
 *
 * 后续新增赞助者时，只需在数组末尾追加一项，无需改动页面模板：
 *
 * ```ts
 * { id: 'zhangsan', name: '张三', amount: '¥50' },
 * ```
 *
 * - `id`：唯一标识，用于 React key，不可重复；
 * - `name`：展示名称（可包含称谓，如「金海先生」）；
 * - `amount`：赞助金额，直接使用展示原文（如「¥20」）。
 *
 * 建议按赞助时间先后排列。
 */
export interface Sponsor {
  id: string;
  name: string;
  amount: string;
}

export const sponsors: Sponsor[] = [
  { id: 'jinhai', name: '金海先生', amount: '¥20' },
  { id: 'qiancheng', name: '千成', amount: '¥10' },
];
