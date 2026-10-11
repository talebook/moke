import { isUsablePageSize, type ComicPageSize } from './comic-size.ts';

// An inert, local placeholder lets the unmodified reader retain its layout and
// page explorer. Only this host adapter obtains authenticated image bytes.
export function comicPlaceholder(index: number, width: number, height: number) {
  // Trusted manifest dimensions give the inert placeholder the same intrinsic
  // size as the page, including in the reader's original-size scroll mode.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}#comic-${index}`;
}

export class ComicImageLayoutError extends Error {
  readonly diagnostics: { pageIndex: number | null; width: number | null; height: number | null };
  constructor(index: number, dimensions?: ComicPageSize) {
    super('漫画页面尺寸信息无效，请重新加载。');
    this.name = 'ComicImageLayoutError';
    this.diagnostics = {
      pageIndex: Number.isSafeInteger(index) && index >= 0 ? index : null,
      width: typeof dimensions?.width === 'number' && Number.isFinite(dimensions.width) ? dimensions.width : null,
      height: typeof dimensions?.height === 'number' && Number.isFinite(dimensions.height) ? dimensions.height : null,
    };
  }
}

interface ComicImageOptions {
  load: (index: number) => Promise<Blob>;
  onError: (error: unknown) => void;
  onReady: () => void;
  pageDimensions: readonly ComicPageSize[];
}

export function bindComicImages(host: HTMLElement, { load, onError, onReady, pageDimensions }: ComicImageOptions) {
  let active = true;
  let running = 0;
  const images = new Map<HTMLImageElement, number>();
  const placeholders = new Map<number, string>();
  const queued = new Set<number>();
  const loading = new Set<number>();
  const cache = new Map<number, { url: string; size: number }>();
  const failed = new Set<number>();
  const invalidDimensions = new Set<number>();
  const visible = new Set<HTMLImageElement>();
  const observers = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const img = entry.target as HTMLImageElement;
      if (entry.isIntersecting) { visible.add(img); enqueue(images.get(img)); }
      else visible.delete(img);
    }
  }, { root: host, rootMargin: '300px' });

  function prune() {
    for (const [img] of images) {
      if (!host.contains(img)) { observers.unobserve(img); images.delete(img); visible.delete(img); }
    }
    let bytes = [...cache.values()].reduce((sum, item) => sum + item.size, 0);
    for (const [index, item] of cache) {
      if (cache.size <= 12 && bytes <= 64 * 1024 * 1024) break;
      if ([...images].some(([img, value]) => value === index && (visible.has(img) || img.closest('.kr-preload')))) continue;
      cache.delete(index);
      bytes -= item.size;
      for (const [img, value] of images) if (value === index) img.src = placeholders.get(index)!;
      URL.revokeObjectURL(item.url);
    }
  }
  function apply(index: number, url: string) {
    for (const [img, value] of images) if (value === index && img.src !== url) img.src = url;
  }
  function enqueue(index?: number) {
    if (!active || index === undefined) return;
    const cached = cache.get(index);
    if (cached) { apply(index, cached.url); return; }
    if (!failed.has(index) && !loading.has(index)) queued.add(index);
    pump();
  }
  function pump() {
    while (active && running < 4 && queued.size) {
      const index = queued.values().next().value!;
      queued.delete(index);
      loading.add(index);
      running++;
      void load(index).then(blob => {
        if (!active) return;
        const url = URL.createObjectURL(blob);
        cache.set(index, { url, size: blob.size });
        apply(index, url);
        prune();
      }).catch(error => {
        if (active) { failed.add(index); onError(error); }
      }).finally(() => { running--; loading.delete(index); pump(); });
    }
  }
  function scan() {
    if (!active) return;
    prune();
    host.querySelectorAll<HTMLImageElement>('img').forEach(img => {
      if (!images.has(img)) {
        const match = img.getAttribute('src')?.match(/#comic-(\d+)$/);
        if (!match) return;
        const index = Number(match[1]);
        const dimensions = pageDimensions[index];
        if (!dimensions || !isUsablePageSize(dimensions)) {
          // Reader views can contain several images for the same page, and
          // mutations rescan them. Report once per page for this adapter run.
          if (!invalidDimensions.has(index)) {
            invalidDimensions.add(index);
            onError(new ComicImageLayoutError(index, dimensions));
          }
          return;
        }
        // Lazy SVG placeholders have no intrinsic dimensions until decoded.
        // Reserve their manifest ratio before that happens, including after
        // eviction. This does not override the reader's original-size attrs.
        img.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
        placeholders.set(index, img.getAttribute('src')!);
        images.set(img, index);
        observers.observe(img);
      }
      const index = images.get(img)!;
      // Reader preloads deliberately sit off-screen; they are still bounded
      // by its preload setting and the four concurrent host requests.
      if (img.closest('.kr-preload') || visible.has(img)) enqueue(index);
    });
  }
  const onLoaded = (event: Event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.src.startsWith('blob:') && img.closest('.kr-spread, .kr-continuous')) onReady();
  };
  host.addEventListener('load', onLoaded, true);
  const mutations = new MutationObserver(scan);
  mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  scan();
  return () => {
    active = false;
    mutations.disconnect();
    host.removeEventListener('load', onLoaded, true);
    observers.disconnect();
    queued.clear();
    for (const item of cache.values()) URL.revokeObjectURL(item.url);
    cache.clear();
  };
}
