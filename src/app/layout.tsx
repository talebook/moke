import '@/app/globals.css';
import type { Viewport } from 'next';
import { AppShell } from '@/components/providers/AppShell';
import { shouldAllowReaderExitTransition } from '@/lib/document-transition';

function installMokeDocumentTransitionGuard(
  shouldAllowReaderExit: (
    runtimePlatform: string,
    fromUrl?: string,
    currentUrl?: string,
  ) => boolean,
) {
  type CrossDocumentTransitionEvent = Event & {
    viewTransition?: {
      finished: Promise<unknown>;
      skipTransition: () => void;
    };
  };

  const root = document.documentElement;
  const runtimePlatform = () => root.dataset.mokeRuntimePlatform
    || window.sessionStorage.getItem('moke-runtime-platform')
    || '';
  const clearMarkerAfter = (event: CrossDocumentTransitionEvent) => {
    const clearMarker = () => {
      delete root.dataset.mokeReaderTransition;
    };
    if (event.viewTransition) {
      void event.viewTransition.finished.finally(clearMarker).catch(() => undefined);
    } else {
      clearMarker();
    }
    window.setTimeout(clearMarker, 1_000);
  };
  const skip = (event: CrossDocumentTransitionEvent) => {
    try {
      event.viewTransition?.skipTransition();
    } catch {
      // A transition that already finished needs no cleanup.
    }
  };

  // @view-transition is a document-wide opt-in. Moke never animates an
  // outgoing full-document navigation; this covers startup redirects and
  // Moke -> Readest entry without paying for an unrelated default fade.
  window.addEventListener('pageswap', (rawEvent) => {
    skip(rawEvent as CrossDocumentTransitionEvent);
  });

  window.addEventListener('pagereveal', (rawEvent) => {
    const event = rawEvent as CrossDocumentTransitionEvent;
    try {
      const navigationApi = (window as Window & {
        navigation?: { activation?: { from?: { url?: string } | null } };
      }).navigation;
      if (!shouldAllowReaderExit(
        runtimePlatform(),
        navigationApi?.activation?.from?.url,
        window.location.href,
      )) {
        skip(event);
        return;
      }
      root.dataset.mokeReaderTransition = 'exit';
      clearMarkerAfter(event);
    } catch {
      skip(event);
    }
  });
}

// Both functions are serialized into the pre-hydration document. Keep their
// implementations self-contained; tests execute the serialized guard helper.
// This head script must run before hydration. In production Tauri's asset
// compiler hashes each emitted inline script and appends the exact sha256
// sources to script-src (dangerousDisableAssetCspModification stays false in
// tauri.conf.json); development uses the separate devCsp policy.
const mokeDocumentTransitionGuardScript = `(${installMokeDocumentTransitionGuard.toString()})(${shouldAllowReaderExitTransition.toString()});`;

const isNativeAppBuild = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  ...(isNativeAppBuild ? { maximumScale: 1, userScalable: false } : {}),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      data-moke-native-app={isNativeAppBuild ? '' : undefined}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: mokeDocumentTransitionGuardScript }} />
        {/* Apply the persisted theme before hydration so the first paint is
            already dark when dark mode is on (no flash of white). Reads the
            zustand persist payload directly; falls back to the OS preference
            for 'system'. Also syncs color-scheme so native scrollbars/form
            controls match the theme. E-ink mode suppresses dark entirely AND
            sets data-eink before first paint, so an e-ink user doesn't get a
            warm-light flash before the effect runs.
            WARNING: this duplicates resolveTheme() from src/lib/store/settings.ts
            and assumes the zustand persist shape { state: { theme, eink } } —
            keep it in sync when either changes (tests/theme-init.test.mjs
            asserts this).
            Note: the only reason for suppressHydrationWarning on <html> is
            that this script mutates the class attribute before hydration. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=JSON.parse(localStorage.getItem('moke-settings')||'{}');var st=s&&s.state||{};var t=st.theme||'system';var eink=!!st.eink;var el=document.documentElement;if(eink){el.setAttribute('data-eink','true')}var darkMq=window.matchMedia('(prefers-color-scheme: dark)');var autoEink=window.matchMedia('(update: slow), (max-color: 1)').matches;var dark=!eink&&!autoEink&&(t==='dark'||(t==='system'&&darkMq.matches));if(dark){el.classList.add('dark');el.style.colorScheme='dark'}else{el.style.colorScheme='light'}}catch(e){}})();/*MOKE-THEME-INIT*/`,
          }}
        />
        {/* Keep the first render independent from third-party font servers. The
            system stack in globals.css avoids a render-blocking Google Fonts
            request on LAN/Tauri deployments. */}
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
