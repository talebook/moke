// Simulate HTTP/older WebViews and restore the test process's Web Crypto.
export function mockCrypto(context, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  });
}
