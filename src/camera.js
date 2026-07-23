// camera.js - FPP look rig (yaw/pitch) + spring-damped third-person chase rig
import * as THREE from "three";
import { CONFIG } from "./config.js";

const C = CONFIG.camera;

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0;
    this.mode = "fpp";
    this.chasePos = new THREE.Vector3();
    this.chaseVel = new THREE.Vector3();
    this._initChase = false;
  }

  addMouseLook(dx, dy, sens = 0.0022) {
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -C.pitchClamp, C.pitchClamp);
  }

  getForward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
  getRight() {
    const f = this.getForward();
    return new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
  }

  applyFPP(eyePos) {
    this.mode = "fpp";
    this._initChase = false;
    const e = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(e);
    this.camera.position.copy(eyePos);
  }

  applyChase(dt, carPos, carQuat, world, RAPIER, excludeBody, preset) {
    this.mode = "chase";
    const p = (C.chase && C.chase[preset]) || C.chase.car;
    const off = new THREE.Vector3(p.offset.x, p.offset.y, p.offset.z).applyQuaternion(carQuat);
    const target = carPos.clone().add(off);
    if (!this._initChase) {
      this.chasePos.copy(target);
      this.chaseVel.set(0, 0, 0);
      this._initChase = true;
    }
    const k = C.chaseStiffness;
    const c = 2 * Math.sqrt(k);
    const accel = target.clone().sub(this.chasePos).multiplyScalar(k).addScaledVector(this.chaseVel, -c);
    this.chaseVel.addScaledVector(accel, dt);
    this.chasePos.addScaledVector(this.chaseVel, dt);

    const lookAt = carPos.clone().add(new THREE.Vector3(p.look.x, p.look.y, p.look.z));

    // Pull in on obstruction between lookAt and camera.
    let camPos = this.chasePos.clone();
    const dir = camPos.clone().sub(lookAt);
    const len = dir.length();
    if (len > 0.01) {
      dir.normalize();
      const ray = new RAPIER.Ray({ x: lookAt.x, y: lookAt.y, z: lookAt.z }, { x: dir.x, y: dir.y, z: dir.z });
      const hit = world.castRay(ray, len, true, undefined, undefined, undefined, excludeBody);
      if (hit && hit.toi < len) {
        camPos = lookAt.clone().addScaledVector(dir, Math.max(0.5, hit.toi - 0.2));
      }
    }
    this.camera.position.copy(camPos);
    this.camera.lookAt(lookAt);
  }
}
