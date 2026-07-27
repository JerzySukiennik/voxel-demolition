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
    // skinThickness is the NOMINAL ground surface Y. Every building base, prop, spawn point and parked
    // vehicle is placed against it, so it stays 0.3 no matter how deep the diggable ground gets.
    skinThickness: 0.3,
    skinVoxel: 0.3,
    structureVoxel: 0.15,

    // ---- Deep diggable ground (terrain rework) ---------------------------------------------------
    // The ground used to be ONE 0.3 m destructible skin on an indestructible core whose top was y=0:
    // one layer and you hit bedrock. It is now two stacked "grid" strata, depth-graded so the chunk
    // count stays affordable (see maps/lib.js groundVolumes):
    //   topsoil  — skinVoxel 0.3, fine chunks, carries the hills + the road/patch colours
    //   subsoil  — subsoilVoxel 0.8, coarse chunks, ~19x fewer cells per m^3 and a sixth of the chunks
    // The indestructible core drops to bedrockY = skinThickness - groundDepth and becomes the floor of
    // any mine shaft. groundDepth is the destructible thickness under flat ground; under a hill you dig
    // through the hill on top of that.
    groundDepth: 3.0,
    topsoilDepth: 0.6,        // metres of 0.3 m voxels under the surface before the coarse stratum
    subsoilVoxel: 0.8,
    subsoilColor: "#6b5b45",  // upper subsoil band (packed earth)
    subsoilDeepColor: "#5b5348", // lowest subsoil band, reads as the approach to bedrock
    bedrockColor: "#585c60",  // the indestructible core layer: the floor of the world / of a mine

    // ---- Rolling hills ----------------------------------------------------------------------------
    // Deterministic seeded value noise (mulberry32 keyed by mapId), evaluated per ground column. The
    // field is UP-ONLY: h >= 0 above skinThickness, never below, so nothing that was placed on the flat
    // surface can end up floating. Built-up ground stays dead flat: every structure/prop footprint (and
    // every road patch / spawn pad a map declares) forces h = 0 and the terrain blends back to full
    // hills over flatBlend metres.
    // Slope discipline matters: grid chunks get an AABB collider, so a chunk whose columns differ by
    // more than one 0.3 m voxel would let the player stand a visible step above the mesh. height/cell
    // are tuned so the field climbs at most ~0.12 m per metre => under one voxel per chunk footprint.
    hills: {
      height: 1.5,        // max metres above skinThickness
      cell: 34,           // metres per lattice cell, octave 1 (the broad swells)
      octave2: 0.35,      // relative amplitude of octave 2 (the surface texture)
      octave2Cell: 14,
      gain: 0.9,          // noise -> [0,1] is clamp01(0.5 + gain*n): >0.5 of open ground sits raised
      flatMargin: 1.2,    // dead-flat apron kept around every graded footprint
      flatBlend: 3.0,     // metres to ramp (linearly) from flat back to the full field. Short on purpose:
                          // slopeLimit() below turns whatever is left into a 0.3 m-per-cell staircase, so
                          // the mask does not have to buy the grading with a long, hill-eating blend
      flatMaxY: 2.5,      // specs based above this do NOT grade the ground (roofs, decks, foliage)
      edgeFlat: 0,        // the border berm is bedrock-founded and does not care how high the ground under
                          // it sits, so the hills are allowed to roll all the way to the map edge
      liftMax: 4.2,       // footprints up to this (2 chunk cells) are LIFTED onto the terrain, not graded
      contactY: 0.5,      // a lifted spec based at/below this is ground-contacting; above it it follows
      maskRes: 1.0,       // metres per cell of the precomputed flatness mask (bilinear sampled)
    },

    // ---- Indestructible map borders ---------------------------------------------------------------
    // A stepped embankment at all four map edges, built as fixed core geometry in world.js
    // (buildStaticGeo, `{ type: "border" }`): never destructible, never an allowedImpactor, zero chunks.
    // `height` is the VISIBLE berm; `wallHeight` is an extra invisible clearance above it so a car at
    // full speed, a Car Cannon round or a low pass in the hover/heli cannot leave the map.
    border: {
      width: 2.5,
      height: 3.2,
      steps: 4,
      voxel: 0.5,
      wallHeight: 12,
      wallThickness: 0.6,
      color: "#8d7d66",
    },
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
    fogNear: 32,
    fogFar: 112,
    groundColor: "#8a8d90",
    // Water plane (world.createWater). Low roughness + the sky IBL = a real reflection of the dome.
    waterColor: 0x27423f,
    waterRoughness: 0.06,
    waterMetalness: 0.1,
    waterEnvIntensity: 1.0,
  },

  render: {
    pixelRatioCap: 2,
    // ACES filmic + a touch of exposure: highlights roll off instead of clipping to white, which is what
    // lets the sun intensity go up without the pale materials blowing out. Retuned light rig below.
    toneMappingExposure: 0.98,
    shadowMapSize: 2048,
    shadowBoxHalf: 24,
    // Tight near/far around the slab the follow box can contain -> more depth precision -> a much smaller
    // bias, so contact shadows stay welded to their caster instead of peter-panning.
    shadowNear: 12,
    shadowFar: 110,
    shadowBias: -0.00018,
    shadowNormalBias: 0.022,
    // Warm sun against cool sky fill: the split is what gives a voxel scene its depth once the
    // highlights stop clipping. Previously 0xfff2df / 2.2 against a flat 0.5 hemisphere.
    sunColor: 0xffefcf,
    sunDistance: 60,
    sunIntensity: 3.2,
    sunElevationDeg: 44,
    sunAzimuthDeg: 40,
    // The procedural sky IBL (scene.environment) now supplies most of the directional ambient, so the
    // hemisphere light is only a small, deliberately blue extra fill.
    hemiIntensity: 0.11,
    hemiSky: 0xa6c8f0,
    hemiGround: 0x6b6f5f,

    // Gradient sky dome + the equirect IBL baked from it (world.js). Every value is derived from the
    // map's own env palette, so per-map skyColor/fogColor/groundColor overrides keep working.
    sky: {
      enabled: true,            // off = flat background colour + no IBL (the old look)
      radius: 360,              // < camera.far (400); maps are <= 96 m so the camera never leaves it
      zenithSat: 0.16,          // HSL offsets applied to env.skyColor to get the zenith
      zenithLight: -0.14,
      horizonPow: 0.35,         // < 1 = the horizon band stays low and the blue climbs fast
      groundMix: 0.55,          // below-horizon haze = groundColor mixed this far toward fogColor
      groundDim: 0.72,
      groundBlend: 0.35,        // how many units of -dir.y it takes to reach that haze
      haze: 0.05,               // narrow warm band hugging the horizon (higher = milkier sky)
      hazePow: 9.0,
      sunGlow: 0.40,            // tight bloom-ish glow around the sun direction
      sunGlowPow: 22.0,
      envWidth: 64,             // equirect IBL source size (PMREM-filtered once by three)
      envHeight: 32,
    },
  },

  voxel: {
    jitterLightness: 0.04,
    jitterBuckets: 6,
    shinyMetalnessCutoff: 0.1,
    // envMapIntensity feeds off scene.environment (the sky IBL). Rough surfaces take a moderate dose as
    // sky ambient; shiny ones take the full amount so metal/glass mirror the dome.
    roughMat: { roughness: 0.82, metalness: 0.0, envMapIntensity: 0.34 },
    shinyMat: { roughness: 0.28, metalness: 0.45, envMapIntensity: 1.0 },
    // Baked per-voxel ambient occlusion (voxel.js buildGeometry). Costs nothing per frame. It is also
    // free in triangles here: the per-voxel jitter bucket is already in the merge key, so the mesher
    // never merged across neighbouring voxels anyway and adding AO to that key changes no counts
    // (verified: identical totals on all four maps and every model, AO on vs off). It costs ~10% of
    // mesh-build time; drop ringWeights to [1] to halve that if load time ever needs it back.
    //   strength    - how dark a fully-enclosed vertex gets (LINEAR vertex-colour multiplier 1-strength)
    //   curve       - >1 keeps light contact soft and only bites in deep corners
    //   ringWeights - how far out, in voxels, the occluders are sampled. Voxels are 0.15 m, so one ring
    //                 alone is a 15 cm hairline; the second ring at half weight spreads the crease to
    //                 ~0.3 m, which is the scale that actually reads as contact shading in play.
    ao: {
      enabled: true,
      strength: 0.62,
      curve: 1.15,
      ringWeights: [1, 0.5],
    },
  },

  destruction: {
    // Ground chunking is DEPTH-GRADED (see world.groundDepth). chunkSizeSkin now only applies to the
    // topsoil, where digging actually happens, and came down 3.0 -> 2.4 m: a 2.4 m footprint is 1.56x
    // more pieces per square metre than the old 3 m slab. The subsoil is deliberately coarse — a 6.0 m
    // block at a 0.8 m voxel — which is what keeps the extra 3 m of depth affordable (a sixth of the
    // chunks per layer of the topsoil). Arithmetic on town (72x72 m): topsoil ceil(72/2.4)^2 = 900,
    // subsoil ceil(72/6.0)^2 = 144, total 1044 grid chunks against 576 for the old single flat skin —
    // 3 m of depth and a finer surface for +468. All four maps stay under the 2500 gate.
    chunkSizeSkin: 2.4,
    chunkSizeSubsoil: 6.0,
    chunkSizeProp: 0.6,
    // Foliage blobs and window glass were by far the most chunk-hungry things per cubic metre on the map
    // (a leaf crown at 1.4 m was ~18 chunks, a shop window at 0.5 m ~20). Coarsening them pays most of the
    // bill for the deep diggable ground; at these sizes a crown still bursts into 8 clumps and a pane into
    // 9 shards, which is indistinguishable in play. See the terrain report.
    chunkSizeFoliage: 2.0,
    // A fence is a 0.12 m lattice of posts and rails; at 1.1-1.3 m it shattered into more pieces than the
    // house behind it. 2.0 m is one bay between posts, which is how a fence should come apart anyway.
    chunkSizeFence: 2.0,
    tileMeters: 8,
    // Ground tile sizes are tuned so the two strata together mesh into far FEWER tiles (= fewer draw
    // calls) than the single 8 m-tiled skin they replace: town 36 + 9 = 45 against 81 before, which is
    // what pays for the border meshes and keeps the frame inside the <300 draw-call gate. A bigger tile
    // costs more only in the empty-cell scan of a re-mesh (face emission tracks surface area, not tile
    // size), and a detached chunk now touches fewer tiles, so per-dig cost comes out about even.
    tileMetersTopsoil: 12,
    tileMetersSubsoil: 24,
    debrisCap: 200,
    debrisSleepCullSeconds: 20,
    debrisSleepCullMin: 100,
    fadeSeconds: 0.3,
    detachKick: 0.5,
    neighborDetachMultiplier: 2.0,
    // Vehicle ramming feel: buildings should be very fragile to vehicles (drive through a house or two on
    // the loose) WITHOUT changing weapon or on-foot-player balance. Only handles tagged `heavy` (vehicles +
    // Car Cannon) get these; the player capsule stays a normal impactor so walking never breaks walls.
    // Low floor on purpose: a wall has to give way on the FIRST light touch, otherwise the car spends its
    // whole momentum on one immovable step of contact and stops dead instead of ploughing through.
    vehicleEventFloor: 600,
    vehicleImpactForceMult: 18,     // heavy-impactor contact force is multiplied before the threshold gate
    // A resting or slowly-rolling car pushes on the ground hard enough to clear even the skin threshold
    // once multiplied, so without a speed gate it shredded the road it was driving on and then fell into
    // its own holes (which is what launched it into the air). Ramming has to be a RAM: below this speed a
    // heavy impactor detaches nothing at all.
    vehicleMinRamSpeed: 5.0,        // m/s (~18 km/h)
    // Contact-driven detach alone can never plough: Rapier resolves the collision against the still-solid
    // wall in the SAME step, so the car's momentum is gone before the chunks come loose. A vehicle above
    // the ram speed therefore sweeps a small volume just ahead of its nose every step, so it meets an
    // opening instead of a wall. Structures only - the ground is excluded.
    vehicleSweepRadius: 2.0,        // m, roughly the width of a car
    vehicleSweepLead: 2.6,          // m ahead of the body centre
    vehicleSweepForce: 30000,       // clears every structure threshold; feeds the normal detach kick
    vehicleSweepBudget: 24,         // chunks per vehicle per step
    vehiclePunchRadius: 4.0,        // each vehicle contact carves this radius -> an ~8 m tunnel, wide enough to swallow whole rooms
    vehiclePunchBudget: 120,        // max chunks detached per punch (perf cap; tile rebuilds are batched so this stays cheap)
    vehiclePunchLead: 3.0,          // punch centre is pushed this far along the vehicle's travel direction, so the hole opens AHEAD and momentum survives
    vehiclePunchKick: 3.0,          // punched rubble gets this much extra impulse -> it is hurled clear instead of piling up in front of the car
    // Rubble knocked out by a ram is re-densitied to this (kg/m^3) for the rest of its life. Without it a
    // ploughing car meets tonnes of full-density chunks and stops dead after one wall; at ~60 it bats the
    // wreckage aside and keeps going. Looks identical — only the mass changes. Weapon debris is untouched.
    vehicleDebrisDensity: 60,
    // Phase 1 props (skin/wall/crate/shed) unchanged. Phase 4 map materials appended (brief section 4).
    // Phase 7 batch D: `foam` = the constructive-voxel material sprayed by the Foam Cannon — light density,
    // low-ish threshold so every weapon breaks it through the normal pipeline, yet high enough to stand/drive on.
    // `subsoil` = the coarse deep ground stratum: heavier and tougher than topsoil, so a mine shaft is
    // real work (a shotgun cannot dig; explosives and the heavy strikes can).
    density: { skin: 1600, wall: 1400, crate: 350, shed: 700, brick: 1400, concrete: 2000, wood: 600, plank: 600, roofWood: 600, roofTile: 900, metal: 1200, glass: 250, sand: 1600, rock: 2200, foam: 120, subsoil: 1900 },
    forceThreshold: { skin: 9000, wall: 5000, shed: 5000, crate: 1500, brick: 5000, concrete: 8000, wood: 3000, plank: 3000, roofWood: 3000, roofTile: 4000, metal: 6000, glass: 800, sand: 9000, rock: 14000, foam: 2200, subsoil: 12000 },
    // Chunk sizes tuned UP from the section-4 starting values so map-scale chunk totals clear the
    // <=2500 gate on the Radeon 5500M (voxel size is fixed at 0.15). Chunkier pieces also match the
    // brief's "fewer pieces over fine dust" directive. Deviation documented in the phase report.
    matChunkSize: { brick: 1.1, concrete: 1.4, wood: 1.1, plank: 1.1, roofWood: 1.7, roofTile: 1.7, metal: 1.6, glass: 0.85, sand: 3.0, rock: 1.4, foam: 0.6 },
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
    // upright*: PD self-levelling gains (hover.js _applyUpright). The thruster springs only push +Y, so
    // once the craft passes vertical they have no authority to bring it back and it could fly inverted.
    // uprightK/uprightDamp are an angular acceleration spring (rad/s^2 per rad / per rad/s) on the tilt of
    // the body up-vector; uprightFree is a dead band that leaves small leans alone so it still banks;
    // past uprightHardTilt the gain is multiplied by uprightHardMult so a flipped craft snaps back fast.
    hover: { mass: 1300, colliderHalf: { x: 1.0, y: 0.5, z: 2.2 }, colliderCenterY: 0.75, spawnBodyY: 0.10, linearDamping: 0.4, angularDamping: 2.5, hoverHeight: 1.1, hoverMin: 0.7, hoverMax: 6.0, hoverSpringK: 14, hoverDamperC: 5, altRate: 2.5, thrustAccel: 12, yawRate: 1.8, latDamp: 3, glowSize: { x: 2.2, z: 4.2 }, uprightK: 9, uprightDamp: 5.5, uprightFree: 0.20, uprightHardTilt: 1.05, uprightHardMult: 3.5 },

    // Helicopter. Collective + cyclic + pedals.
    // Flown with an assist, not simulated: strong self-levelling, gentle cyclic, and liftAssist blends the
    // rotor thrust toward world-up so banking no longer drops you out of the sky (the main reason the
    // stock helicopter was unflyable). liftAssist 0 = pure body-up (realistic), 1 = always straight up.
    heli: { mass: 4500, colliderHalf: { x: 1.2, y: 1.2, z: 4.5 }, colliderCenterY: 1.5, spawnBodyY: 0.20, linearDamping: 0.6, angularDamping: 4.0, collectiveNeutral: 0.55, collectiveRate: 0.8, thrustMaxG: 1.5, pitchTorqueK: 0.9, rollTorqueK: 0.8, yawTorqueK: 0.9, autoLevel: 2.6, liftAssist: 0.7, moveAccel: 7.0, rotorMainSpeed: 18, rotorTailSpeed: 40 },

    // Fixed-wing airplane. Throttle + pitch/roll/rudder; needs airspeed for lift.
    // Forgiving arcade flight: more thrust, lift from a lower airspeed (short runways), calmer roll and a
    // much stronger self-levelling spring so letting go of the stick recovers instead of spiralling.
    plane: { mass: 1400, colliderHalf: { x: 1.0, y: 0.8, z: 3.6 }, colliderCenterY: 1.1, spawnBodyY: 0.10, linearDamping: 0.0, angularDamping: 2.2, thrustMaxK: 13, vRef: 17, vStall: 8, dragK: 0.03, autoLevel: 2.6, throttleRate: 0.7, pitchTorqueK: 0.9, rollTorqueK: 1.2, yawTorqueK: 0.7, propSpeedBase: 10, propSpeedMax: 50, gearSpringK: 30000, gearDamperC: 4000, gearWheelRadius: 0.25, gearRest: 0.25, gearMaxTravel: 0.12 },
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
      // Uniform shrink of the held-tool group. The HD tool models are modelled at true real-world size,
      // which at a 70-degree FOV puts a rocket launcher across a third of the screen and hides what you
      // are aiming at. Scaling the group (not the offsets) pulls the weapon back toward the hand.
      // _muzzleWorld scales muzzleLen by the same factor so projectiles still leave the visible barrel.
      scale: 0.40,
      // Absolute per-tool override for the bulkiest models, which still filled a corner at the global
      // scale. Car Cannon is a deliberately absurd wide-bore cannon and needs the most taming.
      scaleById: {
        carcannon: 0.26, rocketLauncher: 0.32, clusterlauncher: 0.32, stickylauncher: 0.34,
        foamcannon: 0.32, windcannon: 0.32, vacuum: 0.34, nuke: 0.30, gravitygun: 0.34,
        magnetgun: 0.34, chainsaw: 0.34, sledgehammer: 0.36,
      },
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
