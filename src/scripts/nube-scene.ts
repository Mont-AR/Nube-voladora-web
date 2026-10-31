import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/* -------------------------------------------------------------------------- */
/*  Paleta (tomada de montivero.ar)                                            */
/* -------------------------------------------------------------------------- */
export const PALETTE = {
  ink: '#071139',
  night: '#0d0a3d',
  indigo: '#120d50',
  violet: '#43105f',
  lavender: '#b48cff',
  magenta: '#e42a9b',
  rose: '#ed7e93',
  coral: '#f6a57e',
  peach: '#ffb77e',
  gold: '#fff1b0',
  cream: '#fff6d9',
  cyan: '#61f7e7',
  mint: '#e8fffb',
};
const C = (hex: string) => ({ value: new THREE.Color(hex) });

export const CHANNELS = [
  { id: 'edicion', name: 'EDICION', glow: PALETTE.cyan },
  { id: 'motion', name: 'MOTION', glow: PALETTE.magenta },
  { id: 'redes', name: 'REDES', glow: PALETTE.coral },
  { id: 'color', name: 'COLOR', glow: PALETTE.lavender },
] as const;

/* -------------------------------------------------------------------------- */
/*  GLSL compartido                                                            */
/* -------------------------------------------------------------------------- */
const NOISE = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p){
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
  }
  float riverX(float z){ return sin(z * 0.045) * 4.0 + sin(z * 0.013 + 1.3) * 6.0; }
`;

const BASIC_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/* -------------------------------------------------------------------------- */
/*  Texturas generadas en canvas                                               */
/* -------------------------------------------------------------------------- */
function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function softDotTexture() {
  return canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

/* -------------------------------------------------------------------------- */
/*  Escena                                                                     */
/* -------------------------------------------------------------------------- */
export function createNubeScene(canvas: HTMLCanvasElement) {
  const isSmall = matchMedia('(max-width: 760px)').matches;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isSmall ? 1.5 : 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.25;

  const timer = new THREE.Timer();
  let now = 0;
  let t0 = 0;
  const sunDir = new THREE.Vector3(0, 0.12, -1).normalize();

  /* ---------------- cielo con nubes pixeladas ---------------- */
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      cHorizon: C(PALETTE.peach), cLow: C(PALETTE.magenta), cMid: C(PALETTE.violet), cTop: C(PALETTE.ink),
      cCloudA: C(PALETTE.magenta), cCloudB: C(PALETTE.rose),
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 cHorizon, cLow, cMid, cTop, cCloudA, cCloudB;
      varying vec3 vDir;
      ${NOISE}
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(cHorizon, cLow, smoothstep(-0.02, 0.08, h));
        col = mix(col, cMid, smoothstep(0.06, 0.24, h));
        col = mix(col, cTop, smoothstep(0.2, 0.55, h));
        // nubes suaves y alargadas, iluminadas desde abajo por el sol
        vec2 p = d.xz / (h + 0.18);
        p.x += uTime * 0.006;
        float c = fbm(p * vec2(0.9, 2.4) + fbm(p * 1.7) * 0.6);
        float band = smoothstep(0.02, 0.08, h) * (1.0 - smoothstep(0.22, 0.4, h));
        float dens = smoothstep(0.48, 0.72, c) * band;
        float lit = smoothstep(0.35, 0.0, h) * (0.6 + 0.4 * max(-d.z, 0.0));
        vec3 cloud = mix(cCloudA, cCloudB, lit);
        cloud = mix(cloud, cHorizon, lit * smoothstep(0.62, 0.8, c) * 0.5);
        col = mix(col, cloud, dens * 0.8);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(200, 48, 24), skyMat));

  /* ---------------- estrellas ---------------- */
  const starCount = 1400;
  const starPos = new Float32Array(starCount * 3);
  const starSeed = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const u = Math.random() * Math.PI * 2;
    const y = 0.12 + Math.pow(Math.random(), 0.7) * 0.88;
    const r = Math.sqrt(1 - y * y);
    starPos.set([Math.cos(u) * r * 180, y * 180, Math.sin(u) * r * 180], i * 3);
    starSeed[i] = Math.random();
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('seed', new THREE.BufferAttribute(starSeed, 1));
  const starMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPR: { value: renderer.getPixelRatio() }, cA: C(PALETTE.cream), cB: C(PALETTE.cyan), cC: C(PALETTE.lavender) },
    vertexShader: /* glsl */ `
      attribute float seed; uniform float uTime; uniform float uPR; varying float vA; varying float vSeed;
      void main(){
        vSeed = seed;
        float tw = 0.55 + 0.45 * sin(uTime * (1.0 + seed * 3.0) + seed * 40.0);
        vA = tw * smoothstep(0.1, 0.35, normalize(position).y);
        gl_PointSize = (seed > 0.97 ? 4.5 : 1.2 + seed * 1.8) * uPR;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 cA, cB, cC; varying float vA; varying float vSeed;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        vec3 col = vSeed < 0.6 ? cA : (vSeed < 0.85 ? cC : cB);
        gl_FragColor = vec4(col * 1.4, a * vA);
      }`,
  });
  scene.add(new THREE.Points(starGeo, starMat));

  /* ---------------- sol synthwave ---------------- */
  const sunMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, cTop: C(PALETTE.gold), cMid: C(PALETTE.peach), cBot: C(PALETTE.magenta) },
    vertexShader: BASIC_VERT,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 cTop, cMid, cBot; varying vec2 vUv;
      void main(){
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p) / 0.62;
        float disk = 1.0 - smoothstep(0.985, 1.0, r);
        float y = p.y / 0.62;
        vec3 col = mix(cBot, cMid, smoothstep(-1.0, 0.1, y));
        col = mix(col, cTop, smoothstep(0.1, 0.9, y));
        // franjas horizontales que bajan
        if (y < 0.15) {
          float s = fract(y * 7.0 + uTime * 0.12);
          float gap = mix(0.06, 0.55, clamp(-y * 0.9 + 0.1, 0.0, 1.0));
          disk *= step(gap, s);
        }
        float halo = exp(-max(r - 1.0, 0.0) * 3.2) * 0.55 * (1.0 - disk);
        gl_FragColor = vec4(col * 1.6 * disk + cBot * halo, max(disk, halo));
      }`,
  });
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), sunMat);
  sun.position.set(0, 9, -150);
  scene.add(sun);

  /* ---------------- terreno infinito (vuelo) ---------------- */
  const terrainSegZ = isSmall ? 110 : 170;
  const terrainStep = 170 / terrainSegZ; // distancia entre vértices en z
  const terrainGeo = new THREE.PlaneGeometry(220, 170, isSmall ? 140 : 220, terrainSegZ);
  terrainGeo.rotateX(-Math.PI / 2);
  terrainGeo.translate(0, 0, -62);
  const terrainMat = new THREE.ShaderMaterial({
    uniforms: {
      uOffset: { value: 0 }, uShift: { value: 0 }, uTime: { value: 0 }, uSunDir: { value: sunDir },
      cLow: C(PALETTE.indigo), cMid: C(PALETTE.violet), cHigh: C('#6b3fa8'), cSnow: C(PALETTE.lavender),
      cRim: C(PALETTE.magenta), cCyan: C(PALETTE.cyan),
      cCity: C(PALETTE.peach), cFogLow: C(PALETTE.rose), cFogHigh: C(PALETTE.magenta),
    },
    vertexShader: /* glsl */ `
      uniform float uOffset; uniform float uShift;
      varying vec3 vWorld; varying vec2 vQ; varying float vH; varying float vValley;
      ${NOISE}
      void main(){
        vec3 p = position;
        vec2 q = vec2(p.x, p.z - uOffset);
        float d = abs(p.x - riverX(q.y));
        float valley = smoothstep(3.0, 24.0, d);
        float far = smoothstep(-15.0, -100.0, p.z + uShift);
        float ridges = 1.0 - abs(noise(q * 0.035) * 2.0 - 1.0);
        float h = (fbm(q * 0.05) * 0.8 + ridges * ridges * 0.7) * valley * (3.5 + far * 22.0);
        h -= 0.6 * (1.0 - valley);
        p.y = h;
        vH = h; vQ = q; vValley = valley;
        vec4 w = modelMatrix * vec4(p, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSunDir;
      uniform vec3 cLow, cMid, cHigh, cSnow, cRim, cCyan, cCity, cFogLow, cFogHigh;
      varying vec3 vWorld; varying vec2 vQ; varying float vH; varying float vValley;
      ${NOISE}
      void main(){
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));   // facetado low-poly
        float hN = clamp(vH / 16.0, 0.0, 1.0);
        vec3 col = mix(cLow, cMid, smoothstep(0.0, 0.3, hN));
        col = mix(col, cHigh, smoothstep(0.3, 0.75, hN));
        col = mix(col, cSnow, smoothstep(0.7, 0.95, hN) * smoothstep(0.55, 0.9, n.y));
        float moon = clamp(dot(n, normalize(vec3(-0.5, 0.7, 0.45))), 0.0, 1.0);
        float sunLit = pow(clamp(dot(n, normalize(uSunDir + vec3(0.0, 0.25, 0.0))), 0.0, 1.0), 1.5);
        col *= 0.5 + moon * 0.6;
        col += cRim * sunLit * 0.55;

        float floorMask = 1.0 - smoothstep(0.0, 0.2, vValley);
        float d = abs(vWorld.x - riverX(vQ.y));

        // grilla neón en el fondo del valle
        vec2 gq = vQ * 0.5;
        vec2 g = abs(fract(gq) - 0.5) / fwidth(gq);
        float line = 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
        col = mix(col, cCyan, line * floorMask * 0.35);

        // luces del pueblo
        vec2 cell = floor(vQ * 1.4);
        float hh = hash(cell);
        float dotm = 1.0 - smoothstep(0.12, 0.3, length(fract(vQ * 1.4) - 0.5));
        float near = 1.0 - smoothstep(3.0, 11.0, d);
        col += cCity * step(0.955, hh) * dotm * floorMask * near * (0.9 + 0.5 * sin(uTime * 3.0 + hh * 60.0)) * 1.6;

        float dist = length(vWorld - cameraPosition);
        float fog = smoothstep(45.0, 160.0, dist);
        vec3 fogCol = mix(cFogLow, cFogHigh, smoothstep(0.0, 22.0, vWorld.y));
        col = mix(col, fogCol, fog * 0.92);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.frustumCulled = false;
  scene.add(terrain);

  /* ---------------- luces ---------------- */
  scene.add(new THREE.HemisphereLight(PALETTE.lavender, PALETTE.indigo, 0.7));
  const key = new THREE.DirectionalLight(PALETTE.cream, 1.3);
  key.position.set(5, 7, 9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(PALETTE.magenta, 3.5);
  rim.position.set(-2, 3, -10);
  scene.add(rim);

  /* ---------------- la nube voladora ---------------- */
  const rig = new THREE.Group(); // se mueve por la escena
  const ship = new THREE.Group(); // gira con el drag
  rig.add(ship);
  scene.add(rig);

  const puffs: [number, number, number, number][] = [
    [0, 0, 0, 1.35], [1.25, -0.1, 0.25, 1.0], [-1.35, -0.1, 0.15, 1.05], [0.55, 0.42, -0.45, 1.0],
    [-0.65, 0.36, -0.5, 0.95], [2.3, -0.32, 0.05, 0.72], [-2.4, -0.3, 0.05, 0.76], [0.2, -0.42, 0.85, 0.92],
    [-0.95, -0.38, 0.75, 0.8], [1.05, -0.38, 0.8, 0.8], [0, -0.2, -1.05, 0.92], [1.75, 0.08, -0.6, 0.72],
    [-1.85, 0.05, -0.6, 0.72], [2.9, -0.5, -0.2, 0.45], [-3.0, -0.48, -0.15, 0.48],
  ];
  const cloudGeo = mergeGeometries(
    puffs.map(([x, y, z, r]) => {
      const g = new THREE.IcosahedronGeometry(r, 4);
      g.scale(1, 0.82, 1);
      g.translate(x, y, z);
      return g;
    }),
  );
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uSunDir: { value: sunDir }, uPuff: { value: 0 },
      cTop: C(PALETTE.cream), cMid: C('#f3e9fa'), cBottom: C(PALETTE.lavender), cShadow: C('#6a4bb0'), cRim: C(PALETTE.rose),
      uGlow: C(PALETTE.cyan), uGlowStrength: { value: 0 }, uScreenPos: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uPuff;
      varying vec3 vN; varying vec3 vWorld;
      void main(){
        vec3 p = position;
        float w = sin(p.x * 2.6 + uTime * 1.4) * sin(p.y * 3.1 + uTime * 1.1) * sin(p.z * 2.2 - uTime);
        p += normal * (w * 0.05 + uPuff * 0.18 * (0.6 + 0.4 * sin(p.x * 5.0)));
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, cTop, cMid, cBottom, cShadow, cRim, uGlow, uScreenPos; uniform float uGlowStrength;
      varying vec3 vN; varying vec3 vWorld;
      void main(){
        vec3 n = normalize(vN);
        vec3 v = normalize(cameraPosition - vWorld);
        float l = dot(n, normalize(vec3(0.35, 1.0, 0.55))) * 0.5 + 0.5;
        l = mix(l, floor(l * 4.0 + 0.5) / 4.0, 0.55);       // sombreado en bandas suaves (toon)
        vec3 col = mix(cShadow, cBottom, smoothstep(0.0, 0.4, l));
        col = mix(col, cMid, smoothstep(0.4, 0.7, l));
        col = mix(col, cTop, smoothstep(0.7, 1.0, l));
        float fres = pow(1.0 - max(dot(n, v), 0.0), 2.5);
        float back = 0.5 + 0.5 * max(dot(-v, uSunDir), 0.0);
        col += cRim * fres * back * 0.9;
        vec3 toScreen = uScreenPos - vWorld;
        float sd = length(toScreen);
        col += uGlow * uGlowStrength * max(dot(n, toScreen / sd), 0.0) / (1.0 + sd * sd * 0.6);
        gl_FragColor = vec4(col * 0.82, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const cloud = new THREE.Mesh(cloudGeo, cloudMat);
  ship.add(cloud);

  /* ---------------- la tele CRT ---------------- */
  const tv = new THREE.Group();
  tv.position.set(0, 1.0, 0.1);
  ship.add(tv);

  const bodyMat = new THREE.MeshPhysicalMaterial({ color: '#2a1f6b', roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.3 });
  const trimMat = new THREE.MeshPhysicalMaterial({ color: PALETTE.cream, roughness: 0.5, clearcoat: 0.4 });
  const cyanMat = new THREE.MeshStandardMaterial({ color: PALETTE.cyan, emissive: PALETTE.cyan, emissiveIntensity: 1.6 });
  const darkMat = new THREE.MeshStandardMaterial({ color: PALETTE.ink, roughness: 0.8 });

  const body = new THREE.Mesh(new RoundedBoxGeometry(2.7, 2.05, 1.45, 6, 0.24), bodyMat);
  body.position.y = 1.02;
  tv.add(body);
  const tube = new THREE.Mesh(new RoundedBoxGeometry(1.9, 1.55, 1.1, 5, 0.3), bodyMat);
  tube.position.set(0, 1.05, -0.95);
  tv.add(tube);

  // marco crema alrededor de la pantalla
  const scrW = 1.78, scrH = 1.4, scrX = -0.3, scrY = 1.08;
  const rr = (s: THREE.Shape | THREE.Path, w: number, h: number, r: number) => {
    s.moveTo(-w / 2 + r, -h / 2);
    s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    s.lineTo(-w / 2 + r, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    return s;
  };
  const bezelShape = rr(new THREE.Shape(), scrW + 0.22, scrH + 0.22, 0.2);
  bezelShape.holes.push(rr(new THREE.Path(), scrW, scrH, 0.16) as THREE.Path);
  const bezel = new THREE.Mesh(new THREE.ExtrudeGeometry(bezelShape, { depth: 0.07, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 3 }), trimMat);
  bezel.position.set(scrX, scrY, 0.7);
  tv.add(bezel);

  // pantalla abombada con shader de canales
  const osdCanvas = document.createElement('canvas');
  osdCanvas.width = 512;
  osdCanvas.height = 400;
  const osdCtx = osdCanvas.getContext('2d')!;
  const osdTex = new THREE.CanvasTexture(osdCanvas);
  osdTex.colorSpace = THREE.SRGBColorSpace;

  const screenGeo = new THREE.PlaneGeometry(scrW, scrH, 32, 32);
  {
    const p = screenGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / (scrW / 2), y = p.getY(i) / (scrH / 2);
      p.setZ(i, 0.07 * (1 - x * x * 0.8) * (1 - y * y * 0.8));
    }
    screenGeo.computeVertexNormals();
  }
  const screenMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uCh: { value: 0 }, uSwitch: { value: -10 }, uPower: { value: 0 }, tOSD: { value: osdTex },
      cInk: C(PALETTE.ink), cIndigo: C(PALETTE.indigo), cViolet: C(PALETTE.violet), cLav: C(PALETTE.lavender),
      cMag: C(PALETTE.magenta), cRose: C(PALETTE.rose), cCoral: C(PALETTE.coral), cPeach: C(PALETTE.peach),
      cGold: C(PALETTE.gold), cCream: C(PALETTE.cream), cCyan: C(PALETTE.cyan),
    },
    vertexShader: BASIC_VERT,
    fragmentShader: /* glsl */ `
      uniform float uTime, uCh, uSwitch, uPower; uniform sampler2D tOSD;
      uniform vec3 cInk, cIndigo, cViolet, cLav, cMag, cRose, cCoral, cPeach, cGold, cCream, cCyan;
      varying vec2 vUv;
      ${NOISE}
      vec3 pal(float i){
        i = mod(i, 5.0);
        if (i < 1.0) return cMag; if (i < 2.0) return cCoral; if (i < 3.0) return cLav; if (i < 4.0) return cRose; return cPeach;
      }
      vec3 hsv(float h, float s, float v){ vec3 k = clamp(abs(mod(h * 6.0 + vec3(0, 4, 2), 6.0) - 3.0) - 1.0, 0.0, 1.0); return v * mix(vec3(1), k, s); }
      float dot2(vec2 v){ return dot(v, v); }
      float sdHeart(vec2 p){
        p.x = abs(p.x);
        if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
        return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
      }

      // mini paisaje reutilizable (atardecer + montañas)
      vec3 miniScene(vec2 v, float t){
        vec3 sky = mix(cMag, cIndigo, smoothstep(-0.2, 1.0, v.y));
        sky = mix(cPeach, sky, smoothstep(-0.5, 0.0, v.y));
        float sun = 1.0 - smoothstep(0.36, 0.38, length((v - vec2(0.15, -0.1)) * vec2(1.4, 1.0)));
        sky = mix(sky, mix(cMag, cGold, v.y * 1.5 + 0.6), sun);
        float m1 = -0.35 + 0.18 * sin(v.x * 4.0 + 1.0) + 0.08 * sin(v.x * 13.0);
        float m2 = -0.62 + 0.1 * sin(v.x * 6.0 - 2.0);
        sky = mix(sky, cViolet, step(v.y, m1));
        sky = mix(sky, cInk, step(v.y, m2));
        // nube voladora en miniatura cruzando
        vec2 cp = v - vec2(mod(t * 0.25, 2.8) - 1.4, 0.35 + 0.04 * sin(t * 2.0));
        float cl = min(length(cp * vec2(1.0, 1.6)) - 0.12, length((cp - vec2(0.1, -0.02)) * vec2(1.0, 1.7)) - 0.09);
        sky = mix(sky, cCream, 1.0 - smoothstep(0.0, 0.01, cl));
        return sky;
      }

      vec3 chEdit(vec2 uv, float t){
        vec3 col = cInk * 0.9;
        vec2 v = (uv - vec2(0.5, 0.7)) / vec2(0.36, 0.25);
        if (abs(v.x) < 1.0 && abs(v.y) < 1.0) col = miniScene(v, t);
        else if (abs(v.x) < 1.04 && abs(v.y) < 1.06) col = cCream * 0.35;
        // pistas del timeline
        float ty = (uv.y - 0.06) / 0.085;
        float row = floor(ty);
        if (row >= 0.0 && row < 4.0) {
          float ry = fract(ty);
          float x = uv.x * 2.4 + t * 0.22 + row * 1.37;
          float seg = floor(x * 1.2 + hash(vec2(row, 3.0)) * 2.0);
          float inClip = step(0.035, fract(x * 1.2)) * step(0.14, ry) * step(ry, 0.86);
          vec3 cc = pal(seg + row * 2.0);
          if (row < 0.5) {
            float amp = abs(sin(x * 37.0)) * noise(vec2(x * 9.0, 1.0));
            inClip *= step(abs(ry - 0.5), amp * 0.38 + 0.04);
            cc = cCyan;
          }
          col = mix(col, cc * 0.9, inClip);
        }
        // regla y cabezal
        float ruler = step(0.405, uv.y) * step(uv.y, 0.42);
        col = mix(col, cCream * 0.5, ruler * step(0.6, fract(uv.x * 40.0)));
        col = mix(col, cCyan * 1.3, step(abs(uv.x - 0.5), 0.004) * step(uv.y, 0.43) * step(0.04, uv.y));
        return col;
      }

      vec3 chMotion(vec2 uv, float t){
        vec3 col = mix(cMag, cInk, smoothstep(0.45, 1.0, uv.y));
        col = mix(cPeach, col, smoothstep(0.42, 0.52, uv.y));
        vec2 sp = (uv - vec2(0.5, 0.6)) * vec2(1.25, 1.0);
        float r = length(sp);
        float disk = 1.0 - smoothstep(0.2, 0.205, r);
        if (sp.y < 0.02) disk *= step(mix(0.08, 0.6, clamp(-sp.y * 5.0, 0.0, 1.0)), fract(sp.y * 30.0 + t * 0.5));
        col = mix(col, mix(cMag, cGold, sp.y * 3.0 + 0.6), disk);
        if (uv.y < 0.45) {
          float z = 0.12 / (0.45 - uv.y + 0.001);
          vec2 g = vec2((uv.x - 0.5) * z * 4.0, z * 2.0 + t * 1.6);
          vec2 gl = abs(fract(g) - 0.5);
          float line = 1.0 - smoothstep(0.0, 0.04 * z, min(gl.x, gl.y));
          col = mix(cInk, cMag * 1.4, line * smoothstep(0.0, 0.25, 0.45 - uv.y + 0.05));
        }
        // formas en movimiento (keyframes)
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          vec2 c = vec2(0.5 + 0.32 * sin(t * (0.7 + fi * 0.3) + fi * 2.0), 0.62 + 0.18 * cos(t * (0.9 + fi * 0.2) + fi));
          vec2 d = (uv - c) * vec2(1.25, 1.0);
          float a = t * (1.0 + fi) ;
          d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
          float s = i == 0 ? abs(length(d) - 0.05) : abs(max(abs(d.x), abs(d.y)) - 0.04);
          col = mix(col, i == 1 ? cCream : cCyan, 1.0 - smoothstep(0.004, 0.008, s));
        }
        return col;
      }

      vec3 chSocial(vec2 uv, float t){
        vec3 col = mix(cIndigo, cViolet, uv.y) * 0.6;
        vec2 ph = (uv - 0.5) / vec2(0.19, 0.42);
        float inside = step(abs(ph.x), 1.0) * step(abs(ph.y), 1.0);
        float frame = step(abs(ph.x), 1.07) * step(abs(ph.y), 1.03) - inside;
        vec3 feed = mix(cMag, cCoral, ph.y * 0.5 + 0.5);
        vec2 sub = vec2(ph.x * 0.45, ph.y) - vec2(0.12 * sin(t), -0.1 + 0.05 * sin(t * 3.0));
        feed = mix(feed, cCream, 1.0 - smoothstep(0.17, 0.18, length(sub * vec2(1.0, 0.9))));
        feed = mix(feed, cIndigo, 1.0 - smoothstep(0.24, 0.25, length((sub + vec2(0.0, 0.42)) * vec2(0.8, 1.6))));
        // barras de historias
        float bars = step(0.9, ph.y) * step(ph.y, 0.94);
        float bx = (ph.x + 0.92) / 1.84;
        float seg = floor(bx * 3.0);
        float prog = mod(t * 0.33, 3.0);
        float fill = step(fract(bx * 3.0), clamp(prog - seg, 0.0, 1.0));
        feed = mix(feed, mix(cCream * 0.5, cCream, fill), bars * step(0.05, fract(bx * 3.0)));
        col = mix(col, feed, inside);
        col = mix(col, cInk, frame);
        // corazones que suben
        for (int i = 0; i < 5; i++) {
          float fi = float(i);
          float life = fract(t * 0.35 + fi * 0.21);
          vec2 hp = vec2(0.66 + 0.05 * sin(life * 9.0 + fi), 0.18 + life * 0.7);
          vec2 q = (uv - hp) * vec2(1.25, 1.0) / (0.045 + 0.01 * fi * 0.3);
          float hs = sdHeart(q + vec2(0.0, 0.5));
          col = mix(col, fi < 2.0 ? cMag * 1.3 : cRose * 1.2, (1.0 - smoothstep(0.0, 0.05, hs)) * (1.0 - life));
        }
        return col;
      }

      vec3 chColor(vec2 uv, float t){
        vec3 col = cInk * 0.8;
        vec2 v = (uv - vec2(0.5, 0.66)) / vec2(0.42, 0.28);
        if (abs(v.x) < 1.0 && abs(v.y) < 1.0) {
          vec3 s = miniScene(v, t);
          float split = 0.6 * sin(t * 0.8);
          float lum = dot(s, vec3(0.3, 0.59, 0.11));
          vec3 raw = mix(vec3(lum), s, 0.15) * 0.8 + 0.08;
          col = v.x < split ? raw : s * 1.1;
          col = mix(col, cCream, step(abs(v.x - split), 0.012));
        }
        // ruedas de color
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          vec2 c = vec2(0.25 + fi * 0.25, 0.17);
          vec2 d = (uv - c) * vec2(1.25, 1.0);
          float r = length(d);
          if (r < 0.1) {
            float a = atan(d.y, d.x) / 6.2831 + 0.5;
            col = hsv(a, r / 0.1, 0.85);
            vec2 dotp = 0.05 * vec2(cos(t * (0.6 + fi * 0.3) + fi * 2.0), sin(t * (0.5 + fi * 0.2) + fi));
            col = mix(col, cInk, 1.0 - smoothstep(0.008, 0.013, length(d - dotp)));
          }
          col = mix(col, cCream, 1.0 - smoothstep(0.002, 0.005, abs(r - 0.102)));
        }
        return col;
      }

      vec3 channel(float ch, vec2 uv, float t){
        if (ch < 0.5) return chEdit(uv, t);
        if (ch < 1.5) return chMotion(uv, t);
        if (ch < 2.5) return chSocial(uv, t);
        return chColor(uv, t);
      }

      void main(){
        vec2 c = vUv * 2.0 - 1.0;
        c *= 1.0 + dot(c.yx, c.yx) * 0.045;           // curvatura CRT
        vec2 uv = c * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
        float t = uTime;
        // inestabilidad horizontal en el cambio de canal
        float since = t - uSwitch;
        float sw = 1.0 - smoothstep(0.22, 0.5, since);
        uv.x += sw * (noise(vec2(uv.y * 40.0, t * 30.0)) - 0.5) * 0.08;
        vec3 col = channel(uCh, uv, t);
        float st = hash(floor(uv * vec2(260.0, 200.0)) + fract(t * 43.0) * 100.0);
        col = mix(col, vec3(st) * mix(cLav, cCream, st), sw);
        // scanlines, barra que rueda, máscara RGB
        col *= 0.86 + 0.14 * sin(uv.y * 680.0);
        col *= 0.94 + 0.06 * smoothstep(0.0, 0.06, abs(fract(uv.y * 0.5 - t * 0.12) - 0.5));
        vec4 osd = texture2D(tOSD, vec2(uv.x, uv.y));
        col = mix(col, osd.rgb, osd.a);
        float vig = smoothstep(0.0, 0.08, uv.x) * smoothstep(1.0, 0.92, uv.x) * smoothstep(0.0, 0.08, uv.y) * smoothstep(1.0, 0.92, uv.y);
        col *= 0.45 + 0.55 * vig;
        // encendido CRT
        float open = smoothstep(0.0, 1.0, uPower);
        float lineMask = step(abs(uv.y - 0.5), max(open * 0.5, 0.004)) * step(abs(uv.x - 0.5), min(uPower * 4.0, 1.0) * 0.5);
        col = mix(col, cCream * 2.0, (1.0 - open) * lineMask);
        col *= lineMask;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.position.set(scrX, scrY, 0.735);
  tv.add(screen);
  const screenLight = new THREE.PointLight(PALETTE.cyan, 0, 6, 1.5);
  screenLight.position.set(scrX, scrY, 1.4);
  tv.add(screenLight);

  // panel de control
  [0.62, 0.22].forEach((y) => {
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.12, 32), trimMat);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(1.0, 1.0 + y - 0.15, 0.75);
    tv.add(knob);
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.02), cyanMat);
    mark.position.set(1.0, 1.0 + y - 0.1, 0.82);
    tv.add(mark);
  });
  for (let i = 0; i < 5; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.035, 0.02), darkMat);
    slot.position.set(1.0, 0.72 - i * 0.085, 0.735);
    tv.add(slot);
  }
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 8), new THREE.MeshStandardMaterial({ color: PALETTE.magenta, emissive: PALETTE.magenta, emissiveIntensity: 3 }));
  led.position.set(1.0, 0.2, 0.74);
  tv.add(led);

  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.11),
    new THREE.MeshBasicMaterial({
      transparent: true,
      map: canvasTexture(512, 64, (ctx) => {
        ctx.fillStyle = PALETTE.cream;
        ctx.font = '600 34px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NUBE · VOLADORA', 256, 34);
      }),
    }),
  );
  label.position.set(scrX, 0.2, 0.735);
  tv.add(label);

  // antenas
  const antBase = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), trimMat);
  antBase.position.set(0, 2.03, -0.35);
  tv.add(antBase);
  const antennas: THREE.Group[] = [];
  [-1, 1].forEach((s) => {
    const g = new THREE.Group();
    g.position.copy(antBase.position);
    g.rotation.z = s * 0.5;
    g.rotation.x = -0.15;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 1.5, 8), trimMat);
    rod.position.y = 0.75;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 8), cyanMat);
    tip.position.y = 1.5;
    g.add(rod, tip);
    tv.add(g);
    antennas.push(g);
  });
  // patitas
  [-0.9, 0.9].forEach((x) => {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.12, 16), darkMat);
    foot.position.set(x, -0.02, 0.35);
    tv.add(foot);
  });

  /* ---------------- pájaros (silueta) ---------------- */
  const birdMat = new THREE.MeshBasicMaterial({ color: PALETTE.night, side: THREE.DoubleSide });
  const wingGeo = new THREE.BufferGeometry();
  wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.12, 0, 0, -0.12, 0.6, 0, -0.05], 3));
  const birds = Array.from({ length: 11 }, (_, i) => {
    const b = new THREE.Group();
    const l = new THREE.Mesh(wingGeo, birdMat);
    const r = new THREE.Mesh(wingGeo, birdMat);
    r.scale.x = -1;
    b.add(l, r);
    b.userData = { l, r, phase: Math.random() * 6, speed: 2.4 + Math.random() * 1.2, x: -60 + i * 9 + Math.random() * 6, y: 12 + Math.random() * 7, z: -55 - Math.random() * 25 };
    b.scale.setScalar(1.6 + Math.random());
    scene.add(b);
    return b;
  });

  /* ---------------- partículas: jirones de nube y chispas ---------------- */
  const wispCount = isSmall ? 70 : 140;
  const wispPos = new Float32Array(wispCount * 3);
  const resetWisp = (i: number, anywhere: boolean) => {
    wispPos[i * 3] = (Math.random() - 0.5) * 26;
    wispPos[i * 3 + 1] = Math.random() * 9 - 1;
    wispPos[i * 3 + 2] = anywhere ? -40 + Math.random() * 52 : -40;
  };
  for (let i = 0; i < wispCount; i++) resetWisp(i, true);
  const wispGeo = new THREE.BufferGeometry();
  wispGeo.setAttribute('position', new THREE.BufferAttribute(wispPos, 3));
  const wisps = new THREE.Points(
    wispGeo,
    new THREE.PointsMaterial({ map: softDotTexture(), color: PALETTE.lavender, size: 0.35, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  scene.add(wisps);

  // estallido al tocar la nube
  const burstCount = 60;
  const burstPos = new Float32Array(burstCount * 3);
  const burstVel = new Float32Array(burstCount * 3);
  const burstGeo = new THREE.BufferGeometry();
  burstGeo.setAttribute('position', new THREE.BufferAttribute(burstPos, 3));
  const burstMat = new THREE.PointsMaterial({ map: softDotTexture(), color: PALETTE.cream, size: 0.5, transparent: true, opacity: 0, depthWrite: false });
  const burst = new THREE.Points(burstGeo, burstMat);
  ship.add(burst);
  let burstAge = 10;

  /* ---------------- post-procesado ---------------- */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.5, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const finalPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: BASIC_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; varying vec2 vUv;
      float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        vec2 uv = vUv;
        vec2 dir = uv - 0.5;
        float d = length(dir);
        vec2 off = dir * d * 0.01;
        vec3 col = vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
        col *= 1.0 - smoothstep(0.45, 1.0, d) * 0.4;
        col *= 0.97 + 0.03 * sin(vUv.y * uRes.y * 1.6);
        col += (rand(vUv * 900.0 + fract(uTime)) - 0.5) * 0.035;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  composer.addPass(finalPass);

  /* ---------------- OSD de la tele ---------------- */
  let channel = 0;
  const drawOSD = (t: number) => {
    const ctx = osdCtx;
    const W = osdCanvas.width, H = osdCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.font = '22px "Press Start 2P", monospace';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = PALETTE.cyan;
    ctx.fillText(`CH ${String(channel + 1).padStart(2, '0')}`, 28, 26);
    ctx.font = '12px "Press Start 2P", monospace';
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText(CHANNELS[channel].name, 30, 58);
    if (Math.floor(t * 1.5) % 2 === 0) {
      ctx.fillStyle = PALETTE.magenta;
      ctx.beginPath();
      ctx.arc(W - 118, 34, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText('REC', W - 100, 28);
    const f = Math.floor(t * 24);
    const tc = [Math.floor(f / 86400) % 24, Math.floor(f / 1440) % 60, Math.floor(f / 24) % 60, f % 24].map((n) => String(n).padStart(2, '0')).join(':');
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText(tc, W - 152, H - 34);
    if (channel === 2) {
      ctx.fillStyle = PALETTE.cream;
      ctx.fillText(`♥ ${(12.4 + t * 0.01).toFixed(1)}K`, 28, H - 34);
    }
    osdTex.needsUpdate = true;
  };
  document.fonts?.load('12px "Press Start 2P"').then(() => drawOSD(now));

  /* ---------------- interacción ---------------- */
  const listeners = new Set<(ch: number) => void>();
  const setChannel = (ch: number) => {
    channel = ((ch % CHANNELS.length) + CHANNELS.length) % CHANNELS.length;
    screenMat.uniforms.uCh.value = channel;
    screenMat.uniforms.uSwitch.value = now;
    glowTarget.set(CHANNELS[channel].glow);
    drawOSD(now);
    antennaKick = 1;
    listeners.forEach((fn) => fn(channel));
  };
  const glowTarget = new THREE.Color(PALETTE.cyan);
  let antennaKick = 0;

  const pointer = new THREE.Vector2(), pointerSmooth = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  let dragging = false, dragMoved = 0, lastX = 0, yaw = 0, yawVel = 0, puff = 0;

  const ndc = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  };
  const pick = () => raycaster.intersectObjects([screen, body, tube, cloud], false)[0];

  canvas.addEventListener('pointerdown', (e) => {
    ndc(e);
    const hit = pick();
    if (!hit) return;
    dragging = true;
    dragMoved = 0;
    lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    ndc(e);
    if (dragging) {
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      dragMoved += Math.abs(dx);
      yawVel = dx * 0.006;
      yaw += yawVel;
    } else {
      document.body.classList.toggle('cursor-hot', !!pick());
    }
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (dragMoved < 6) {
      ndc(e);
      const hit = pick();
      if (hit?.object === screen || hit?.object === body || hit?.object === tube) setChannel(channel + 1);
      else if (hit?.object === cloud) poof();
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  addEventListener('pointermove', (e) => {
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  });

  const poof = () => {
    puff = 1;
    burstAge = 0;
    for (let i = 0; i < burstCount; i++) {
      const v = new THREE.Vector3().randomDirection();
      v.y = Math.abs(v.y) * 0.6;
      burstPos.set([v.x * 1.5, v.y * 0.5, v.z * 1.2], i * 3);
      burstVel.set([v.x * 3, v.y * 3 + 0.5, v.z * 3], i * 3);
    }
  };

  /* ---------------- responsive ---------------- */
  const layout = { rig: new THREE.Vector3(), cam: new THREE.Vector3(), look: new THREE.Vector3(), yaw: -0.38 };
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w, h);
    finalPass.uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    camera.aspect = w / h;
    const portrait = camera.aspect < 0.9;
    camera.fov = portrait ? 58 : 40;
    camera.updateProjectionMatrix();
    layout.rig.set(portrait ? 0.2 : 3.1, portrait ? 5.6 : 2.9, portrait ? -2 : 0.2);
    layout.cam.set(0, portrait ? 5.2 : 4.4, portrait ? 13 : 11.5);
    layout.look.set(portrait ? 0 : 0.6, portrait ? 4.4 : 3.9, -10);
    layout.yaw = portrait ? -0.15 : -0.42;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  /* ---------------- loop ---------------- */
  // fuera de pantalla o con la pestaña oculta el loop se corta del todo (ni rAF ni render)
  let inView = true, raf = 0;
  const sync = () => {
    const run = inView && !document.hidden;
    if (run && !raf) {
      timer.update(); // descarta el tiempo pausado para que dt no salte
      raf = requestAnimationFrame(tick);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); }).observe(canvas);
  document.addEventListener('visibilitychange', sync);
  let scrollP = 0, offset = 0, osdClock = 0;
  const glow = new THREE.Color(PALETTE.cyan);
  const screenWorld = new THREE.Vector3();
  const camStart = new THREE.Vector3();

  const tick = () => {
    raf = requestAnimationFrame(tick);
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    const t = (now = timer.getElapsed() - t0);

    const intro = reduced ? 1 : 1 - Math.pow(1 - Math.min(t / 3.4, 1), 3);
    renderer.toneMappingExposure = Math.min(t / 1.4, 1) * 0.92;
    screenMat.uniforms.uPower.value = reduced ? 1 : THREE.MathUtils.clamp((t - 1.6) / 0.7, 0, 1);

    // vuelo
    const speed = 5 + scrollP * 14;
    offset += dt * speed;
    // el ruido avanza de a un vértice y la malla cubre el resto: los picos no ondulan
    const snap = Math.floor(offset / terrainStep) * terrainStep;
    terrainMat.uniforms.uOffset.value = snap;
    terrainMat.uniforms.uShift.value = offset - snap;
    terrain.position.z = offset - snap;

    // cámara
    pointerSmooth.lerp(pointer, 0.05);
    camStart.copy(layout.cam).add(new THREE.Vector3(0, 6, 10));
    camera.position.lerpVectors(camStart, layout.cam, intro);
    camera.position.x += pointerSmooth.x * 0.8;
    camera.position.y += pointerSmooth.y * 0.35 + scrollP * 2.5;
    camera.lookAt(layout.look.x + pointerSmooth.x * 0.4, layout.look.y + scrollP * 1.2, layout.look.z);

    // la nube: flota, se inclina hacia el puntero, gira con drag e inercia
    rig.position.set(layout.rig.x, layout.rig.y + Math.sin(t * 1.1) * 0.18 + scrollP * 1.5, layout.rig.z);
    rig.rotation.z = Math.sin(t * 0.7) * 0.03 - pointerSmooth.x * 0.06;
    if (!dragging) {
      yawVel *= 0.93;
      yaw += yawVel;
      yaw += (0 - yaw) * 0.015;
    }
    ship.rotation.y = layout.yaw + yaw + pointerSmooth.x * 0.15;
    ship.rotation.x = -pointerSmooth.y * 0.08;
    puff *= 0.92;
    cloudMat.uniforms.uPuff.value = Math.sin(puff * Math.PI) * puff;
    tv.position.y = 1.0 + Math.sin(puff * Math.PI) * 0.35;

    antennaKick *= 0.95;
    antennas.forEach((a, i) => {
      a.rotation.z = (i === 0 ? -0.5 : 0.5) + Math.sin(t * 9 + i) * 0.12 * antennaKick + Math.sin(t * 1.3 + i) * 0.03;
    });

    // brillo de la pantalla sobre la nube
    glow.lerp(glowTarget, 0.06);
    screenLight.color.copy(glow);
    screenLight.intensity = 2.2 * screenMat.uniforms.uPower.value;
    screen.getWorldPosition(screenWorld);
    cloudMat.uniforms.uScreenPos.value.copy(screenWorld).add(new THREE.Vector3(0, 0, 0.6));
    cloudMat.uniforms.uGlow.value.copy(glow);
    cloudMat.uniforms.uGlowStrength.value = 0.9 * screenMat.uniforms.uPower.value;

    // pájaros
    birds.forEach((b) => {
      const u = b.userData;
      u.x += dt * u.speed;
      if (u.x > 70) u.x = -70;
      b.position.set(u.x, u.y + Math.sin(t * 0.8 + u.phase) * 0.6, u.z);
      const f = Math.sin(t * 7 + u.phase) * 0.7;
      u.l.rotation.z = f;
      u.r.rotation.z = -f;
      b.rotation.y = -Math.PI / 2;
    });

    // jirones
    for (let i = 0; i < wispCount; i++) {
      wispPos[i * 3 + 2] += dt * speed * 0.9;
      if (wispPos[i * 3 + 2] > 14) resetWisp(i, false);
    }
    wispGeo.attributes.position.needsUpdate = true;

    // estallido
    burstAge += dt;
    if (burstAge < 1.4) {
      for (let i = 0; i < burstCount * 3; i++) {
        burstPos[i] += burstVel[i] * dt;
        burstVel[i] *= 0.95;
      }
      burstGeo.attributes.position.needsUpdate = true;
    }
    burstMat.opacity = Math.max(0, 1 - burstAge / 1.4) * 0.9;

    // OSD a ~12 fps
    osdClock += dt;
    if (osdClock > 0.08) {
      osdClock = 0;
      drawOSD(t);
    }

    for (const m of [skyMat, starMat, sunMat, terrainMat, cloudMat, screenMat]) m.uniforms.uTime.value = t;
    finalPass.uniforms.uTime.value = t;
    composer.render();
  };
  drawOSD(0);
  sync();

  return {
    setChannel,
    next: () => setChannel(channel + 1),
    prev: () => setChannel(channel - 1),
    get channel() {
      return channel;
    },
    onChannel(fn: (ch: number) => void) {
      listeners.add(fn);
    },
    setScroll(p: number) {
      scrollP = p;
    },
    // reinicia la intro (cámara, exposición, encendido de la tele) cuando se va el loader
    restart() {
      t0 = timer.getElapsed();
    },
  };
}
