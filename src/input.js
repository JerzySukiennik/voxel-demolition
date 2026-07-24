// input.js - keyboard state, mouse look deltas, pointer lock, edge-triggered E/digits/mouse buttons/wheel
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Map();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this._eQueued = false;
    this._tabQueued = false;
    this._digitQueue = [];
    this._lmbQueued = false;
    this._rmbQueued = false;
    this.lmbDown = false;
    this.rmbDown = false; // held RMB state (Phase 7 Magnet Gun repel needs a continuous button, not just an edge)
    this.wheelDelta = 0;

    window.addEventListener("keydown", (e) => {
      if (e.repeat) { if (e.code === "Space") e.preventDefault(); return; }
      this.keys.set(e.code, true);
      if (e.code === "KeyE") this._eQueued = true;
      if (e.code === "Tab") { this._tabQueued = true; e.preventDefault(); }
      if (/^Digit[1-9]$/.test(e.code)) this._digitQueue.push(parseInt(e.code.slice(5), 10));
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.set(e.code, false));

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this._lmbQueued = true; this.lmbDown = true; }
      else if (e.button === 2) { this._rmbQueued = true; this.rmbDown = true; }
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.lmbDown = false;
      else if (e.button === 2) this.rmbDown = false;
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("wheel", (e) => {
      if (!this.locked) return;
      this.wheelDelta += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
    });
    window.addEventListener("blur", () => { this.keys.clear(); this.lmbDown = false; this.rmbDown = false; });
  }

  requestLock() {
    if (!this.locked && this.canvas.requestPointerLock) this.canvas.requestPointerLock();
  }

  down(code) { return this.keys.get(code) === true; }

  axis() {
    let x = 0, z = 0;
    if (this.down("KeyW")) z += 1;
    if (this.down("KeyS")) z -= 1;
    if (this.down("KeyA")) x += 1;
    if (this.down("KeyD")) x -= 1;
    return { x, z };
  }

  consumeE() {
    const v = this._eQueued;
    this._eQueued = false;
    return v;
  }

  consumeTab() {
    const v = this._tabQueued;
    this._tabQueued = false;
    return v;
  }

  consumeDigits() {
    const q = this._digitQueue;
    this._digitQueue = [];
    return q;
  }

  consumeLMB() {
    const v = this._lmbQueued;
    this._lmbQueued = false;
    return v;
  }

  consumeRMB() {
    const v = this._rmbQueued;
    this._rmbQueued = false;
    return v;
  }

  consumeWheel() {
    const v = this.wheelDelta;
    this.wheelDelta = 0;
    return v;
  }

  // Clear per-frame mouse deltas after all systems consumed them.
  endFrame() {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }
}
