/* global THREE */

/**
 * GlobeRenderer — Three.js 3D Earth with:
 *   - Animated satellite arc (Starlink orbital path)
 *   - Flight path (transatlantic route)
 *   - Satellite beam cone that changes colour by phase
 *   - Smooth auto-rotation
 */

class GlobeRenderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.phase  = "normal";
    this.animId = null;

    this._initScene();
    this._initGlobe();
    this._initFlightPath();
    this._initSatellite();
    this._initBeam();
    this._initStars();
    this._initLights();
    this._bindResize();
    this._animate();
  }

  // ── Scene setup ──────────────────────────────────────────────────────────

  _initScene() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);

    this.scene  = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    this.camera.position.set(0, 0, 3.2);

    this.clock = new THREE.Clock();
    this.t = 0; // playback time
  }

  _initLights() {
    const ambient = new THREE.AmbientLight(0x334466, 0.8);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(5, 3, 5);
    this.scene.add(sun);
  }

  // ── Earth globe ───────────────────────────────────────────────────────────

  _initGlobe() {
    const geo = new THREE.SphereGeometry(1, 64, 64);

    // Procedural ocean + land look using vertex colours approximation
    // We use a simple two-tone material with atmosphere glow
    const mat = new THREE.MeshPhongMaterial({
      color:     0x1a3a6a,   // ocean blue
      emissive:  0x061220,
      shininess: 30,
      specular:  0x224488,
    });

    this.globe = new THREE.Mesh(geo, mat);
    this.scene.add(this.globe);

    // Atmosphere glow ring
    const atmGeo = new THREE.SphereGeometry(1.02, 64, 64);
    const atmMat = new THREE.MeshPhongMaterial({
      color:       0x0088ff,
      transparent: true,
      opacity:     0.06,
      side:        THREE.FrontSide,
    });
    this.scene.add(new THREE.Mesh(atmGeo, atmMat));

    // Wire grid overlay (lat/lon lines)
    const wireGeo = new THREE.SphereGeometry(1.001, 36, 18);
    const wireMat = new THREE.MeshBasicMaterial({
      color:       0x1e4080,
      wireframe:   true,
      transparent: true,
      opacity:     0.12,
    });
    this.scene.add(new THREE.Mesh(wireGeo, wireMat));
  }

  // ── Flight path (NYC → London arc) ───────────────────────────────────────

  _latLonToVec3(lat, lon, r = 1) {
    const phi   = (90 - lat)  * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
       r * Math.cos(phi),
       r * Math.sin(phi) * Math.sin(theta),
    );
  }

  _initFlightPath() {
    // Great circle arc: JFK (40.6, -73.8) → LHR (51.5, -0.5)
    const points = [];
    const start = { lat: 40.6, lon: -73.8 };
    const end   = { lat: 51.5, lon: -0.5  };

    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      const lat = start.lat + (end.lat - start.lat) * t;
      const lon = start.lon + (end.lon - start.lon) * t;
      // Add slight arc height for visual clarity
      const r = 1 + 0.04 * Math.sin(Math.PI * t);
      points.push(this._latLonToVec3(lat, lon, r));
    }

    const curve   = new THREE.CatmullRomCurve3(points);
    const tubeGeo = new THREE.TubeGeometry(curve, 100, 0.003, 6, false);
    const tubeMat = new THREE.MeshBasicMaterial({
      color:       0x38bdf8,
      transparent: true,
      opacity:     0.5,
    });

    this.flightPath = { curve, tube: new THREE.Mesh(tubeGeo, tubeMat) };
    this.scene.add(this.flightPath.tube);

    // Aircraft marker
    const planeGeo = new THREE.SphereGeometry(0.018, 8, 8);
    const planeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.planeMesh = new THREE.Mesh(planeGeo, planeMat);
    this.scene.add(this.planeMesh);
  }

  // ── Satellite ─────────────────────────────────────────────────────────────

  _initSatellite() {
    // Satellite orbit — LEO at ~550km ≈ r=1.086 in scene units
    this.satRadius = 1.2;
    this.satOrbitTilt = 0.9; // radians inclination

    const satGeo = new THREE.BoxGeometry(0.035, 0.01, 0.06);
    const satMat = new THREE.MeshPhongMaterial({ color: 0xaaccff, shininess: 80 });
    this.satMesh = new THREE.Mesh(satGeo, satMat);
    this.scene.add(this.satMesh);

    // Solar panel wings
    const wingGeo = new THREE.BoxGeometry(0.12, 0.003, 0.04);
    const wingMat = new THREE.MeshPhongMaterial({ color: 0x223366, shininess: 40 });
    const wingL = new THREE.Mesh(wingGeo, wingMat);
    const wingR = new THREE.Mesh(wingGeo, wingMat);
    wingL.position.x = -0.08;
    wingR.position.x =  0.08;
    this.satMesh.add(wingL, wingR);

    // Orbit ring (dashed visual reference)
    const orbitPoints = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      orbitPoints.push(new THREE.Vector3(
        Math.cos(a) * this.satRadius,
        Math.sin(a) * this.satRadius * Math.sin(this.satOrbitTilt),
        Math.sin(a) * this.satRadius * Math.cos(this.satOrbitTilt),
      ));
    }
    const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitPoints);
    const orbitMat = new THREE.LineBasicMaterial({
      color: 0x334466, transparent: true, opacity: 0.35,
    });
    this.scene.add(new THREE.Line(orbitGeo, orbitMat));
  }

  // ── Beam cone (satellite → plane) ────────────────────────────────────────

  _initBeam() {
    const beamGeo = new THREE.CylinderGeometry(0.001, 0.06, 0.3, 16, 1, true);
    this.beamMat  = new THREE.MeshBasicMaterial({
      color:       0x38bdf8,
      transparent: true,
      opacity:     0.18,
      side:        THREE.DoubleSide,
    });
    this.beamMesh = new THREE.Mesh(beamGeo, this.beamMat);
    this.scene.add(this.beamMesh);
  }

  // ── Starfield ─────────────────────────────────────────────────────────────

  _initStars() {
    const positions = new Float32Array(3000);
    for (let i = 0; i < 3000; i++) {
      positions[i] = (Math.random() - 0.5) * 20;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.012, transparent: true, opacity: 0.6,
    });
    this.scene.add(new THREE.Points(starGeo, starMat));
  }

  // ── Phase colours ────────────────────────────────────────────────────────

  _phaseColour(phase) {
    return {
      normal:      0x38bdf8,
      degradation: 0xfbbf24,
      outage:      0xf87171,
      recovery:    0x34d399,
    }[phase] || 0x38bdf8;
  }

  // ── Update from demo tick ────────────────────────────────────────────────

  update(frame) {
    this.phase    = frame.phase;
    this.frameTick = frame.tick;
    this.totalTicks = frame.totalTicks || 120;

    // Update beam colour
    this.beamMat.color.setHex(this._phaseColour(frame.phase));
    this.beamMat.opacity = frame.phase === "outage" ? 0.04 : 0.18;
  }

  // ── Animation loop ───────────────────────────────────────────────────────

  _animate() {
    this.animId = requestAnimationFrame(() => this._animate());
    const dt = this.clock.getDelta();
    this.t += dt;

    // Slow globe rotation
    this.globe.rotation.y += 0.0008;

    // Plane progress along flight path (full traverse in 120s of sim time)
    const planeT = (this.t * 0.007) % 1;
    const planePos = this.flightPath.curve.getPoint(planeT);
    this.planeMesh.position.copy(planePos);

    // Satellite orbit
    const satAngle = this.t * 0.35;
    this.satMesh.position.set(
      Math.cos(satAngle) * this.satRadius,
      Math.sin(satAngle) * this.satRadius * Math.sin(this.satOrbitTilt),
      Math.sin(satAngle) * this.satRadius * Math.cos(this.satOrbitTilt),
    );
    this.satMesh.lookAt(0, 0, 0);

    // Beam: position between satellite and plane
    const mid = new THREE.Vector3().lerpVectors(
      this.satMesh.position, this.planeMesh.position, 0.5
    );
    this.beamMesh.position.copy(mid);
    const dir = new THREE.Vector3().subVectors(
      this.satMesh.position, this.planeMesh.position
    );
    this.beamMesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), dir.clone().normalize()
    );
    this.beamMesh.scale.y = dir.length() / 0.3;

    this.renderer.render(this.scene, this.camera);
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  _bindResize() {
    const obs = new ResizeObserver(() => {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    obs.observe(this.canvas);
  }

  destroy() {
    cancelAnimationFrame(this.animId);
  }
}

window.GlobeRenderer = GlobeRenderer;
