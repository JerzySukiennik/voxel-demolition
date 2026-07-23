// menu.js - Tab-toggled vehicle grid (keyboard-first, pointer lock kept, spawns via callback)
import { VEHICLE_SPECS, VEHICLE_ORDER } from "./vehicles/registry.js";

const COLS = 4;

export class VehicleMenu {
  constructor(onSpawn) {
    this.onSpawn = onSpawn;
    this.isOpen = false;
    this.selected = 0;

    this.root = document.getElementById("vehicle-menu");
    this.header = document.getElementById("vm-selected");
    this.grid = document.getElementById("vm-grid");
    this.tiles = [];

    for (let i = 0; i < VEHICLE_ORDER.length; i++) {
      const id = VEHICLE_ORDER[i];
      const spec = VEHICLE_SPECS[id];
      const tile = document.createElement("div");
      tile.className = "vm-tile";
      const sw = document.createElement("div");
      sw.className = "vm-swatch";
      sw.style.background = spec.tile;
      sw.textContent = spec.name.charAt(0).toUpperCase();
      const label = document.createElement("div");
      label.className = "vm-label";
      label.textContent = spec.name;
      tile.appendChild(sw);
      tile.appendChild(label);
      tile.addEventListener("click", () => { this.selected = i; this._spawnSelected(); });
      this.grid.appendChild(tile);
      this.tiles.push(tile);
    }
    this._refresh();

    // Own keydown handler: only acts while open; navigation + confirm.
    window.addEventListener("keydown", (e) => {
      if (!this.isOpen) return;
      switch (e.code) {
        case "KeyW": case "ArrowUp": this._move(0, -1); e.preventDefault(); break;
        case "KeyS": case "ArrowDown": this._move(0, 1); e.preventDefault(); break;
        case "KeyA": case "ArrowLeft": this._move(-1, 0); e.preventDefault(); break;
        case "KeyD": case "ArrowRight": this._move(1, 0); e.preventDefault(); break;
        case "Enter": case "Space": this._spawnSelected(); e.preventDefault(); break;
      }
    });
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    if (this.root) this.root.style.display = "flex";
    this._refresh();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.root) this.root.style.display = "none";
  }

  _move(dx, dy) {
    const n = this.tiles.length;
    let idx = this.selected;
    const col = idx % COLS;
    if (dx > 0 && col < COLS - 1 && idx + 1 < n) idx += 1;
    else if (dx < 0 && col > 0) idx -= 1;
    else if (dy > 0 && idx + COLS < n) idx += COLS;
    else if (dy < 0 && idx - COLS >= 0) idx -= COLS;
    this.selected = idx;
    this._refresh();
  }

  _refresh() {
    for (let i = 0; i < this.tiles.length; i++) {
      this.tiles[i].classList.toggle("vm-selected", i === this.selected);
    }
    const id = VEHICLE_ORDER[this.selected];
    if (this.header) this.header.textContent = VEHICLE_SPECS[id].name;
  }

  _spawnSelected() {
    const id = VEHICLE_ORDER[this.selected];
    this.close();
    if (this.onSpawn) this.onSpawn(id);
  }
}
