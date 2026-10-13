import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 轮询页面的输入框保护。
 *
 * 【要解决的两个问题】
 *
 * 1. **输入被轮询冲掉**：各页面每 8~15 秒 `load()` 一次，而 load 里无条件
 *    `setXxx(服务器值)`。用户正打字到一半，下一次轮询回来就把输入框冲回
 *    服务器旧值 —— 表现为「输入不够快就被重置」。
 *
 * 2. **点保存无效**：这是第 1 个问题的补救措施（onBlur 回归）带来的回归 ——
 *    用户点「保存」按钮时，浏览器先派发 blur（焦点离开输入框），再派发 click。
 *    于是 onBlur 先把值擦回服务器旧值，click 里读到的已经是旧值，存回去
 *    等于什么都没改。
 *
 * 【解法】
 * 把「正在编辑」当成独立状态。用户一输入就置 dirty 标记，轮询刷新**不再
 * 覆盖**这个值。失焦仍然回归服务器值，但**只在没有待保存内容时** ——
 * 一旦用户动过，就必须留着他改过的值，直到他明确保存或主动放弃。
 *
 * 为什么不干脆「轮询时不刷」：那会让后台任务进度（running 状态、队列长度、
 * 笔记数）也停掉，页面看起来像卡死。所以只保护用户正在碰的那几个字段。
 */
export function useDraftValue<T>(serverValue: T) {
  const [draft, setDraft] = useState<T>(serverValue);
  const [dirty, setDirty] = useState(false);

  /**
   * 服务器值变化时的同步。
   *
   * 只在「用户没在编辑」时生效。用 ref 记最新的 dirty，避免把 dirty 加进
   * 依赖导致每次输入都重跑这个 effect。
   *
   * 注意 serverValue 是对象时（如 Studio 的 ScheduleParts），每次渲染都是
   * 新引用，effect 每次渲染都会跑 —— 这没问题，因为 dirty 挡着；
   * 但**调用方不要**把 `serverValue` 直接当 useMemo/useEffect 的依赖。
   */
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirtyRef.current) setDraft(serverValue);
  }, [serverValue]);

  /** 用户输入：置 dirty 并更新本地值。 */
  const onChange = useCallback((v: T) => {
    setDraft(v);
    setDirty(true);
  }, []);

  /**
   * 失焦：编辑告一段落。
   *
   * ⚠️ **不能在这里无条件回归服务器值** —— 那样会吃掉「保存」：
   * 点按钮时 blur 先于 click 触发，值被擦回旧值，click 存的就是旧值。
   *
   * 这里只做一件事：清除 dirty 标记，让后续轮询恢复覆盖。
   * 用户改过的值继续留在输入框里，直到他保存（commit）或手动改回。
   */
  const onBlur = useCallback(() => {
    setDirty(false);
  }, []);

  /**
   * 提交成功后调用：清除 dirty。
   *
   * 此时服务器值已经是刚提交的那个，下一次轮询会把它同步进来，
   * 所以这里**不需要**手动 setDraft —— 反而不能 set，因为调用方
   * 可能在同一个事件循环里连续提交多个字段，抢先 setDraft 会让
   * 后面的提交读到被覆盖的值。
   */
  const commit = useCallback(() => {
    setDirty(false);
  }, []);

  /**
   * 放弃修改：显式回到服务器值。
   *
   * 给「取消编辑」这类按钮用。onBlur 不做这个（理由见上），
   * 所以放弃只能走这里，不能指望失焦。
   */
  const reset = useCallback(() => {
    setDirty(false);
    setDraft(serverValue);
  }, [serverValue]);

  return { value: draft, onChange, onBlur, commit, reset, dirty };
}
