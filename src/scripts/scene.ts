import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/* -------------------------------------------------------------------------- */
/*  Paletas de luz: la escena interpola entre "day" y "dusk"                   */
/* -------------------------------------------------------------------------- */
const PRESETS = {
  day: {
    skyTop: '#8ea6f0', skyHorizon: '#f3d6dc', sun: '#fff2e8', sunIntensity: 3.4,
    hemiSky: '#cdd6ff', hemiGround: '#f2c9c6', fog: '#f0d6d9', wall: '#eebcb5', water: '#e7cdd8',
    sunPos: new THREE.Vector3(9, 13, 7), exposure: 1.0,
  },
  dusk: {
    skyTop: '#4f5aa6', skyHorizon: '#f7a99c', sun: '#ffb28a', sunIntensity: 2.8,
    hemiSky: '#7d7fcf', hemiGround: '#d98a86', fog: '#c993a6', wall: '#e0a49c', water: '#b38fb0',
    sunPos: new THREE.Vector3(14, 4.5, 1), exposure: 0.85,
  },
} as const;
type Preset = keyof typeof PRESETS;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */
const noiseGLSL = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
`;

/** Textura de yeso generada en canvas (sin assets externos). */
function plasterTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 200 + Math.random() * 55;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // manchas suaves
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 10 + Math.random() * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = Math.random() * 0.12;
    g.addColorStop(0, `rgba(${Math.random() > 0.5 ? 255 : 150},${Math.random() > 0.5 ? 255 : 150},${Math.random() > 0.5 ? 255 : 150},${a})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Desplaza los vértices de una esfera para obtener una roca orgánica. */
function rockGeometry(seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 6);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n =
      Math.sin(v.x * 3.1 + seed) * Math.cos(v.y * 2.7 - seed) * 0.12 +
      Math.sin(v.z * 6.3 + seed * 2.0) * Math.sin(v.x * 5.1) * 0.05 +
      Math.sin(v.y * 13.0 + v.x * 11.0 + seed) * 0.012;
    v.multiplyScalar(1 + n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Pared extruida con huecos (ventanas o arcos). */
function wallWithHoles(w: [number, number], h: [number, number], holes: THREE.Path[], depth: number, mat: THREE.Material) {
  const s = new THREE.Shape();
  s.moveTo(w[0], h[0]);
  s.lineTo(w[1], h[0]);
  s.lineTo(w[1], h[1]);
  s.lineTo(w[0], h[1]);
  s.closePath();
  s.holes.push(...holes);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 48 });
  // UVs en coordenadas de mundo para que la textura no se estire
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.12, uv.getY(i) * 0.12);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

const rectHole = (x0: number, y0: number, x1: number, y1: number) => {
  const p = new THREE.Path();
  p.moveTo(x0, y0); p.lineTo(x0, y1); p.lineTo(x1, y1); p.lineTo(x1, y0); p.closePath();
  return p;
};

const archHole = (cx: number, y0: number, width: number, springY: number) => {
  const r = width / 2;
  const p = new THREE.Path();
  p.moveTo(cx - r, y0);
  p.lineTo(cx - r, springY);
  p.absarc(cx, springY, r, Math.PI, 0, true);
  p.lineTo(cx + r, y0);
  p.closePath();
  return p;
};

/* -------------------------------------------------------------------------- */
/*  Escena                                                                     */
/* -------------------------------------------------------------------------- */
export function createScene(canvas: HTMLCanvasElement) {
  const isMobile = matchMedia('(max-width: 760px)').matches;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 0.3;

  const state = { preset: 'day' as Preset, mix: 0, mixTarget: 0 };
  const P = PRESETS.day;

  /* ---- cielo ---- */
  const skyUniforms = {
    top: { value: new THREE.Color(P.skyTop) },
    horizon: { value: new THREE.Color(P.skyHorizon) },
    time: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(90, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 horizon; uniform float time; varying vec3 vDir;
        ${noiseGLSL}
        void main(){
          float h = clamp(vDir.y, -0.2, 1.0);
          vec3 col = mix(horizon, top, smoothstep(-0.05, 0.55, h));
          // nubes suaves
          vec2 p = vDir.xz / max(vDir.y + 0.25, 0.08) * 1.4 + vec2(time * 0.01, 0.0);
          float c = noise(p) * 0.6 + noise(p * 2.3) * 0.3 + noise(p * 5.1) * 0.1;
          col = mix(col, vec3(1.0, 0.97, 0.98), smoothstep(0.55, 0.85, c) * smoothstep(0.0, 0.25, h) * 0.55);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  scene.add(sky);

  scene.fog = new THREE.Fog(P.fog, 26, 80);

  /* ---- luces ---- */
  const hemi = new THREE.HemisphereLight(P.hemiSky, P.hemiGround, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(P.sun, P.sunIntensity);
  sun.position.copy(P.sunPos);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(isMobile ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 50 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 6;
  scene.add(sun);

  /* ---- materiales ---- */
  const plaster = plasterTexture();
  const wallMat = new THREE.MeshStandardMaterial({
    color: P.wall, roughness: 0.92, map: plaster, bumpMap: plaster, bumpScale: 1.2,
  });
  const stepMat = new THREE.MeshStandardMaterial({ color: '#f8e3de', roughness: 0.85, map: plaster });

  /* ---- arquitectura ---- */
  // Pared del fondo con dos ventanas (z = -4)
  const back = wallWithHoles([-14, 16], [-1, 12], [rectHole(1.6, 3.2, 3.0, 8.6), rectHole(-1.4, 1.9, -0.55, 4.6)], 0.6, wallMat);
  back.position.z = -4.6;
  scene.add(back);

  // Pared izquierda con arcos que dan a un paisaje exterior
  const left = wallWithHoles(
    [-10, 5],
    [-1, 12],
    [archHole(0.6, -0.5, 1.8, 2.6), archHole(-3.4, -0.5, 2.2, 2.9)],
    0.6,
    wallMat,
  );
  left.rotation.y = Math.PI / 2;
  left.position.x = -4.6;
  scene.add(left);

  // Plataforma / cornisa
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(12, 2.2, 3), wallMat);
  ledge.position.set(5, 0.1, -3.1);
  ledge.castShadow = ledge.receiveShadow = true;
  scene.add(ledge);

  // Escalera
  const steps = 7, stepH = 1.2 / steps, stepD = 0.32;
  for (let i = 0; i < steps; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(2.6, stepH * (i + 1) + 1, stepD), stepMat);
    s.position.set(0.1, (stepH * (i + 1) + 1) / 2 - 1, -1.6 + stepD / 2 + (steps - 1 - i) * stepD);
    s.castShadow = s.receiveShadow = true;
    scene.add(s);
  }

  // Columna rota
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 3.4, 48), stepMat);
  column.position.set(-3.0, 1.0, -2.8);
  column.castShadow = column.receiveShadow = true;
  scene.add(column);

  // Colinas exteriores (vistas a través de los arcos)
  const hillMat = new THREE.MeshStandardMaterial({ color: '#c9a2cf', roughness: 1 });
  [[-16, -6, 7], [-20, 2, 9], [-14, 6, 5]].forEach(([x, z, r]) => {
    const hill = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 24), hillMat);
    hill.scale.y = 0.35;
    hill.position.set(x, -0.5, z);
    scene.add(hill);
  });

  /* ---- esfera iridiscente ---- */
  const orbMat = new THREE.MeshPhysicalMaterial({
    color: '#f4e9f7', metalness: 0.6, roughness: 0.03,
    iridescence: 1, iridescenceIOR: 1.5, iridescenceThicknessRange: [180, 820],
    clearcoat: 1, clearcoatRoughness: 0.05, envMap, envMapIntensity: 1.5,
  });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.75, 96, 64), orbMat);
  orb.position.set(2.4, 2.0, -2.6);
  orb.castShadow = true;
  scene.add(orb);

  /* ---- rocas ---- */
  const rockMat = new THREE.MeshStandardMaterial({ color: '#d9c0ae', roughness: 0.95, bumpMap: plaster, bumpScale: 3 });
  const rocks = [
    { p: [3.8, -0.15, 0.6], s: [1.5, 1.0, 1.2], seed: 1.3 },
    { p: [7.6, -0.3, 1.8], s: [1.9, 1.2, 1.6], seed: 4.1 },
    { p: [-2.2, -0.25, 2.6], s: [0.7, 0.5, 0.6], seed: 2.2 },
  ].map(({ p, s, seed }) => {
    const r = new THREE.Mesh(rockGeometry(seed), rockMat);
    r.position.set(p[0], p[1], p[2]);
    r.scale.set(s[0], s[1], s[2]);
    r.rotation.y = seed;
    r.castShadow = r.receiveShadow = true;
    scene.add(r);
    return r;
  });

  /* ---- agua reflectante con ondas interactivas ---- */
  const MAX_RIPPLES = 10;
  const waterShader = {
    name: 'PastelWater',
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      time: { value: 0 },
      ripples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -100, 0)) },
      fogColor: { value: new THREE.Color(P.fog) },
    },
    vertexShader: /* glsl */ `
      uniform mat4 textureMatrix;
      varying vec4 vUv;
      varying vec3 vWorld;
      void main(){
        vUv = textureMatrix * vec4(position, 1.0);
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color; uniform sampler2D tDiffuse; uniform float time;
      uniform vec4 ripples[${MAX_RIPPLES}]; uniform vec3 fogColor;
      varying vec4 vUv; varying vec3 vWorld;
      ${noiseGLSL}
      void main(){
        vec2 p = vWorld.xz;
        float n1 = noise(p * vec2(0.5, 2.4) + vec2(time * 0.12, time * 0.45));
        float n2 = noise(p * vec2(0.9, 2.6) - vec2(time * 0.2, time * 0.6));
        vec2 dist = vec2(n1 - 0.5, n2 - 0.5) * 0.018;

        float rip = 0.0;
        for (int i = 0; i < ${MAX_RIPPLES}; i++) {
          vec4 r = ripples[i];
          float age = time - r.z;
          if (age < 0.0 || age > 6.0) continue;
          float d = distance(p, r.xy);
          float front = age * 2.2;
          float w = sin((d - front) * 9.0) * exp(-pow(d - front, 2.0) * 2.0) * exp(-age * 0.8) * r.w;
          rip += w;
          dist += normalize(p - r.xy + 1e-4) * w * 0.08;
        }

        vec4 uv = vUv;
        uv.xy += dist * uv.w;
        vec3 refl = texture2DProj(tDiffuse, uv).rgb;
        vec3 col = mix(color, refl, 0.78);
        col += vec3(1.0, 0.96, 1.0) * (smoothstep(0.62, 0.95, n2) * 0.06 + max(rip, 0.0) * 0.12);
        float fogF = smoothstep(24.0, 75.0, length(vWorld - cameraPosition));
        col = mix(col, fogColor, fogF);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  };
  const waterRes = isMobile ? 512 : 1024;
  const water = new Reflector(new THREE.PlaneGeometry(120, 120), {
    color: new THREE.Color(P.water),
    textureWidth: waterRes,
    textureHeight: waterRes,
    clipBias: 0.003,
    shader: waterShader,
  });
  water.rotation.x = -Math.PI / 2;
  scene.add(water);
  const waterU = (water.material as THREE.ShaderMaterial).uniforms;

  /* ---- partículas de polvo ---- */
  const dustCount = isMobile ? 120 : 260;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 18;
    dustPos[i * 3 + 1] = Math.random() * 7;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 12;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({ color: '#fff6f2', size: 0.035, transparent: true, opacity: 0.8, depthWrite: false }),
  );
  scene.add(dust);

  /* ---- post-procesado ---- */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.5, 0.94);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const finalPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, time: { value: 0 }, strength: { value: 1 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse; uniform float time; uniform float strength; varying vec2 vUv;
      float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        vec2 dir = vUv - 0.5;
        float d = length(dir);
        vec2 off = dir * d * 0.012 * strength;
        vec3 col;
        col.r = texture2D(tDiffuse, vUv + off).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - off).b;
        col *= 1.0 - smoothstep(0.45, 0.95, d) * 0.28;          // viñeta
        col += (rand(vUv * 1000.0 + fract(time)) - 0.5) * 0.045; // grano
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  composer.addPass(finalPass);

  /* ---- interacción ---- */
  const pointer = new THREE.Vector2();
  const pointerSmooth = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  let rippleIndex = 0;
  let lastTrail = 0;
  let orbHover = false;
  let orbKick = 0;
  let orbSpin = 0;
  let scrollP = 0;
  const timer = new THREE.Timer();
  let now = 0;

  const addRipple = (x: number, z: number, strength: number) => {
    waterU.ripples.value[rippleIndex].set(x, z, now, strength);
    rippleIndex = (rippleIndex + 1) % MAX_RIPPLES;
  };

  const updatePointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  };

  const onMove = (e: PointerEvent) => {
    updatePointer(e);
    orbHover = raycaster.intersectObject(orb).length > 0;
    document.body.classList.toggle('cursor-grab', orbHover);
    // estela suave sobre el agua
    if (now - lastTrail > 0.28 && raycaster.ray.intersectPlane(waterPlane, hit) && hit.z > -1.4) {
      const blocked = raycaster.intersectObjects([...rocks, ledge], false)[0];
      if (!blocked || blocked.distance > raycaster.ray.origin.distanceTo(hit)) {
        addRipple(hit.x, hit.z, 0.35);
        lastTrail = now;
      }
    }
  };

  const onDown = (e: PointerEvent) => {
    updatePointer(e);
    if (raycaster.intersectObject(orb).length) {
      orbKick = 1;
      orbSpin += Math.PI * 2;
      addRipple(orb.position.x, -1.2, 0.8);
      return;
    }
    if (raycaster.ray.intersectPlane(waterPlane, hit)) addRipple(hit.x, hit.z, 1.0);
  };

  addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);

  /* ---- resize ---- */
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w, h);
    camera.aspect = w / h;
    // en pantallas verticales: más campo de visión y cámara más atrás
    const portrait = camera.aspect < 1;
    camera.fov = portrait ? 52 : 38;
    camBase.set(portrait ? 1.6 : 0.8, portrait ? 2.6 : 2.3, portrait ? 15 : 11);
    camStart.set(camBase.x, 4.5, camBase.z + 6);
    camera.updateProjectionMatrix();
  };
  const camBase = new THREE.Vector3();
  const camStart = new THREE.Vector3();
  new ResizeObserver(resize).observe(canvas);
  resize();

  /* ---- loop ---- */
  const lookAt = new THREE.Vector3(1.2, 2.4, -2.5);
  const tmpColor = new THREE.Color();
  const lerpC = (target: THREE.Color, a: string, b: string, t: number) => target.set(a).lerp(tmpColor.set(b), t);
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(canvas);

  const tick = () => {
    requestAnimationFrame(tick);
    if (!visible) return;
    timer.update();
    const t = (now = timer.getElapsed());

    // intro: la cámara se acerca y la exposición sube
    const intro = reduced ? 1 : 1 - Math.pow(1 - Math.min(t / 3.2, 1), 3);
    renderer.toneMappingExposure =
      THREE.MathUtils.lerp(PRESETS.day.exposure, PRESETS.dusk.exposure, state.mix) * Math.min(t / 1.6, 1);

    pointerSmooth.lerp(pointer, 0.05);
    camera.position.lerpVectors(camStart, camBase, intro);
    camera.position.x += pointerSmooth.x * 0.9;
    camera.position.y += pointerSmooth.y * 0.4 + scrollP * 1.5;
    camera.position.z -= scrollP * 4;
    camera.lookAt(lookAt.x + pointerSmooth.x * 0.3, lookAt.y + scrollP * 0.6, lookAt.z);

    // paleta día ↔ atardecer
    state.mix += (state.mixTarget - state.mix) * Math.min(timer.getDelta() * 1.8, 1);
    const m = state.mix, A = PRESETS.day, B = PRESETS.dusk;
    lerpC(skyUniforms.top.value, A.skyTop, B.skyTop, m);
    lerpC(skyUniforms.horizon.value, A.skyHorizon, B.skyHorizon, m);
    lerpC(sun.color, A.sun, B.sun, m);
    lerpC(hemi.color, A.hemiSky, B.hemiSky, m);
    lerpC(hemi.groundColor, A.hemiGround, B.hemiGround, m);
    lerpC((scene.fog as THREE.Fog).color, A.fog, B.fog, m);
    lerpC(waterU.fogColor.value, A.fog, B.fog, m);
    lerpC(wallMat.color, A.wall, B.wall, m);
    lerpC(waterU.color.value, A.water, B.water, m);
    sun.intensity = THREE.MathUtils.lerp(A.sunIntensity, B.sunIntensity, m);
    sun.position.lerpVectors(A.sunPos, B.sunPos, m);

    // esfera: flota, sigue al puntero, reacciona al click
    orbKick *= 0.94;
    const hoverScale = orbHover ? 1.06 : 1;
    orb.scale.setScalar(THREE.MathUtils.lerp(orb.scale.x, hoverScale + orbKick * 0.15, 0.1));
    orb.position.y = 2.0 + Math.sin(t * 0.9) * 0.08 + Math.sin(orbKick * Math.PI) * 0.6;
    orb.rotation.y += (orbSpin - orb.rotation.y) * 0.04 + 0.002;
    orb.rotation.x = pointerSmooth.y * 0.6;
    orbMat.iridescenceThicknessRange[1] = 820 + Math.sin(t * 0.6) * 180 + orbKick * 400;

    // polvo
    const arr = dustGeo.attributes.position.array as Float32Array;
    for (let i = 0; i < dustCount; i++) {
      arr[i * 3 + 1] += 0.0025 + Math.sin(t + i) * 0.0008;
      arr[i * 3] += Math.sin(t * 0.3 + i) * 0.0015;
      if (arr[i * 3 + 1] > 7) arr[i * 3 + 1] = 0.2;
    }
    dustGeo.attributes.position.needsUpdate = true;

    skyUniforms.time.value = t;
    waterU.time.value = t;
    finalPass.uniforms.time.value = t;
    composer.render();
  };
  tick();

  return {
    setPreset(p: Preset) {
      state.preset = p;
      state.mixTarget = p === 'dusk' ? 1 : 0;
    },
    get preset() {
      return state.preset;
    },
    setScroll(p: number) {
      scrollP = p;
    },
  };
}
