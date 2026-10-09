// Wait for geometry to stop changing at the requested destination. A page-count
// update alone occurs before smooth scrolling and must not satisfy this gate.
export async function waitForComicScroll(page, destination) {
  return page.locator('.kr-continuous').evaluate((scroller, destination) => new Promise(resolve => {
    let previous = '';
    let stableSince = performance.now();
    function sample(now) {
      const top = scroller.scrollTop;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const expected = destination === 'start' ? 0 : destination === 'end' ? max : destination === 'current' ? top : destination;
      const geometry = `${top}:${max}:${scroller.clientHeight}`;
      if (geometry !== previous || Math.abs(top - expected) > 1) stableSince = now;
      previous = geometry;
      if (now - stableSince >= 200) resolve({ top, max, stableMs: now - stableSince });
      else requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }), destination);
}
