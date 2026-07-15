export class Input {
  private keys = new Set<string>();
  private pressHandlers = new Map<string, (() => void)[]>();

  /** virtual input state, driven by the on-screen touch controls */
  virtual = { throttle: 0, brake: 0, steer: 0, handbrake: false };

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (!this.keys.has(e.code)) {
        const hs = this.pressHandlers.get(e.code);
        if (hs) hs.forEach((h) => h());
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  onPress(code: string, handler: () => void) {
    const list = this.pressHandlers.get(code) ?? [];
    list.push(handler);
    this.pressHandlers.set(code, list);
  }

  has(code: string) {
    return this.keys.has(code);
  }

  get throttle(): number {
    if (this.virtual.throttle > 0) return this.virtual.throttle;
    return this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0;
  }
  get brake(): number {
    if (this.virtual.brake > 0) return this.virtual.brake;
    return this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0;
  }
  get steer(): number {
    if (this.virtual.steer !== 0) return this.virtual.steer;
    let s = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) s += 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) s -= 1;
    return s;
  }
  get handbrake(): boolean {
    return this.virtual.handbrake || this.keys.has('Space');
  }
}
