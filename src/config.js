// config.js - all Phase 1 tuning constants in one exported object (brief section 4)
export const CONFIG = {
  gravity: { x: 0, y: -9.81, z: 0 },
  fixedDt: 1 / 60,
  maxSubsteps: 3,

  // Phase 5 lobby + avatar. nickMaxLen caps the name field; preview* tune the rotating
  // lobby character canvas; shadeFactor derives the "shade" palette slots from their main color.
  lobby: { nickMaxLen: 16, previewRotSpeed: 0.6, previewFov: 35 },
  avatar: { shadeFactor: 0.82 },

  world: {
    plazaSize: 48,
    coreThickness: 1.0,
    skinThickness: 0.3,
    skinVoxel: 0.3,
    structureVoxel: 0.15,
    // Excavated water basin (createCore). On a map with a `water.rect`, the indestructible core is
    // rebuilt as a "picture frame" of cuboids around the rect (a single cuboid can't have a hole) and
    // the rect opening is lined with a recessed bowl: an indestructible floor at basinFloorY plus four
    // retaining walls from basinFloorY up to skinThickness. Water then sits FLUSH with the sand surface
    // and boats float at real depth. basinFloorY relative to the y=0 core top; depth = skinThickness - basinFloorY.
    basinFloorY: -2.6,
    basinFloorThickness: 1.0,
    basinWallThickness: 0.4,
    basinColor: "#8a7350",
    // SE-corner entry ramp into the excavated basin: one sloped indestructible plate anchored at the rect's
    // (x1,z1) corner (the open boat-apron side), sloping from the sand rim (skinThickness) down to basinFloorY.
    // basinRampRun = how far it reaches into the basin (X); basinRampWidth = its span along the edge (Z);
    // only this corner is filled so the boat-floating center of the basin stays deep. Boats drive in over it,
    // waded-in players walk back out. Fixed core geometry — never destructible / never an allowedImpactor.
    basinRampRun: 6.0,
    basinRampWidth: 5.0,
    basinRampThickness: 0.4,
    skyColor: 0x8fb7e0,
    fogColor: 0x9cc0e6,
    fogNear: 40,
    fogFar: 120,
    groundColor: "#8a8d90",
  },

  render: {
    pixelRatioCap: 2,
    shadowMapSize: 2048,
    shadowBoxHalf: 26,
    shadowBias: -0.0004,
    shadowNormalBias: 0.03,
    sunColor: 0xfff2df,
    sunIntensity: 2.2,
    sunElevationDeg: 50,
    sunAzimuthDeg: 35,
    hemiIntensity: 0.5,
    hemiSky: 0xbcd6f2,
    hemiGround: 0x6b6f5f,
  },

  voxel: {
    jitterLightness: 0.04,
    jitterBuckets: 6,
    shinyMetalnessCutoff: 0.1,
    roughMat: { roughness: 0.86, metalness: 0.0 },
    shinyMat: { roughness: 0.4, metalness: 0.25 },
  },

  destruction: {
    chunkSizeSkin: 3.0,
    chunkSizeProp: 0.6,
    tileMeters: 8,
    debrisCap: 200,
    debrisSleepCullSeconds: 20,
    debrisSleepCullMin: 100,
    fadeSeconds: 0.3,
    detachKick: 0.5,
    neighborDetachMultiplier: 2.0,
    // Phase 1 props (skin/wall/crate/shed) unchanged. Phase 4 map materials appended (brief section 4).
    // Phase 7 batch D: `foam` = the constructive-voxel material sprayed by the Foam Cannon — light density,
    // low-ish threshold so every weapon breaks it through the normal pipeline, yet high enough to stand/drive on.
    density: { skin: 1600, wall: 1400, crate: 350, shed: 700, brick: 1400, concrete: 2000, wood: 600, plank: 600, roofWood: 600, roofTile: 900, metal: 1200, glass: 250, sand: 1600, rock: 2200, foam: 120 },
    forceThreshold: { skin: 9000, wall: 5000, shed: 5000, crate: 1500, brick: 5000, concrete: 8000, wood: 3000, plank: 3000, roofWood: 3000, roofTile: 4000, metal: 6000, glass: 800, sand: 9000, rock: 14000, foam: 2200 },
    // Chunk sizes tuned UP from the section-4 starting values so map-scale chunk totals clear the
    // <=2500 gate on the Radeon 5500M (voxel size is fixed at 0.15). Chunkier pieces also match the
    // brief's "fewer pieces over fine dust" directive. Deviation documented in the phase report.
    matChunkSize: { brick: 1.1, concrete: 1.4, wood: 1.1, plank: 1.1, roofWood: 1.4, roofTile: 1.4, metal: 1.3, glass: 0.5, sand: 3.0, rock: 1.4, foam: 0.6 },
    boatWaterDamping: 1.2,
    carWaterDamping: 1.0,
    restitution: 0.12,
    friction: 0.9,
  },

  player: {
    radius: 0.35,
    halfHeight: 0.55,
    totalHeight: 1.8,
    mass: 82,
    extraGravityAccel: 12,
    walkAccel: 4.2 * 9,
    walkSpeed: 4.2,
    sprintSpeed: 7.0,
    airControl: 0.25,
    jumpVelocity: 5.0,
    groundRayExtra: 0.15,
    enterRange: 2.5,
    eyeHeightFallback: 1.62,
    limbSwingGain: 0.9,
    limbSwingSpeed: 2.1,
  },

  // Vehicle roster tuning. `defaults` holds values shared by every ground/boat vehicle;
  // each entry overrides only what differs. inertia (solid-box from colliderHalf), com
  // (hatchback {0,0.4,0} scaled by colliderCenterY/0.65) and springForceClamp (36*mass,
  // unless the entry pins it) are DERIVED in code (see resolveTuning in vehicles/registry.js).
  // Numbers here are data tables, so literal constants are expected.
  vehicles: {
    defaults: {
      steerLowSpeed: 5,
      steerHighSpeed: 25,
      steerRate: 3.0,
      linearDamping: 0.05,
      angularDamping: 0.6,
      audioSpeedRef: 24,
      spawnClearanceMargin: 1.1,
    },

    // hatchback = exactly the Phase 1 numbers; springForceClamp pinned to keep it byte-identical.
    hatchback: { mass: 1100, engineForce: 5500, brakeForce: 8000, reverseForce: 3000, wheelRadius: 0.30, suspensionRest: 0.35, maxTravel: 0.18, springK: 24000, damperC: 3000, tireMu: 1.6, lateralGrip: 8.0, steerLow: 0.55, steerHigh: 0.18, colliderHalf: { x: 0.8, y: 0.5, z: 1.8 }, colliderCenterY: 0.65, spawnBodyY: 0.19, springForceClamp: 40000 },

    // Phase 7 batch C — RC Car Bomb micro vehicle (weapon-owned; reuses the GroundVehicle controller +
    // hatchback model). ~15 kg is unstable in Rapier, so mass 60 with nippy forces + a small collider.
    rccar: { mass: 60, engineForce: 900, brakeForce: 700, reverseForce: 500, wheelRadius: 0.12, suspensionRest: 0.14, maxTravel: 0.08, springK: 2600, damperC: 320, tireMu: 1.7, lateralGrip: 9.0, steerLow: 0.65, steerHigh: 0.35, steerHighSpeed: 12, colliderHalf: { x: 0.30, y: 0.16, z: 0.55 }, colliderCenterY: 0.20, spawnBodyY: 0.08, audioSpeedRef: 8, springForceClamp: 3000 },

    buggy: { mass: 900, engineForce: 6500, brakeForce: 8000, reverseForce: 3500, wheelRadius: 0.55, suspensionRest: 0.55, maxTravel: 0.30, springK: 20000, damperC: 2500, tireMu: 1.8, lateralGrip: 7.0, steerLow: 0.60, steerHigh: 0.22, colliderHalf: { x: 1.0, y: 0.55, z: 1.6 }, colliderCenterY: 1.0, spawnBodyY: 0.30 },
    monster: { mass: 2600, engineForce: 14000, brakeForce: 18000, reverseForce: 8000, wheelRadius: 0.90, suspensionRest: 0.75, maxTravel: 0.40, springK: 57000, damperC: 7100, tireMu: 1.7, lateralGrip: 6.5, steerLow: 0.50, steerHigh: 0.20, colliderHalf: { x: 1.3, y: 0.7, z: 2.4 }, colliderCenterY: 1.9, spawnBodyY: 0.42, audioSpeedRef: 14 },
    racecar: { mass: 1000, engineForce: 8500, brakeForce: 10000, reverseForce: 3000, wheelRadius: 0.32, suspensionRest: 0.28, maxTravel: 0.12, springK: 22000, damperC: 2750, tireMu: 2.0, lateralGrip: 10.0, steerLow: 0.50, steerHigh: 0.15, steerHighSpeed: 35, colliderHalf: { x: 0.9, y: 0.35, z: 2.2 }, colliderCenterY: 0.5, spawnBodyY: 0.16 },
    wagon: { mass: 1400, engineForce: 5000, brakeForce: 8500, reverseForce: 3000, wheelRadius: 0.33, suspensionRest: 0.33, maxTravel: 0.16, springK: 31000, damperC: 3900, tireMu: 1.5, lateralGrip: 7.5, steerLow: 0.55, steerHigh: 0.18, colliderHalf: { x: 0.85, y: 0.45, z: 2.4 }, colliderCenterY: 0.7, spawnBodyY: 0.18 },
    pickup: { mass: 1600, engineForce: 6200, brakeForce: 9500, reverseForce: 3500, wheelRadius: 0.36, suspensionRest: 0.38, maxTravel: 0.18, springK: 35000, damperC: 4400, tireMu: 1.5, lateralGrip: 7.0, steerLow: 0.52, steerHigh: 0.18, colliderHalf: { x: 0.85, y: 0.55, z: 2.35 }, colliderCenterY: 0.85, spawnBodyY: 0.21 },
    classic: { mass: 1250, engineForce: 6500, brakeForce: 9000, reverseForce: 3000, wheelRadius: 0.32, suspensionRest: 0.30, maxTravel: 0.14, springK: 27500, damperC: 3450, tireMu: 1.6, lateralGrip: 8.5, steerLow: 0.55, steerHigh: 0.17, colliderHalf: { x: 0.85, y: 0.4, z: 2.3 }, colliderCenterY: 0.6, spawnBodyY: 0.17 },
    suv: { mass: 1900, engineForce: 7200, brakeForce: 11000, reverseForce: 4000, wheelRadius: 0.38, suspensionRest: 0.40, maxTravel: 0.20, springK: 42000, damperC: 5250, tireMu: 1.5, lateralGrip: 6.8, steerLow: 0.52, steerHigh: 0.18, colliderHalf: { x: 0.9, y: 0.6, z: 2.25 }, colliderCenterY: 0.95, spawnBodyY: 0.22 },
    wexcav: { mass: 5000, engineForce: 9000, brakeForce: 16000, reverseForce: 6000, wheelRadius: 0.45, suspensionRest: 0.40, maxTravel: 0.20, springK: 110000, damperC: 13750, tireMu: 1.4, lateralGrip: 6.0, steerLow: 0.40, steerHigh: 0.30, steerRate: 1.5, colliderHalf: { x: 1.1, y: 0.9, z: 2.4 }, colliderCenterY: 1.3, spawnBodyY: 0.22, audioSpeedRef: 14 },
    // tracked excavator: no wheel meshes; 4 virtual ray hardpoints at the hull corners.
    texcav: { mass: 12000, engineForce: 16000, brakeForce: 30000, reverseForce: 10000, wheelRadius: 0.45, suspensionRest: 0.30, maxTravel: 0.15, springK: 264000, damperC: 33000, tireMu: 1.8, lateralGrip: 9.0, steerLow: 0.30, steerHigh: 0.30, steerRate: 1.0, colliderHalf: { x: 1.4, y: 1.0, z: 3.5 }, colliderCenterY: 1.4, spawnBodyY: 0.17, audioSpeedRef: 14, noWheelMesh: true, rayAnchors: [[1.3, 0.5, 2.6], [-1.3, 0.5, 2.6], [1.3, 0.5, -2.6], [-1.3, 0.5, -2.6]] },
    // mobile crane: 8 wheels / 4 axles; the front two axles steer.
    crane: { mass: 14000, engineForce: 22000, brakeForce: 36000, reverseForce: 12000, wheelRadius: 0.55, suspensionRest: 0.45, maxTravel: 0.22, springK: 154000, damperC: 19250, tireMu: 1.4, lateralGrip: 6.0, steerLow: 0.35, steerHigh: 0.14, steerRate: 1.2, colliderHalf: { x: 1.4, y: 1.1, z: 4.8 }, colliderCenterY: 1.6, spawnBodyY: 0.25, audioSpeedRef: 14, steeredAnchors: ["wheelA1L", "wheelA1R", "wheelA2L", "wheelA2R"] },

    // Boats: soft-suspension GroundVehicle variant. PLACEHOLDER physics; real buoyancy
    // is deferred to Phase 4 water. No wheel meshes; 4 hull-corner ray hardpoints.
    yacht: { controller: "boat", mass: 9000, engineForce: 14000, brakeForce: 20000, reverseForce: 7000, wheelRadius: 0.40, suspensionRest: 0.50, maxTravel: 0.30, springK: 72000, damperC: 45000, tireMu: 0.7, lateralGrip: 2.5, steerLow: 0.30, steerHigh: 0.15, steerRate: 0.8, colliderHalf: { x: 2.0, y: 1.6, z: 6.8 }, colliderCenterY: 1.8, spawnBodyY: 0.30, audioSpeedRef: 15, noWheelMesh: true, rayAnchors: [[1.6, 0.4, 5.5], [-1.6, 0.4, 5.5], [1.6, 0.4, -5.5], [-1.6, 0.4, -5.5]] },
    speedboat: { controller: "boat", mass: 1800, engineForce: 7000, brakeForce: 8000, reverseForce: 3000, wheelRadius: 0.35, suspensionRest: 0.45, maxTravel: 0.25, springK: 14400, damperC: 9000, tireMu: 0.7, lateralGrip: 2.0, steerLow: 0.45, steerHigh: 0.20, colliderHalf: { x: 1.05, y: 0.6, z: 3.1 }, colliderCenterY: 0.75, spawnBodyY: 0.26, audioSpeedRef: 15, noWheelMesh: true, rayAnchors: [[0.9, 0.3, 2.4], [-0.9, 0.3, 2.4], [0.9, 0.3, -2.4], [-0.9, 0.3, -2.4]] },

    // Hover craft (Jurek's favourite). No wheels; 4 downward thruster rays.
    hover: { mass: 1300, colliderHalf: { x: 1.0, y: 0.5, z: 2.2 }, colliderCenterY: 0.75, spawnBodyY: 0.10, linearDamping: 0.4, angularDamping: 2.5, hoverHeight: 1.1, hoverMin: 0.7, hoverMax: 6.0, hoverSpringK: 14, hoverDamperC: 5, altRate: 2.5, thrustAccel: 12, yawRate: 1.8, latDamp: 3, glowSize: { x: 2.2, z: 4.2 } },

    // Helicopter. Collective + cyclic + pedals.
    heli: { mass: 4500, colliderHalf: { x: 1.2, y: 1.2, z: 4.5 }, colliderCenterY: 1.5, spawnBodyY: 0.20, linearDamping: 0.15, angularDamping: 2.2, collectiveNeutral: 0.55, collectiveRate: 0.8, thrustMaxG: 1.5, pitchTorqueK: 1.6, rollTorqueK: 1.4, yawTorqueK: 1.0, autoLevel: 2.0, rotorMainSpeed: 18, rotorTailSpeed: 40 },

    // Fixed-wing airplane. Throttle + pitch/roll/rudder; needs airspeed for lift.
    plane: { mass: 1400, colliderHalf: { x: 1.0, y: 0.8, z: 3.6 }, colliderCenterY: 1.1, spawnBodyY: 0.10, linearDamping: 0.0, angularDamping: 1.2, thrustMaxK: 9, vRef: 22, vStall: 12, dragK: 0.04, autoLevel: 0.8, throttleRate: 0.5, pitchTorqueK: 1.2, rollTorqueK: 2.2, yawTorqueK: 0.8, propSpeedBase: 10, propSpeedMax: 50, gearSpringK: 30000, gearDamperC: 4000, gearWheelRadius: 0.25, gearRest: 0.25, gearMaxTravel: 0.12 },
  },

  camera: {
    fov: 70,
    near: 0.1,
    far: 400,
    fppEyeForward: 0.08,
    pitchClamp: 1.45,
    chaseStiffness: 6,
    // Per-vehicle chase presets (registry entry names the key). car = the Phase 1 values.
    chase: {
      car: { offset: { x: 0, y: 2.2, z: -5.5 }, look: { x: 0, y: 1.0, z: 0 } },
      big: { offset: { x: 0, y: 4.5, z: -12 }, look: { x: 0, y: 2.0, z: 0 } },
      hover: { offset: { x: 0, y: 2.6, z: -7 }, look: { x: 0, y: 1.0, z: 0 } },
      air: { offset: { x: 0, y: 4.0, z: -14 }, look: { x: 0, y: 1.5, z: 0 } },
      boat: { offset: { x: 0, y: 3.0, z: -9 }, look: { x: 0, y: 1.2, z: 0 } },
    },
  },

  audio: {
    masterGain: 0.5,
    // Per-vehicle engine/rotor/hover/boat loop profiles (loop id + rate/gain ranges) live in
    // the registry (vehicles/registry.js). Category smoothing time-constants are internal to audio.js.
    engineRateSmooth: 0.06,
    engineGainSmooth: 0.08,
    impactVoices: 8,
    footstepGain: 0.5,
    pitchJitter: 0.12,
    impactGainBase: 0.2,
    impactGainScale: 0.14,
    explosionGain: 0.9,
    swingGain: 0.5,
    clangGain: 0.6,
    gunshotGain: 0.7,
    gunshotRate: 0.9,
    placeGain: 0.6,
    beepGain: 0.5,
    rocketGain: 0.5,
    rocketRate: 1.2,
    rocketSlice: 0.6,
  },

  weapons: {
    explosionDetachBudget: 60,
    explosionSoundCap: 3,
    // Staged-detach queue (Phase 7 subsystem A.3): huge/multi radial jobs drain at most this many
    // chunk detaches per frame so nuke-scale collapses ripple outward instead of a single-frame hitch.
    // Authoritative-only (solo/server); replica clients receive the resulting detach batches over frames.
    stageChunksPerFrame: 40,
    melee: {
      force: 14000,
      range: 2.8,
      cooldown: 0.45,
      swingDuration: 0.35,
      hitDelay: 0.15,
    },
    c4: {
      force: 40000,
      radius: 4.0,
      placeRange: 3.0,
      maxCharges: 20,
      placeCooldown: 0.25,
    },
    shotgun: {
      pelletForce: 3500,
      pelletCount: 6,
      spreadDeg: 4.5,
      range: 40,
      fireInterval: 0.8,
    },
    rocket: {
      force: 40000,
      radius: 4.0,
      speed: 18,
      maxLive: 4,
      fireInterval: 1.2,
      lifetime: 6,
      trailInterval: 0.04,
      trailPool: 24,
      trailLife: 0.5,
    },

    // ---- Phase 7 batch A additions ----------------------------------------------------------
    // Per-material damage multipliers (subsystem A.1): effective force = force * (mult[materialClass] ?? 1).
    // Volumes are tagged with a coarse materialClass (wood|concrete|metal|dirt|foam; default concrete).
    // The destruction model is binary (no per-chunk HP), so "weak vs concrete" means the effective force
    // stays below the concrete threshold — the tool simply cannot break it, which is the intended feel.

    // 1b. Crowbar (Melee) — precise, weak: pops single wood/crate chunks, effectively immune to concrete/metal.
    crowbar: {
      force: 1800, range: 2.2, cooldown: 0.32, swingDuration: 0.30, hitDelay: 0.12,
      mult: { wood: 1.5, concrete: 0.4, metal: 0.3, dirt: 1.0 },
    },
    // 1c. Chainsaw (Melee) — hold LMB, fast point-damage tick. Chews wood, sparks uselessly on concrete/metal.
    chainsaw: {
      tickInterval: 0.12, range: 2.2, force: 4000,
      mult: { wood: 3.0, dirt: 1.5, concrete: 0.35, metal: 0.15 },
    },
    // 2b. Pipe Bomb (Explosives) — real dynamic Rapier body, bounces/rolls, ~3 s fuse, C4-scale blast.
    pipeBomb: {
      fuse: 3.0, force: 34000, radius: 3.0, budget: 60,
      throwSpeed: 13, upBias: 3.5, restitution: 0.5, colliderRadius: 0.055, colliderHalf: 0.09,
      density: 1200, maxLive: 6, fireInterval: 0.5,
    },
    // 2c. Demolition Wire (Explosives) — C4-pattern placement, weaker-per-charge, wired visual, RMB detonate-all.
    demoWire: {
      force: 24000, radius: 2.6, budget: 40, placeRange: 3.0, maxCharges: 12,
      placeCooldown: 0.18, stageThreshold: 8, sag: 0.28,
    },
    // 4b. Sticky Bomb Launcher (Launchers) — ray-stepped projectile that sticks to world/chunks/vehicles, 2.5 s fuse.
    sticky: {
      speed: 34, fuse: 2.5, force: 30000, radius: 2.5, budget: 50,
      maxLive: 8, fireInterval: 0.55, lifetime: 6, blinkFrom: 1.5,
    },
    // 4c. Cluster Bomb Launcher (Launchers) — arced projectile splits at 0.8 s into 6 seeded bomblets; each a small staged blast.
    cluster: {
      speed: 21, upBias: 6.5, gravity: 18, splitDelay: 0.8,
      bombletCount: 6, spread: 5.5, bombletUp: 2.2, bombletGravity: 20,
      bombletForce: 26000, bombletRadius: 1.8, bombletBudget: 12, bombletLifetime: 4,
      fireInterval: 1.2, maxLive: 2,
    },

    // ---- Phase 7 batch B: category 5 "Grab & Force" (force-field / grab tools) ---------------
    // Cycle order (DoD layout table): Gravity Gun -> Magnet Gun -> Grapple Hook -> Wind Cannon -> Debris Vacuum.
    // Hard rule: NONE of these ever adds a handle to allowedImpactors, so thrown/blown/vacuumed/magnetized
    // debris still cannot cascade a detach. Wind/vacuum/magnet call NO damage function at all; the gravity
    // gun only throws (ordinary physics); grapple's ONLY damage path is the vehicle-rope tension tear.

    // 5d. Wind Cannon — one-shot cone impulse to all dynamic bodies, zero destruction, 1/dist falloff.
    // Mass-capped so light debris is shoved (<= maxDV m/s) while heavy chunks only nudge — reads as wind.
    windCannon: {
      range: 10, halfAngleDeg: 32, impulse: 9000, maxDV: 9,
      vehicleFactor: 0.25, cooldown: 0.7,
      dust: { count: 10, life: 0.5, size: 0.5, spread: 0.9, speed: 7 },
    },
    // 5e. Debris Vacuum — hold LMB, cone velocity-steer on destruction.debris toward the muzzle, consume < 1.1 m.
    // Also a performance tool: consumeDebris permanently frees entries against the 200 cap.
    vacuum: {
      range: 9, halfAngleDeg: 34, suckSpeed: 10, steer: 5, consumeDist: 1.1, shrinkFrom: 2.3,
    },
    // 5c-var. Magnet Gun — narrow metal-only force field. Hold LMB attract / hold RMB repel, 10 nearest, no carry.
    magnet: {
      range: 12, halfAngleDeg: 26, pullSpeed: 9, steer: 4, maxTargets: 10, clampDist: 1.5, massMax: 1600,
    },
    // 5a. Gravity Gun — hold LMB grabs ONE dynamic body; critically-damped spring to a hold-point 2.5 m ahead.
    // Force clamped by mass (maxAccel), angular vel damped, auto-release when wedged; RMB throws along aim.
    gravityGun: {
      grabRange: 30, holdDist: 2.5, springK: 90, dampRatio: 1.0, maxAccel: 70, angularDamp: 10,
      releaseDist: 4.5, releaseTime: 0.4, massMax: 1600, throwSpeed: 24, strainTime: 0.3,
    },
    // 5c. Grapple Hook — one rope at a time. On foot: manual distance-constraint spring on the capsule (player.js
    // grappleConstraint hook) + reel; in a vehicle: real Rapier spring joint chunk<->chassis, tension tears the chunk.
    grapple: {
      range: 60, hookSpeed: 90, segments: 16, thickness: 0.02,
      pullK: 55, pullDamp: 9, minLen: 2.0, reelRate: 6.0,
      veh: { spring: 24000, damp: 1400, restSlack: 0.92, maxLen: 24, tearTension: 8000, snapTension: 70000, tearForce: 18000 },
    },

    // ---- Phase 7 batch C: Strikes (6) + heavy/vehicular ordnance ----------------------------
    // Chain-reaction beat: a propane tank caught in a blast waits this long before its own explosion,
    // so chains ripple one tank at a time instead of a single-frame cascade (shared by all radial damage).
    propChainDelay: 0.09,

    // 2d. Blast Painter (Explosives) — hold LMB spray-paints chunks, RMB detonatePainted them together.
    blastPainter: {
      range: 6, tickInterval: 0.05, maxPainted: 80, splatSize: 0.16, force: 30000,
    },
    // 2e. Propane Tank (Explosives) — thrown dynamic tank; explodes on shot / hard impact / blast chain.
    propane: {
      force: 30000, radius: 5.0, budget: 60, throwSpeed: 11, upBias: 3.0,
      colliderRadius: 0.22, colliderHalf: 0.34, density: 240, maxLive: 8, fireInterval: 0.45,
      impactDV: 9.0, chainR: 5.0,
    },
    // 6c. Nuke (Strikes) — thrown device, 5 s beep countdown, flash + shake + staged radius-18 collapse.
    // The one huge radial job is fed ENTIRELY through the staged queue (stageChunksPerFrame) — debrisCap
    // (200) is NEVER raised. budget Infinity => clears every threshold in radius, paced by the stage queue.
    nuke: {
      force: 90000, radius: 18, budget: 100000, throwSpeed: 9, upBias: 4.5,
      countdown: 5.0, cooldown: 20, flashTime: 0.8, shakeTime: 0.9, shakeAmp: 0.28,
      dustHeight: 26, dustRadius: 5, dustLife: 6,
    },
    // 6b. Orbital Laser Designator (Strikes) — marker, 3 s countdown, vertical carveCylinder hole.
    orbital: {
      countdown: 3.0, beamLife: 1.5, cooldown: 6, radius: 1.2, force: 60000, carveBudget: 240,
      throughGround: 40, markerSize: 0.5, pillarHeight: 60, beamRadius: 1.2,
    },
    // 4d. Car Cannon (Launchers) — fires the hatchback mesh as a plain dynamic cuboid, temp-registered in
    // allowedImpactors for its lifetime so it smashes structures via the vehicle-grade contact path.
    carCannon: {
      speed: 30, upBias: 4, spin: 6, lifetime: 6, cooldown: 2.0, restSpeed: 0.6, fadeTime: 0.5,
      half: { x: 0.8, y: 0.5, z: 1.8 }, density: 300,
    },
    // 2f. RC Car Bomb (Explosives) — deploys a mini GroundVehicle; control transfers (chase cam), RMB/LMB
    // detonates (C4-scale), E/detonation/flip returns control instantly.
    rcCar: {
      force: 40000, radius: 4.0, budget: 60, autoReturnTime: 2.0, flipDot: 0.2,
      chaseBack: 4.5, chaseUp: 2.0, chaseLook: 0.5,
    },
    // 6a. Airstrike Designator (Strikes) — scripted circling plane, R cycles 3 ammo, LMB designates, RMB
    // plane-cam view. Reuses cluster machinery (bomblets) + carveCylinder (penetrator) + camera detach.
    airstrike: {
      circleRadius: 46, altitude: 60, circleSpeed: 0.35, runTime: 4.0, cooldown: 1.5,
      planeScale: 0.7, dropCount: 5, dropSpacing: 6, dropSpeed: 34,
      bombRadius: 3.0, bombForce: 34000, bombBudget: 24,
      penRadius: 1.5, penForce: 60000, penBudget: 120, penThrough: 30,
      clusterSpread: 8, aimSpeed: 0.9,
    },

    // ---- Phase 7 batch D: category 7 "Builders" (constructive-voxel subsystem B) --------------
    // Cycle order (DoD layout table): Foam Cannon -> Rebuild Gun -> Size Ray.
    // Foam blobs are FIRST-CLASS destructible volumes (materialClass "foam", tuned in CONFIG.destruction):
    // every existing weapon breaks them through the normal chunk pipeline with ZERO special-casing.
    // reattachChunk (Rebuild) + addVolume (Foam) are the two halves of subsystem B. All solo/authoritative;
    // MP behaviour is a flagged stub (see the destruction/weapons comments + the batch D report).

    // 7a. Foam Cannon — hold LMB sprays pooled blobby projectiles that accrete into a foam grid, hardening
    // ~1.5 s after the last spray into a destructible volume. cell = grid spacing (m); caps bound memory.
    foam: {
      sprayInterval: 0.05, projSpeed: 15, projUp: 2.6, projGravity: 20, projLife: 1.4, projRange: 16,
      cell: 0.3, brush: 1, accreteDist: 0.42, mergeCells: 12,
      hardenDelay: 1.5, maxCells: 600, maxVolumes: 12, maxSoftBlobs: 6,
      projPool: 40, markerPool: 200, softColor: 0xe6eaec,
    },
    // 7b. Rebuild Gun — hold LMB aimed at a damaged volume; detached chunks within `range` of the aim point
    // restore oldest-damage-first at `rate` chunks/s via reattachChunk, each after a brief ghost preview.
    rebuild: {
      range: 5, aimRange: 40, rate: 4, ghostTime: 0.2, maxGhosts: 3, ghostColor: 0x9fe0b0, ghostOpacity: 0.4,
    },
    // 7c. Size Ray — LMB shrink x0.6 / RMB enlarge x1.6 per zap, clamped 0.25x-3x of original. Targets:
    // debris chunks + dynamic props (propane / rc car) ONLY; collider is REPLACED at the new scale (Rapier
    // colliders don't rescale in place), density const => mass ~ scale^3, velocity preserved.
    sizeRay: {
      shrink: 0.6, grow: 1.6, min: 0.25, max: 3.0, range: 40,
      cooldown: 0.5, maxTracked: 20, lerpTime: 0.15,
    },

    viewmodel: {
      baseOffset: { x: 0.28, y: -0.26, z: -0.45 },
      // Batch C held devices: painter/nuke/orbital/airstrike/carcannon/rccar/propane share the base grip.
      blastpainterOffset: { x: 0.24, y: -0.28, z: -0.44 },
      propaneOffset: { x: 0.24, y: -0.30, z: -0.42 },
      nukeOffset: { x: 0.22, y: -0.30, z: -0.40 },
      orbitalOffset: { x: 0.24, y: -0.28, z: -0.44 },
      airstrikeOffset: { x: 0.24, y: -0.28, z: -0.44 },
      carcannonOffset: { x: 0.20, y: -0.30, z: -0.46 },
      rccarOffset: { x: 0.24, y: -0.28, z: -0.42 },
      sledgeOffset: { x: 0.18, y: -0.30, z: -0.5 },
      crowbarOffset: { x: 0.20, y: -0.28, z: -0.5 },
      chainsawOffset: { x: 0.22, y: -0.30, z: -0.42 },
      // Grab & Force family: emitter devices held slightly lower/forward so the muzzle reads.
      gravityOffset: { x: 0.24, y: -0.28, z: -0.44 },
      magnetOffset: { x: 0.24, y: -0.28, z: -0.44 },
      grappleOffset: { x: 0.24, y: -0.28, z: -0.44 },
      windOffset: { x: 0.24, y: -0.28, z: -0.42 },
      vacuumOffset: { x: 0.24, y: -0.28, z: -0.42 },
      // Builders family: emitter devices held slightly lower/forward so the muzzle reads.
      foamOffset: { x: 0.24, y: -0.28, z: -0.42 },
      rebuildOffset: { x: 0.24, y: -0.28, z: -0.44 },
      sizerayOffset: { x: 0.24, y: -0.28, z: -0.44 },
      armsOffset: { x: 0.16, y: -0.34, z: -0.30 },
      armsOffsetSledge: { x: 0.10, y: -0.36, z: -0.34 },
      inwardYaw: -0.08,
      equipTime: 0.18,
      equipDrop: 0.25,
      labelSeconds: 1.5,
      idleBobAmp: 0.006,
      idleBobSpeed: 1.8,
      walkBobAmp: 0.02,
    },
    fx: {
      muzzleFlashTime: 0.05,
      muzzleFlashSize: 0.16,
      muzzleFlashColor: 0xfff0b0,
      tracerPool: 8,
      tracerLife: 0.07,
      tracerThickness: 0.015,
      tracerMaxLen: 12,
      tracerColor: 0xffe08a,
    },
  },
};
