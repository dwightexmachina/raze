export class Input {
  private keys = new Set<string>();
  /** Set true for one frame when R is pressed. */
  resetRequested = false;
  /** Last digit key (0-9) pressed, cleared by consumeDigit(). */
  private lastDigit: number | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR') this.resetRequested = true;
      if (e.code.startsWith('Digit')) this.lastDigit = parseInt(e.code.slice(5), 10);
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** One-shot: the last digit key (0-9) pressed since the last call, or null. */
  consumeDigit(): number | null {
    const d = this.lastDigit;
    this.lastDigit = null;
    return d;
  }

  get thrust(): number {
    return (this.down('KeyW') || this.down('ArrowUp') ? 1 : 0) - (this.down('KeyS') || this.down('ArrowDown') ? 1 : 0);
  }

  get steer(): number {
    return (this.down('KeyA') || this.down('ArrowLeft') ? 1 : 0) - (this.down('KeyD') || this.down('ArrowRight') ? 1 : 0);
  }

  get boost(): boolean {
    return this.down('ShiftLeft') || this.down('ShiftRight');
  }

  get jump(): boolean {
    return this.down('Space');
  }

  consumeReset(): boolean {
    const r = this.resetRequested;
    this.resetRequested = false;
    return r;
  }

  private down(code: string): boolean {
    return this.keys.has(code);
  }
}
