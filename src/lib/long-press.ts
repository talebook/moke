import { useEffect, useState } from 'react';
import type * as React from 'react';

export type SetTimerFn = (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
export type ClearTimerFn = (id: ReturnType<typeof setTimeout>) => void;

export const LONG_PRESS_MS = 500;

/**
 * 单个卡片/行的触摸长按状态机。
 *
 * 关键点：状态放在实例字段里（didLongPress/pressTimer），而不是渲染期闭包变量。
 * 渲染期闭包变量在长按触发菜单、setState 引起重渲染后会被新闭包替换，导致
 * 手指抬起时 click 落入新闭包、防护失效（长按后仍跳转详情 / 切换选中）。
 * 实例字段跨渲染保持，click 防护始终生效。
 */
export class LongPressController {
  /** 最近一次长按是否已触发（供随后的 click 防护读取）。 */
  didLongPress = false;
  /** 由调用方在每个渲染周期刷新，避免捕获过期的 onContextAction。 */
  onLongPress: (x: number, y: number) => void = () => {};

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private x = 0;
  private y = 0;
  private readonly setTimer: SetTimerFn;
  private readonly clearTimer: ClearTimerFn;

  constructor(
    onLongPress?: (x: number, y: number) => void,
    setTimer?: SetTimerFn,
    clearTimer?: ClearTimerFn,
  ) {
    if (onLongPress) this.onLongPress = onLongPress;
    this.setTimer = setTimer ?? ((fn, delay) => setTimeout(fn, delay));
    this.clearTimer = clearTimer ?? ((id) => clearTimeout(id));
  }

  start(x: number, y: number): void {
    this.didLongPress = false;
    this.x = x;
    this.y = y;
    this.cancel();
    this.pressTimer = this.setTimer(() => {
      this.pressTimer = null;
      this.didLongPress = true;
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(50);
      this.onLongPress(this.x, this.y);
    }, LONG_PRESS_MS);
  }

  cancel(): void {
    if (this.pressTimer !== null) {
      this.clearTimer(this.pressTimer);
      this.pressTimer = null;
    }
  }

  /** 长按触发后，随后的 click 应被吞掉；返回 true 表示本次 click 由长按产生。 */
  consumeClick(): boolean {
    if (!this.didLongPress) return false;
    this.didLongPress = false;
    return true;
  }
}

export interface LongPressHandlers {
  onContextMenu: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
  onClick: (e: React.MouseEvent) => void;
}

export interface LongPressRegistry {
  /** 为某个 bookId 生成事件处理器；跨渲染复用同一份长按状态。 */
  makeHandlers: (id: string, onContextAction: (id: string, x: number, y: number) => void) => LongPressHandlers;
}

/**
 * 统一的长按菜单 hook。按 bookId 保存 LongPressController，状态跨渲染保持，
 * 长按打开菜单引起的重渲染不会丢失 didLongPress 防护。组件卸载时清理计时器。
 */
export function useLongPressRegistry(): LongPressRegistry {
  const [states] = useState(() => new Map<string, LongPressController>());

  useEffect(() => {
    return () => {
      for (const controller of states.values()) controller.cancel();
    };
  }, [states]);

  const makeHandlers = (
    id: string,
    onContextAction: (id: string, x: number, y: number) => void,
  ): LongPressHandlers => {
    let controller = states.get(id);
    if (!controller) {
      controller = new LongPressController();
      states.set(id, controller);
    }
    // 每次渲染刷新回调，避免捕获过期闭包
    controller.onLongPress = (x, y) => onContextAction(id, x, y);

    return {
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        onContextAction(id, e.clientX, e.clientY);
      },
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        controller.start(t?.clientX ?? 0, t?.clientY ?? 0);
      },
      onTouchEnd: () => controller.cancel(),
      onTouchMove: () => controller.cancel(),
      onClick: (e: React.MouseEvent) => {
        if (controller.consumeClick()) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    };
  };

  return { makeHandlers };
}
