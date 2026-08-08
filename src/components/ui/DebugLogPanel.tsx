'use client';

import { useState } from 'react';
import { useDebugLogStore, type DebugLogLevel, type DebugLogType } from '@/lib/debug-log';
import { useDeveloperStore } from '@/lib/store/developer';

// Moke 主题色（见 tailwind.config.ts），调试面板统一走浅色暖色系
const theme = {
  bg: '#FBF9F2',
  surface: '#FFFFFF',
  card: '#F5F1EB',
  border: '#E8E3DC',
  divider: '#EDE9DF',
  text: '#2C2C2E',
  muted: '#8B8682',
  primary: '#B8956A',
  destructive: '#C0392B',
};

const levelColor: Record<DebugLogLevel, string> = {
  info: '#3B6FA0',
  success: '#7A8B5E',
  warn: '#D97706',
  error: '#C0392B',
};

const levelLabel: Record<DebugLogLevel, string> = {
  info: 'INFO',
  success: 'OK',
  warn: 'WARN',
  error: 'ERR',
};

const LEVELS: DebugLogLevel[] = ['error', 'warn', 'success', 'info'];

const TABS: { value: DebugLogType; label: string }[] = [
  { value: 'console', label: 'Console 日志' },
  { value: 'network', label: '网络请求' },
];

type LevelFilterState = Record<DebugLogLevel, boolean>;

const defaultFilter: LevelFilterState = {
  error: true,
  warn: true,
  success: true,
  info: true,
};

export function DebugLogPanel() {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<DebugLogType>('console');
  const [filters, setFilters] = useState<Record<DebugLogType, LevelFilterState>>({
    console: { ...defaultFilter },
    network: { ...defaultFilter },
  });

  const logs = useDebugLogStore((s) => s.logs);
  const clear = useDebugLogStore((s) => s.clear);
  const showDebugPanel = useDeveloperStore((s) => s.showDebugPanel);

  const errorCount = logs.filter((l) => l.level === 'error').length;
  const currentFilter = filters[activeTab];
  const visibleLogs = logs.filter((l) => l.type === activeTab && currentFilter[l.level]);
  const tabCounts: Record<DebugLogType, number> = {
    console: logs.filter((l) => l.type === 'console').length,
    network: logs.filter((l) => l.type === 'network').length,
  };

  const copyAll = async () => {
    const text = visibleLogs
      .map(
        (l) =>
          `[${l.time}] ${levelLabel[l.level]} [${l.tag}] ${l.message}${l.detail ? '\n' + l.detail : ''}`
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 某些环境无剪贴板权限：退而把日志放进一个可选中的 prompt
      window.prompt('复制下面的日志：', text);
    }
  };

  const toggleLevel = (level: DebugLogLevel) =>
    setFilters((prev) => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], [level]: !prev[activeTab][level] },
    }));

  // 仅在开发者开启「显示调试面板按钮」时渲染
  if (!showDebugPanel) {
    return null;
  }

  return (
    <>
      {/* 浮动按钮 */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          zIndex: 99999,
          width: 48,
          height: 48,
          borderRadius: 24,
          border: `1px solid ${errorCount > 0 ? theme.destructive : theme.primary}`,
          background: errorCount > 0 ? theme.destructive : theme.primary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}
        aria-label="调试日志"
      >
        <img
          src="/debug.avif"
          alt="调试日志"
          style={{ width: 20, height: 20, objectFit: 'contain' }}
        />
        {errorCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 18,
              height: 18,
              padding: '0 4px',
              borderRadius: 9,
              background: '#FFFFFF',
              border: '1px solid #F2D0CA',
              color: theme.destructive,
              fontSize: 11,
              fontWeight: 700,
              lineHeight: '16px',
              textAlign: 'center',
            }}
          >
            {errorCount}
          </span>
        )}
      </button>

      {/* 日志面板 */}
      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99998,
            background: 'rgba(74, 60, 48, 0.35)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: theme.bg,
              color: theme.text,
              maxHeight: '75vh',
              display: 'flex',
              flexDirection: 'column',
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              boxShadow: '0 -8px 24px rgba(0,0,0,0.12)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {/* 头部 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 16px',
                background: theme.card,
                borderBottom: `1px solid ${theme.border}`,
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
              }}
            >
              <strong style={{ fontSize: 14, color: theme.text }}>调试日志</strong>
              <span style={{ fontSize: 12, color: theme.muted }}>
                ({visibleLogs.length}/{logs.length})
              </span>
              <div style={{ flex: 1 }} />
              <button onClick={copyAll} style={btnStyle}>复制</button>
              <button onClick={clear} style={btnStyle}>清空</button>
              <button onClick={() => setOpen(false)} style={btnStyle}>关闭</button>
            </div>

            {/* Tab 与级别过滤（同一行，过滤在右侧） */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                padding: '10px 16px',
                borderBottom: `1px solid ${theme.border}`,
              }}
            >
              {TABS.map((t) => {
                const active = activeTab === t.value;
                return (
                  <button
                    key={t.value}
                    onClick={() => {
                      setActiveTab(t.value);
                      setExpandedId(null);
                    }}
                    style={{
                      ...btnStyle,
                      background: active ? theme.primary : theme.card,
                      color: active ? '#FFFFFF' : theme.muted,
                      fontWeight: active ? 700 : 400,
                      borderColor: active ? theme.primary : theme.border,
                    }}
                  >
                    {t.label} ({tabCounts[t.value]})
                  </button>
                );
              })}

              {/* 级别过滤复选框 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginLeft: 'auto',
                  flexWrap: 'wrap',
                }}
              >
                {LEVELS.map((level) => {
                  const checked = currentFilter[level];
                  return (
                    <label
                      key={level}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 12,
                        cursor: 'pointer',
                        color: checked ? levelColor[level] : theme.muted,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleLevel(level)}
                        style={{ accentColor: levelColor[level], cursor: 'pointer' }}
                      />
                      {levelLabel[level]}
                    </label>
                  );
                })}
              </div>
            </div>

            {/* 日志列表 */}
            <div style={{ overflowY: 'auto', padding: '8px 12px', flex: 1 }}>
              {visibleLogs.length === 0 && (
                <div style={{ color: theme.muted, fontSize: 13, padding: 16, textAlign: 'center' }}>
                  {activeTab === 'network'
                    ? '暂无网络请求日志，刷新页面或操作后这里会显示请求记录'
                    : '暂无 Console 日志，操作后这里会显示记录'}
                </div>
              )}
              {visibleLogs.map((log) => (
                <div
                  key={log.id}
                  onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                  style={{
                    padding: '6px 8px',
                    borderBottom: `1px solid ${theme.divider}`,
                    cursor: log.detail ? 'pointer' : 'default',
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: theme.text,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ color: theme.muted, flexShrink: 0 }}>{log.time}</span>
                    <span
                      style={{
                        color: levelColor[log.level],
                        fontWeight: 700,
                        flexShrink: 0,
                        minWidth: 36,
                      }}
                    >
                      {levelLabel[log.level]}
                    </span>
                    <span style={{ color: theme.muted, flexShrink: 0, fontSize: 11 }}>
                      [{log.tag}]
                    </span>
                    <span style={{ wordBreak: 'break-all' }}>{log.message}</span>
                  </div>
                  {log.detail && expandedId === log.id && (
                    <pre
                      style={{
                        margin: '4px 0 0 42px',
                        padding: 8,
                        background: theme.surface,
                        border: `1px solid ${theme.border}`,
                        borderRadius: 8,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        fontSize: 11,
                        color: theme.text,
                      }}
                    >
                      {log.detail}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: theme.card,
  color: theme.text,
  cursor: 'pointer',
};
