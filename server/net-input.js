// net-input.js - adapter exposing the client Input surface (axis()->{x,z}, down(code)) over a wire bitfield
// The vehicle controllers (ground/hover/heli/plane/boat) only ever call input.axis() and
// input.down(code) for Space / ShiftLeft / ShiftRight / KeyQ / KeyE. NetInput backs those with the
// 7-field driving message { vid, x, z, sp, sh, kq, ke } so the SAME controller class runs server-side.
export class NetInput {
  constructor() {
    this.x = 0; this.z = 0;
    this.sp = 0; this.sh = 0; this.kq = 0; this.ke = 0;
  }

  // Adopt the latest input message (already sanitized to -1/0/1 and 0/1 in protocol.packInput).
  set(msg) {
    this.x = msg.x | 0;
    this.z = msg.z | 0;
    this.sp = msg.sp ? 1 : 0;
    this.sh = msg.sh ? 1 : 0;
    this.kq = msg.kq ? 1 : 0;
    this.ke = msg.ke ? 1 : 0;
  }

  // Zero all inputs (vehicle with no driver, or driver just left the seat).
  clear() { this.x = this.z = this.sp = this.sh = this.kq = this.ke = 0; }

  axis() { return { x: this.x, z: this.z }; }

  down(code) {
    switch (code) {
      case "Space": return this.sp === 1;
      case "ShiftLeft":
      case "ShiftRight": return this.sh === 1;
      case "KeyQ": return this.kq === 1;
      case "KeyE": return this.ke === 1;
      default: return false;
    }
  }
}
