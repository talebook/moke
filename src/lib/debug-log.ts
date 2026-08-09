import { create } from 'zustand';

export type DebugLogLevel = 'info' | 'success' | 'warn' | 'error';
export type DebugLogType = 'console' | 'network';

export interface DebugLogEntry {
  id: number;
  time: string;
  level: DebugLogLevel;
  /** 日志类别：console 捕获 / 网络请求 */
  type: DebugLogType;
  tag: string;
  message: string;
  detail?: string;
}

interface DebugLogState {
  logs: DebugLogEntry[];
  enabled: boolean;
  addLog: (level: DebugLogLevel, tag: string, message: string, detail?: unknown, type?: DebugLogType) => void;
  clear: () => void;
  setEnabled: (enabled: boolean) => void;
}

let counter = 0;
/** 每个类别（console / network）各自保留的日志条数上限 */
const MAX_LOGS_PER_TYPE = 1000;

/** 按 tag 推断日志类别：request/image 属于网络请求日志，其余归入 console */
function inferLogType(tag: string): DebugLogType {
  return tag === 'request' || tag === 'image' ? 'network' : 'console';
}

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
  addLog: (level, tag, message, detail, type) => {
    const entry: DebugLogEntry = {
      id: ++counter,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0'),
      level,
      type: type ?? inferLogType(tag),
      tag,
      message,
      detail: stringifyDetail(detail),
    };
    set((state) => {
      const next = [...state.logs, entry];
      // 按类别分别保留最近 MAX_LOGS_PER_TYPE 条，避免某类日志挤掉另一类
      for (const t of ['console', 'network'] as DebugLogType[]) {
        let excess = next.filter((l) => l.type === t).length - MAX_LOGS_PER_TYPE;
        let i = 0;
        while (excess > 0 && i < next.length) {
          if (next[i].type === t) {
            next.splice(i, 1);
            excess--;
          } else {
            i++;
          }
        }
      }
      return { logs: next };
    });
  },
  clear: () => set({ logs: [] }),
  setEnabled: (enabled) => set({ enabled }),
}));

/**
 * 原生 console 引用。debugLog 与 console 捕获器都经由它们输出，
 * 避免捕获器在 patch 之后又触发自身（无限递归 / 重复记录）。
 */
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/** 在任意非 React 上下文（如 api.ts）中记录日志 */
export function debugLog(level: DebugLogLevel, tag: string, message: string, detail?: unknown, type?: DebugLogType) {
  try {
    useDebugLogStore.getState().addLog(level, tag, message, detail, type);
  } catch {
    // store 尚未初始化时静默忽略
  }
  // 同时输出到控制台（走原始引用，避免被下方 console 捕获器再次记录）
  const line = `[${tag}] ${message}`;
  if (level === 'error') originalConsole.error(line, detail ?? '');
  else if (level === 'warn') originalConsole.warn(line, detail ?? '');
  else originalConsole.log(line, detail ?? '');
}

/** 把任意 console 参数格式化为面板可读的文本 */
function formatConsoleArg(arg: unknown): string {
  if (arg instanceof Error) {
    const name = arg.name || 'Error';
    const msg = arg.message || '';
    const stack = arg.stack ? `\n${arg.stack}` : '';
    return `${name}: ${msg}${stack}`;
  }
  if (typeof arg === 'string') return arg;
  try {
    const s = JSON.stringify(arg, null, 2);
    return s === undefined ? String(arg) : s;
  } catch {
    return String(arg);
  }
}

function formatConsoleArgs(args: unknown[]): { message: string; detail?: string } {
  const lines: string[] = [];
  const details: string[] = [];
  for (const arg of args) {
    const text = formatConsoleArg(arg);
    if (text.includes('\n')) {
      const [first, ...rest] = text.split('\n');
      lines.push(first);
      details.push(rest.join('\n'));
    } else {
      lines.push(text);
    }
  }
  const message = lines.join(' ');
  return { message, detail: details.length > 0 ? details.join('\n') : undefined };
}

let consoleCaptureInstalled = false;

/**
 * 捕获全局 console 调用并写入调试日志 store。
 * 这样任何直接调用 console.error / warn / log 的代码（第三方库、
 * 未接入 debugLog 的路径、浏览器内部的 unhandledrejection 打印等）
 * 都会出现在调试面板中。应在应用启动时调用一次。
 *
 * 注意：这会全局 patch console，并为每类日志缓存最多 1000 条，仅在
 * 开发环境或已解锁开发者模式的用户上启用（见 app/layout.tsx 的门控）。
 */
export function installConsoleCapture() {
  // SSR 下 window 不存在，跳过；服务端日志不应进入客户端面板
  if (consoleCaptureInstalled || typeof window === 'undefined') return;
  consoleCaptureInstalled = true;

  const capture = (
    level: DebugLogLevel,
    native: (...args: unknown[]) => void,
    args: unknown[]
  ) => {
    // 先保持原生控制台输出
    native(...args);
    const { message, detail } = formatConsoleArgs(args);
    try {
      useDebugLogStore.getState().addLog(level, 'console', message, detail, 'console');
    } catch {
      // store 尚未初始化时静默忽略
    }
  };

  console.log = (...args) => capture('info', originalConsole.log, args);
  console.info = (...args) => capture('info', originalConsole.info, args);
  console.debug = (...args) => capture('info', originalConsole.debug, args);
  console.warn = (...args) => capture('warn', originalConsole.warn, args);
  console.error = (...args) => capture('error', originalConsole.error, args);
}

/**
 * 撤销 installConsoleCapture 的 patch，恢复原生 console 方法。
 * 用于生产环境用户在未解锁开发者模式时（或锁定后）关闭全局捕获。
 */
export function uninstallConsoleCapture() {
  if (!consoleCaptureInstalled || typeof window === 'undefined') return;
  consoleCaptureInstalled = false;
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
}
