import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface DeveloperState {
  /** 开发者模式是否已解锁（点击版本号 8 次后永久解锁） */
  unlocked: boolean;
  /**
   * 设置界面是否「显示」开发者选项入口。
   * 解锁后默认显示，用户可在开发者选项里关闭以隐藏入口（仅隐藏，不影响已解锁状态）。
   */
  enabled: boolean;
  /** 是否显示调试日志面板的浮动按钮 */
  showDebugPanel: boolean;
  /** 当前点击版本号的连击计数（不持久化，仅运行时使用） */
  versionTapCount: number;
  unlock: () => void;
  lock: () => void;
  /** 设置开发者选项在设置界面的显示/隐藏 */
  setEnabled: (enabled: boolean) => void;
  setShowDebugPanel: (show: boolean) => void;
  /** 记录一次版本号点击，返回是否刚好触发解锁 */
  tapVersion: () => boolean;
  resetTap: () => void;
}

const UNLOCK_THRESHOLD = 8;

export const useDeveloperStore = create<DeveloperState>()(
  persist(
    (set, get) => ({
      unlocked: false,
      enabled: true,
      showDebugPanel: false,
      versionTapCount: 0,
      unlock: () => set({ unlocked: true, enabled: true }),
      lock: () => set({ unlocked: false, enabled: true, showDebugPanel: false, versionTapCount: 0 }),
      setEnabled: (enabled) => set({ enabled }),
      setShowDebugPanel: (showDebugPanel) => set({ showDebugPanel }),
      tapVersion: () => {
        if (get().unlocked) return false;
        const next = get().versionTapCount + 1;
        if (next >= UNLOCK_THRESHOLD) {
          set({ unlocked: true, enabled: true, versionTapCount: 0 });
          return true;
        }
        set({ versionTapCount: next });
        return false;
      },
      resetTap: () => set({ versionTapCount: 0 }),
    }),
    {
      name: 'moke-developer-storage',
      // 只持久化解锁状态、显示开关与面板开关，连击计数无需持久化
      partialize: (state) => ({
        unlocked: state.unlocked,
        enabled: state.enabled,
        showDebugPanel: state.showDebugPanel,
      }),
    }
  )
);

export { UNLOCK_THRESHOLD };
