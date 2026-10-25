import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface DeveloperState {
  /** 开发者模式是否已解锁（关于页版本号连点 8 次；解锁状态持久化） */
  unlocked: boolean;
  /**
   * 设置界面是否「显示」开发者选项入口。
   * 解锁后默认显示，用户可在开发者选项里关闭以隐藏入口（仅隐藏，不影响已解锁状态）。
   */
  enabled: boolean;
  /** 是否显示调试日志面板的浮动按钮 */
  showDebugPanel: boolean;
  /** 当前日志面板是否展开，仅在本次运行中保留。 */
  debugPanelOpen: boolean;
  /** 关于页版本号连击计数；欢迎页独立计数，只切换调试浮钮（均不持久化）。 */
  versionTapCount: number;
  unlock: () => void;
  lock: () => void;
  /** 设置开发者选项在设置界面的显示/隐藏 */
  setEnabled: (enabled: boolean) => void;
  setShowDebugPanel: (show: boolean) => void;
  setDebugPanelOpen: (open: boolean) => void;
  /** 记录一次关于页版本号点击，返回是否刚好触发解锁。 */
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
      debugPanelOpen: false,
      versionTapCount: 0,
      unlock: () => set({ unlocked: true, enabled: true }),
      lock: () => set({ unlocked: false, enabled: true, showDebugPanel: false, debugPanelOpen: false, versionTapCount: 0 }),
      setEnabled: (enabled) => set({ enabled }),
      setShowDebugPanel: (showDebugPanel) => set({ showDebugPanel, ...(!showDebugPanel ? { debugPanelOpen: false } : {}) }),
      setDebugPanelOpen: (debugPanelOpen) => set({ debugPanelOpen }),
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
      // 只持久化三个偏好；连击计数和面板展开状态仅属于当前运行。
      partialize: (state) => ({
        unlocked: state.unlocked,
        enabled: state.enabled,
        showDebugPanel: state.showDebugPanel,
      }),
    }
  )
);

/**
 * Resolve the value carried into a new embedded-reader document.
 *
 * Android replaces the current WebView document. A click can happen while the
 * persisted Zustand store is still hydrating, so also consult the durable
 * value instead of allowing a transient in-memory false to hide the panel.
 */
export function getDebugPanelLaunchState(
  storage?: Pick<Storage, 'getItem'>,
): boolean {
  if (useDeveloperStore.getState().showDebugPanel) return true;
  const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!target) return false;
  try {
    const value: unknown = JSON.parse(target.getItem('moke-developer-storage') || '{}');
    const state = value && typeof value === 'object' ? (value as { state?: unknown }).state : null;
    return !!(
      state &&
      typeof state === 'object' &&
      (state as { showDebugPanel?: unknown }).showDebugPanel === true
    );
  } catch {
    return false;
  }
}

export { UNLOCK_THRESHOLD };
