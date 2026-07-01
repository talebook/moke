'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Bug, FlaskConical, Lock, Trash2, AlertTriangle, Eye } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { useDeveloperStore } from '@/lib/store/developer';
import { useDebugLogStore, debugLog } from '@/lib/debug-log';

export default function DeveloperSettingsPage() {
  const router = useRouter();
  const unlocked = useDeveloperStore((s) => s.unlocked);
  const enabled = useDeveloperStore((s) => s.enabled);
  const setEnabled = useDeveloperStore((s) => s.setEnabled);
  const showDebugPanel = useDeveloperStore((s) => s.showDebugPanel);
  const setShowDebugPanel = useDeveloperStore((s) => s.setShowDebugPanel);
  const lock = useDeveloperStore((s) => s.lock);
  const clearLogs = useDebugLogStore((s) => s.clear);
  const logCount = useDebugLogStore((s) => s.logs.length);
  const [crashArmed, setCrashArmed] = useState(false);

  // 未解锁时不允许访问该页面
  if (!unlocked) {
    return (
      <DesktopLayout>
        <div className="px-8 py-8 flex flex-col items-center justify-center text-center" style={{ minHeight: '60vh' }}>
          <Lock className="w-10 h-10 text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground">开发者选项尚未解锁。</p>
          <button
            onClick={() => router.push('/settings')}
            className="mt-4 text-sm text-primary hover:underline"
          >
            返回设置
          </button>
        </div>
      </DesktopLayout>
    );
  }

  const triggerJsCrash = () => {
    debugLog('error', 'devtools', '手动触发 JS 崩溃测试');
    // 抛出未捕获异常用于测试错误边界 / 上报
    setTimeout(() => {
      throw new Error('[崩溃测试] 这是一个手动触发的测试异常');
    }, 0);
  };

  const triggerRenderCrash = () => {
    debugLog('error', 'devtools', '手动触发渲染崩溃测试');
    setCrashArmed(true);
  };

  const handleLock = () => {
    lock();
    router.push('/settings');
  };

  if (crashArmed) {
    // 在渲染期间抛出，触发 React 错误边界
    throw new Error('[崩溃测试] 渲染期间手动抛出的测试异常');
  }

  return (
    <DesktopLayout>
      <div className="px-8 py-8 flex-1 overflow-y-auto" style={{ maxWidth: '860px' }}>
        <button
          onClick={() => router.push('/settings')}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          返回设置
        </button>

        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-foreground">开发者选项</h1>
          <p className="text-sm text-muted-foreground mt-1">调试、诊断与测试工具，请谨慎使用</p>
        </div>

        <div className="space-y-8">
          <DevSection title="开发者选项显示" description="控制设置界面中「开发者选项」入口的显示与隐藏（不影响已解锁状态）">
            <ToggleRow
              icon={Eye}
              label="启用开发者"
              description={enabled ? '设置界面中将显示「开发者选项」入口' : '设置界面中将隐藏「开发者选项」入口，可在「关于」页连点版本号重新显示'}
              checked={enabled}
              onChange={(v) => {
                setEnabled(v);
                debugLog('info', 'devtools', `开发者选项显示已${v ? '启用' : '禁用'}`);
              }}
            />
          </DevSection>

          <DevSection title="调试面板" description="控制屏幕上的调试日志面板入口">
            <ToggleRow
              icon={Bug}
              label="显示调试面板按钮"
              description={`在所有页面右下角显示 🐞 浮动按钮，可查看实时日志（当前 ${logCount} 条）`}
              checked={showDebugPanel}
              onChange={setShowDebugPanel}
            />
            <ActionRow
              icon={Trash2}
              label="清空调试日志"
              description="移除当前缓存的全部日志记录"
              onClick={() => {
                clearLogs();
                debugLog('info', 'devtools', '日志已清空');
              }}
            />
          </DevSection>

          <DevSection title="崩溃测试" description="主动触发异常，用于验证崩溃捕获与上报">
            <ActionRow
              icon={FlaskConical}
              label="触发异步崩溃 (JS)"
              description="在事件循环中抛出未捕获异常"
              tone="danger"
              onClick={triggerJsCrash}
            />
            <ActionRow
              icon={AlertTriangle}
              label="触发渲染崩溃 (React)"
              description="在组件渲染期间抛出异常，触发错误边界"
              tone="danger"
              onClick={triggerRenderCrash}
            />
          </DevSection>

          <DevSection title="开发者模式" description="关闭后需重新在「关于」页连点版本号解锁">
            <ActionRow
              icon={Lock}
              label="退出开发者模式"
              description="锁定开发者选项并隐藏调试面板"
              tone="danger"
              onClick={handleLock}
            />
          </DevSection>
        </div>
      </div>
    </DesktopLayout>
  );
}

function DevSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="px-1">
        <h2 className="text-sm font-semibold text-foreground tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="divide-y divide-amber-950/10 rounded-[28px] app-glass p-1">{children}</div>
    </section>
  );
}

function ToggleRow({ icon: Icon, label, description, checked, onChange }: { icon: typeof Bug; label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl transition-colors hover:bg-muted/60">
      <div className="flex items-start gap-3.5 min-w-0">
        <div className="p-2 rounded-lg bg-white/60 border border-amber-950/10 text-muted-foreground shrink-0">
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 py-0.5">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

function ActionRow({ icon: Icon, label, description, tone = 'default', onClick }: { icon: typeof Bug; label: string; description: string; tone?: 'default' | 'danger'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-xl text-left transition-all duration-200 active:scale-[0.99] group ${tone === 'danger' ? 'hover:bg-destructive/5' : 'hover:bg-muted/80'}`}
    >
      <div className={`p-2 rounded-lg bg-white/60 border border-amber-950/10 shrink-0 transition-colors duration-200 ${tone === 'danger' ? 'group-hover:border-destructive/20' : ''}`}>
        <Icon className={`w-4 h-4 ${tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'}`} />
      </div>
      <div className="min-w-0 py-0.5">
        <p className={`text-sm font-medium ${tone === 'danger' ? 'text-destructive' : 'text-foreground'}`}>{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
      </div>
    </button>
  );
}
