// An inert, local placeholder lets the unmodified reader retain its layout and
// page explorer. Only this host adapter obtains authenticated image bytes.
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
export const comicPlaceholder = (index: number) => `${PLACEHOLDER}#comic-${index}`;

export function bindComicImages(
  host: HTMLElement,
  load: (index: number) => Promise<Blob>,
  onError: (error: unknown) => void,
  onReady: () => void,
) {
  let active = true;
  let running = 0;
  const images = new Map<HTMLImageElement, number>();
  const queued = new Set<number>();
  const loading = new Set<number>();
  const cache = new Map<number, { url: string; size: number }>();
  const failed = new Set<number>();
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
      for (const [img, value] of images) if (value === index) img.src = comicPlaceholder(index);
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
        images.set(img, Number(match[1]));
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
