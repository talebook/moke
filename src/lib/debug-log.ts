import { create } from 'zustand';

export type DebugLogLevel = 'info' | 'success' | 'warn' | 'error';

export interface DebugLogEntry {
  id: number;
  time: string;
  level: DebugLogLevel;
  tag: string;
  message: string;
  detail?: string;
}

interface DebugLogState {
  logs: DebugLogEntry[];
  enabled: boolean;
  addLog: (level: DebugLogLevel, tag: string, message: string, detail?: unknown) => void;
  clear: () => void;
  setEnabled: (enabled: boolean) => void;
}

let counter = 0;
const MAX_LOGS = 200;

function stringifyDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

export const useDebugLogStore = create<DebugLogState>((set) => ({
  logs: [],
  enabled: true,
  addLog: (level, tag, message, detail) => {
    const entry: DebugLogEntry = {
      id: ++counter,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0'),
      level,
      tag,
      message,
      detail: stringifyDetail(detail),
    };
    set((state) => {
      const next = [...state.logs, entry];
      if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
      return { logs: next };
    });
  },
  clear: () => set({ logs: [] }),
  setEnabled: (enabled) => set({ enabled }),
}));

/** 在任意非 React 上下文（如 api.ts）中记录日志 */
export function debugLog(level: DebugLogLevel, tag: string, message: string, detail?: unknown) {
  try {
    useDebugLogStore.getState().addLog(level, tag, message, detail);
  } catch {
    // store 尚未初始化时静默忽略
  }
  // 同时输出到控制台，方便桌面端开发者工具查看
  const line = `[${tag}] ${message}`;
  if (level === 'error') console.error(line, detail ?? '');
  else if (level === 'warn') console.warn(line, detail ?? '');
  else console.log(line, detail ?? '');
}
