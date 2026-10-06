'use client';

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

type StartupRequests = (id: symbol, message: string | null) => void;
const StartupContext = createContext<StartupRequests | null>(null);

function ProgressScreen({ message }: { message: string }) {
  const [text, setText] = useState({ current: message, previous: '', revision: 0 });
  if (text.current !== message) {
    setText({ current: message, previous: text.current, revision: text.revision + 1 });
  }
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="app-startup-screen"
      data-progress-message={message}
      className="fixed inset-0 z-[180] flex flex-col items-center justify-center gap-3 app-warm-bg px-4 text-center"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" aria-hidden="true" />
      <span className="sr-only">{message}</span>
      <div key={text.revision} className="moke-progress-text text-sm text-muted-foreground" aria-hidden="true">
        {text.previous && <span className="moke-progress-text-old">{text.previous}</span>}
        <span className={text.previous ? 'moke-progress-text-new' : ''}>{text.current}</span>
      </div>
    </div>
  );
}

/** Keep one animated screen mounted when privacy/Preview/launch gates hand off. */
export function AppStartupProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const requests = useRef(new Map<symbol, string>());
  const [message, setMessage] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const register = useCallback<StartupRequests>((id, value) => {
    requests.current.delete(id);
    if (value !== null) requests.current.set(id, value);
    setMessage(Array.from(requests.current.values()).at(-1) ?? null);
  }, []);
  useEffect(() => setMounted(true), []);
  const visibleMessage = message ?? (!mounted && pathname !== '/privacy'
    ? pathname === '/detail' ? '正在加载书籍详情…' : '正在打开墨客…'
    : null);
  return (
    <StartupContext.Provider value={register}>
      {children}
      {visibleMessage && <ProgressScreen message={visibleMessage} />}
    </StartupContext.Provider>
  );
}

/** A gate registers its actual stage; the shared screen survives gate changes. */
export function AppStartupScreen({ message = '正在打开墨客…' }: { message?: string }) {
  const register = useContext(StartupContext);
  const [id] = useState(() => Symbol('startup'));
  useLayoutEffect(() => {
    register?.(id, message);
    return () => register?.(id, null);
  }, [id, message, register]);
  return register ? null : <ProgressScreen message={message} />;
}
