import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComicImages, comicPlaceholder } from '../src/lib/comic-images.ts';

function installImageHost(context, dimensions, { originalSize = false } = {}) {
  const observers = {};
  const requests = [];
  const revoked = [];
  const errors = [];
  let nextBlob = 1;

  class Image {
    constructor(dimensions, index) {
      this.src = comicPlaceholder(index, dimensions.width, dimensions.height);
      this.loading = 'lazy';
      this.naturalWidth = 0; // No placeholder or PNG has been decoded.
      this.naturalHeight = 0;
      this.style = { aspectRatio: '' };
      this.width = originalSize ? dimensions.width : 0;
      this.height = originalSize ? dimensions.height : 0;
    }
    getAttribute(name) { return name === 'src' ? this.src : null; }
    closest() { return null; }
  }
  const mockGlobal = (name, value) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  };
  mockGlobal('HTMLImageElement', Image);
  mockGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.intersections = this; }
    observe(image) { this.observed.add(image); }
    unobserve(image) { this.observed.delete(image); }
    disconnect() { this.observed.clear(); }
  });
  mockGlobal('MutationObserver', class {
    constructor(callback) { this.callback = callback; observers.mutations = this; }
    observe() {}
    disconnect() {}
  });
  context.mock.method(URL, 'createObjectURL', () => `blob:fixture-${nextBlob++}`);
  context.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); });
  const images = dimensions.map((size, index) => new Image(size, index));
  const host = {
    contains: image => images.includes(image),
    querySelectorAll: () => images,
    addEventListener() {},
    removeEventListener() {},
  };
  const dispose = bindComicImages(host, async index => {
    requests.push(index);
    return new Blob([new Uint8Array(16)], { type: 'image/png' });
  }, error => { errors.push(error); }, () => {}, dimensions);
  context.after(dispose);
  return {
    images, requests, revoked, errors, observers,
    intersect(entries) { observers.intersections.callback(entries.map(([index, isIntersecting]) => ({ target: images[index], isIntersecting }))); },
  };
}

async function drainImageRequests() {
  // Wait for the production promise/pump chain, without browser timing claims.
  await new Promise(resolve => setImmediate(resolve));
}

test('lazy placeholders reserve mixed manifest ratios before decode without forcing image requests', context => {
  const dimensions = [{ width: 800, height: 1100 }, { width: 900, height: 600 }];
  const { images, requests } = installImageHost(context, dimensions);
  assert.deepEqual(images.map(image => image.style.aspectRatio), ['800 / 1100', '900 / 600']);
  assert.deepEqual(images.map(image => [image.loading, image.naturalWidth, image.naturalHeight]), [['lazy', 0, 0], ['lazy', 0, 0]]);
  assert.deepEqual(images.map(image => [image.width, image.height]), [[0, 0], [0, 0]]);
  assert.deepEqual(requests, []);
});

test('adapter ratios preserve the reader original-size width and height attributes', context => {
  const dimensions = [{ width: 800, height: 1100 }, { width: 900, height: 600 }];
  const { images, observers } = installImageHost(context, dimensions, { originalSize: true });
  observers.mutations.callback();
  assert.deepEqual(images.map(image => [image.width, image.height, image.style.aspectRatio]), [
    [800, 1100, '800 / 1100'], [900, 600, '900 / 600'],
  ]);
});

test('cache eviction restores the placeholder with its ratio intact and reloads it on visibility', async context => {
  const dimensions = Array.from({ length: 13 }, (_, index) => index % 2 ? { width: 900, height: 600 } : { width: 800, height: 1100 });
  const { images, requests, revoked, errors, intersect } = installImageHost(context, dimensions);
  const placeholder = images[0].src;
  for (let index = 0; index < images.length; index++) {
    intersect(index ? [[index - 1, false], [index, true]] : [[index, true]]);
    await drainImageRequests();
  }
  assert.deepEqual(requests, Array.from({ length: 13 }, (_, index) => index));
  assert.equal(images[0].src, placeholder);
  assert.equal(images[0].style.aspectRatio, '800 / 1100');
  assert.equal(images.filter(image => image.src.startsWith('blob:')).length, 12);
  assert.deepEqual(revoked, ['blob:fixture-1']);
  intersect([[12, false], [0, true]]);
  await drainImageRequests();
  assert.equal(images[0].src, 'blob:fixture-14');
  assert.equal(images[0].style.aspectRatio, '800 / 1100');
  assert.equal(images[1].src, comicPlaceholder(1, 900, 600));
  assert.equal(images[1].style.aspectRatio, '900 / 600');
  assert.deepEqual(errors, []);
});

test('invalid dimensions and unknown placeholder indices cannot install layout styles or dispatch loads', async context => {
  const dimensions = [
    { width: 0, height: 1100 }, { width: 800, height: -1 }, { width: 1.5, height: 600 },
    { width: Infinity, height: 600 }, { width: 40001, height: 1 }, { width: 8000, height: 8000 },
  ];
  const { images, requests, observers, intersect } = installImageHost(context, dimensions);
  images[0].src = comicPlaceholder(999, 800, 1100);
  observers.mutations.callback();
  assert.deepEqual(images.map(image => image.style.aspectRatio), dimensions.map(() => ''));
  assert.equal(observers.intersections.observed.size, 0);
  intersect(dimensions.map((_, index) => [index, true]));
  await drainImageRequests();
  assert.deepEqual(requests, []);
});
