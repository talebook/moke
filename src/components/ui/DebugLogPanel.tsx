'use client';

import { useState } from 'react';
import { useDebugLogStore, type DebugLogLevel } from '@/lib/debug-log';
import { useDeveloperStore } from '@/lib/store/developer';

const levelColor: Record<DebugLogLevel, string> = {
  info: '#3b82f6',
  success: '#22c55e',
  warn: '#f59e0b',
  error: '#ef4444',
};

const levelLabel: Record<DebugLogLevel, string> = {
  info: 'INFO',
  success: 'OK',
  warn: 'WARN',
  error: 'ERR',
};

export function DebugLogPanel() {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const logs = useDebugLogStore((s) => s.logs);
  const clear = useDebugLogStore((s) => s.clear);
  const showDebugPanel = useDeveloperStore((s) => s.showDebugPanel);

  const errorCount = logs.filter((l) => l.level === 'error').length;

  const copyAll = async () => {
    const text = logs
      .map((l) => `[${l.time}] ${levelLabel[l.level]} [${l.tag}] ${l.message}${l.detail ? '\n' + l.detail : ''}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 某些环境无剪贴板权限：退而把日志放进一个可选中的 prompt
      window.prompt('复制下面的日志：', text);
    }
  };

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
          border: 'none',
          background: errorCount > 0 ? '#ef4444' : '#1f2937',
          color: '#fff',
          fontSize: 18,
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}
        aria-label="调试日志"
      >
        🐞
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
              background: '#fff',
              color: '#ef4444',
              fontSize: 11,
              fontWeight: 700,
              lineHeight: '18px',
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
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#0f172a',
              color: '#e2e8f0',
              maxHeight: '75vh',
              display: 'flex',
              flexDirection: 'column',
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
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
                borderBottom: '1px solid #1e293b',
              }}
            >
              <strong style={{ fontSize: 14 }}>调试日志</strong>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>({logs.length} 条)</span>
              <div style={{ flex: 1 }} />
              <button onClick={copyAll} style={btnStyle}>复制全部</button>
              <button onClick={clear} style={btnStyle}>清空</button>
              <button onClick={() => setOpen(false)} style={btnStyle}>关闭</button>
            </div>

            {/* 日志列表 */}
            <div style={{ overflowY: 'auto', padding: '8px 12px', flex: 1 }}>
              {logs.length === 0 && (
                <div style={{ color: '#64748b', fontSize: 13, padding: 16, textAlign: 'center' }}>
                  暂无日志，操作后这里会显示请求记录
                </div>
              )}
              {logs.map((log) => (
                <div
                  key={log.id}
                  onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                  style={{
                    padding: '6px 8px',
                    borderBottom: '1px solid #1e293b',
                    cursor: log.detail ? 'pointer' : 'default',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ color: '#64748b', flexShrink: 0 }}>{log.time}</span>
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
                    <span style={{ wordBreak: 'break-all' }}>{log.message}</span>
                  </div>
                  {log.detail && expandedId === log.id && (
                    <pre
                      style={{
                        margin: '4px 0 0 42px',
                        padding: 8,
                        background: '#1e293b',
                        borderRadius: 6,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        fontSize: 11,
                        color: '#cbd5e1',
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
  borderRadius: 6,
  border: '1px solid #334155',
  background: '#1e293b',
  color: '#e2e8f0',
  cursor: 'pointer',
};
