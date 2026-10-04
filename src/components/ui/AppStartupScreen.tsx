/** Keep startup gates and automatic reading handoffs visually continuous. */
export function AppStartupScreen() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="app-startup-screen"
      className="fixed inset-0 z-[180] flex flex-col items-center justify-center gap-3 app-warm-bg px-4 text-center"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">正在打开 Moke…</p>
    </div>
  );
}
