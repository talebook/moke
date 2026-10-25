/** A native back gesture belongs to the most recently opened overlay. */
export class OverlayBackStack {
  private readonly entries: Array<{ close: () => void }> = [];

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

  consume(event: Event, commit: boolean): boolean {
    const entry = this.entries.at(-1);
    if (!entry) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (commit) entry.close();
    return true;
  }
}
