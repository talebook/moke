/** A native BACK request belongs to the most recently opened overlay. */
export class OverlayBackStack {
  private readonly entries: Array<{ close: () => void }> = [];

  hasOpenEntry(): boolean {
    return this.entries.length > 0;
  }

  register(close: () => void) {
    const entry = { close };
    this.entries.push(entry);
    return {
      isTop: () => this.entries.at(-1) === entry,
      remove: () => {
        const index = this.entries.indexOf(entry);
        if (index >= 0) this.entries.splice(index, 1);
      },
    };
  }

  consume(event: Event): boolean {
    const entry = this.entries.at(-1);
    if (!entry) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    entry.close();
    return true;
  }
}

// The route listener and every overlay must consult the same ownership stack.
export const overlayBackStack = new OverlayBackStack();
