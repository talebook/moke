import { create } from 'zustand';

export type DebugLogLevel = 'info' | 'success' | 'warn' | 'error';
export type DebugLogType = 'console' | 'network';
export type DebugLogSource = 'moke' | 'readest';

export interface DebugLogEntry {
  /** Cross-window stable id. Do not replace with an array index. */
  id: string;
  time: string;
  createdAt: number;
  level: DebugLogLevel;
  /** 日志类别：console 捕获 / 网络请求 */
  type: DebugLogType;
  /** 日志来自 Moke 宿主还是 Readest 阅读器。 */
  source: DebugLogSource;
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

interface DebugLogBridgeOptions {
  source: DebugLogSource;
  getPanelVisible?: () => boolean;
  onPanelVisible?: (visible: boolean) => void;
}

type DebugLogSyncMessage =
  | { kind: 'append'; sender: string; entry: DebugLogEntry }
  | { kind: 'clear'; sender: string; clearedAt: number }
  | { kind: 'request'; sender: string }
  | { kind: 'snapshot'; sender: string; target: string; logs: DebugLogEntry[] }
  | { kind: 'visibility-request'; sender: string }
  | { kind: 'visibility'; sender: string; visible: boolean };

const STORAGE_KEY = 'moke-debug-logs-v1';
const CLEAR_STORAGE_KEY = 'moke-debug-logs-cleared-at-v1';
const DEBUG_LOG_SYNC_EVENT = 'moke:debug-log-sync:v1';
/** 每个类别（console / network）各自保留的内存日志条数上限。 */
const MAX_LOGS_PER_TYPE = 1000;
/** 持久化数量略低于内存上限，避免 localStorage 配额被超长日志耗尽。 */
const MAX_PERSISTED_LOGS_PER_TYPE = 500;
const MAX_PERSISTED_DETAIL_LENGTH = 20_000;
const instanceId = createInstanceId();
let counter = 0;
let hydrated = false;
let bridgeSender: ((message: DebugLogSyncMessage) => void) | null = null;
let lastClearedAt = 0;

function createInstanceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to a non-cryptographic id; this is only for de-duplication.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 按 tag 推断日志类别：request/image 属于网络请求日志，其余归入 console。 */
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

function isDebugLogEntry(value: unknown): value is DebugLogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<DebugLogEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.time === 'string' &&
    typeof entry.createdAt === 'number' &&
    ['info', 'success', 'warn', 'error'].includes(String(entry.level)) &&
    ['console', 'network'].includes(String(entry.type)) &&
    ['moke', 'readest'].includes(String(entry.source)) &&
    typeof entry.tag === 'string' &&
    typeof entry.message === 'string'
  );
}

function limitLogs(logs: DebugLogEntry[], perTypeLimit: number): DebugLogEntry[] {
  const newestFirst = [...logs].sort((a, b) => b.createdAt - a.createdAt);
  const counts: Record<DebugLogType, number> = { console: 0, network: 0 };
  const kept = newestFirst.filter((entry) => {
    if (counts[entry.type] >= perTypeLimit) return false;
    counts[entry.type] += 1;
    return true;
  });
  return kept.sort((a, b) => a.createdAt - b.createdAt);
}

function mergeLogs(current: DebugLogEntry[], incoming: DebugLogEntry[]): DebugLogEntry[] {
  const byId = new Map(
    current.filter((entry) => entry.createdAt > lastClearedAt).map((entry) => [entry.id, entry]),
  );
  for (const entry of incoming) {
    if (isDebugLogEntry(entry) && entry.createdAt > lastClearedAt) byId.set(entry.id, entry);
  }
  return limitLogs([...byId.values()], MAX_LOGS_PER_TYPE);
}

function readPersistedClearTime(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const value = Number(window.localStorage.getItem(CLEAR_STORAGE_KEY) || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function readPersistedLogs(): DebugLogEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? limitLogs(parsed.filter(isDebugLogEntry), MAX_PERSISTED_LOGS_PER_TYPE) : [];
  } catch {
    return [];
  }
}

function persistLogs(logs: DebugLogEntry[], mergeExisting = true): void {
  if (typeof window === 'undefined') return;
  try {
    const combined = mergeExisting ? mergeLogs(readPersistedLogs(), logs) : logs;
    const persisted = limitLogs(combined, MAX_PERSISTED_LOGS_PER_TYPE).map((entry) => ({
      ...entry,
      detail: entry.detail?.slice(0, MAX_PERSISTED_DETAIL_LENGTH),
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Storage is best-effort (private mode / quota / custom-scheme restrictions).
  }
}

function addSyncedLogs(logs: DebugLogEntry[]): void {
  if (logs.length === 0) return;
  useDebugLogStore.setState((state) => {
    const merged = mergeLogs(state.logs, logs);
    persistLogs(merged);
    return { logs: merged };
  });
}

function clearSyncedLogs(clearedAt = Date.now()): void {
  lastClearedAt = Math.max(lastClearedAt, clearedAt);
  useDebugLogStore.setState({ logs: [] });
  try {
    window.localStorage.setItem(CLEAR_STORAGE_KEY, String(lastClearedAt));
  } catch {
    // Best effort, matching the log history persistence path.
  }
  persistLogs([], false);
}

function createEntry(
  level: DebugLogLevel,
  tag: string,
  message: string,
  detail?: unknown,
  type?: DebugLogType,
): DebugLogEntry {
  const createdAt = Math.max(Date.now(), lastClearedAt + 1);
  return {
    id: `moke:${instanceId}:${++counter}`,
    time:
      new Date(createdAt).toLocaleTimeString('zh-CN', { hour12: false }) +
      '.' +
      String(createdAt % 1000).padStart(3, '0'),
    createdAt,
    level,
    type: type ?? inferLogType(tag),
    source: 'moke',
    tag,
    message,
    detail: stringifyDetail(detail),
  };
}

export const useDebugLogStore = create<DebugLogState>((set) => ({
  logs: [],
  enabled: true,
  addLog: (level, tag, message, detail, type) => {
    const entry = createEntry(level, tag, message, detail, type);
    set((state) => {
      const logs = mergeLogs(state.logs, [entry]);
      persistLogs(logs);
      return { logs };
    });
    bridgeSender?.({ kind: 'append', sender: instanceId, entry });
  },
  clear: () => {
    const clearedAt = Date.now();
    lastClearedAt = Math.max(lastClearedAt, clearedAt);
    set({ logs: [] });
    try {
      if (typeof window === 'undefined') throw new Error('no window');
      window.localStorage.setItem(CLEAR_STORAGE_KEY, String(lastClearedAt));
    } catch {
      // Best effort, matching the log history persistence path.
    }
    persistLogs([], false);
    bridgeSender?.({ kind: 'clear', sender: instanceId, clearedAt });
  },
  setEnabled: (enabled) => set({ enabled }),
}));

export function hydrateDebugLogs(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  lastClearedAt = readPersistedClearTime();
  addSyncedLogs(readPersistedLogs());
}

/**
 * 在 Moke / Readest 的多个 WebView 之间同步日志、清空动作和面板显示状态。
 * 本地持久化负责整页导航/重载，Tauri 全局事件负责桌面多窗口互通。
 */
export async function installDebugLogBridge(options: DebugLogBridgeOptions): Promise<() => void> {
  if (typeof window === 'undefined') return () => {};
  hydrateDebugLogs();

  const handleStorage = (event: StorageEvent) => {
    if (event.key === CLEAR_STORAGE_KEY) {
      clearSyncedLogs(Number(event.newValue || 0));
      return;
    }
    if (event.key !== STORAGE_KEY) return;
    if (!event.newValue) {
      clearSyncedLogs();
      return;
    }
    try {
      const parsed: unknown = JSON.parse(event.newValue);
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) clearSyncedLogs(readPersistedClearTime());
        else addSyncedLogs(parsed.filter(isDebugLogEntry));
      }
    } catch {
      // Ignore another window's incomplete or incompatible payload.
    }
  };
  window.addEventListener('storage', handleStorage);

  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    return () => window.removeEventListener('storage', handleStorage);
  }

  try {
    const [{ emit, listen }, { getCurrentWindow }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/window'),
    ]);
    const sender = `${options.source}:${getCurrentWindow().label}:${instanceId}`;
    const send = (message: DebugLogSyncMessage) => {
      void emit(DEBUG_LOG_SYNC_EVENT, { ...message, sender }).catch(() => undefined);
    };
    bridgeSender = send;

    const unlisten = await listen<DebugLogSyncMessage>(DEBUG_LOG_SYNC_EVENT, ({ payload }) => {
      if (!payload || payload.sender === sender) return;
      switch (payload.kind) {
        case 'append':
          addSyncedLogs([payload.entry]);
          break;
        case 'clear':
          clearSyncedLogs(payload.clearedAt);
          break;
        case 'request':
          send({
            kind: 'snapshot',
            sender,
            target: payload.sender,
            logs: useDebugLogStore.getState().logs,
          });
          break;
        case 'snapshot':
          if (payload.target === sender) addSyncedLogs(payload.logs);
          break;
        case 'visibility-request': {
          const visible = options.getPanelVisible?.();
          if (typeof visible === 'boolean') send({ kind: 'visibility', sender, visible });
          break;
        }
        case 'visibility':
          options.onPanelVisible?.(payload.visible);
          break;
      }
    });

    send({ kind: 'request', sender });
    send({ kind: 'visibility-request', sender });
    const initialVisible = options.getPanelVisible?.();
    if (typeof initialVisible === 'boolean') {
      send({ kind: 'visibility', sender, visible: initialVisible });
    }

    return () => {
      unlisten();
      window.removeEventListener('storage', handleStorage);
      if (bridgeSender === send) bridgeSender = null;
    };
  } catch {
    return () => window.removeEventListener('storage', handleStorage);
  }
}

export function broadcastDebugPanelVisibility(visible: boolean): void {
  bridgeSender?.({ kind: 'visibility', sender: instanceId, visible });
}

export function requestDebugPanelVisibility(): void {
  bridgeSender?.({ kind: 'visibility-request', sender: instanceId });
}

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

/** 在任意非 React 上下文（如 api.ts）中记录日志。 */
export function debugLog(level: DebugLogLevel, tag: string, message: string, detail?: unknown, type?: DebugLogType) {
  try {
    useDebugLogStore.getState().addLog(level, tag, message, detail, type);
  } catch {
    // store 尚未初始化时静默忽略
  }
  const line = `[${tag}] ${message}`;
  if (level === 'error') originalConsole.error(line, detail ?? '');
  else if (level === 'warn') originalConsole.warn(line, detail ?? '');
  else originalConsole.log(line, detail ?? '');
}

/** 把任意 console 参数格式化为面板可读的文本。 */
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
  return { message: lines.join(' '), detail: details.length > 0 ? details.join('\n') : undefined };
}

let consoleCaptureInstalled = false;

/** 捕获全局 console 调用并写入调试日志 store。 */
export function installConsoleCapture() {
  if (consoleCaptureInstalled || typeof window === 'undefined') return;
  consoleCaptureInstalled = true;

  const capture = (
    level: DebugLogLevel,
    native: (...args: unknown[]) => void,
    args: unknown[],
  ) => {
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

/** 撤销 installConsoleCapture 的 patch，恢复原生 console 方法。 */
export function uninstallConsoleCapture() {
  if (!consoleCaptureInstalled || typeof window === 'undefined') return;
  consoleCaptureInstalled = false;
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
}
