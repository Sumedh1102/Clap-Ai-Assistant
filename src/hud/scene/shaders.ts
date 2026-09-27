/**
 * GLSL for the CLAP core.
 *
 * The surface is displaced by two octaves of simplex noise whose amplitude
 * follows the live audio level, then lit by a fresnel rim so it reads as a
 * glowing shell rather than a solid ball. Additive blending plus the bloom pass
 * give it its light.
 */

/**
 * 3D simplex noise — Ian McEwan, Stefan Gustavson, Ashima Arts.
 * MIT License. https://github.com/ashima/webgl-noise
 */
export const SIMPLEX_NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

export const SHELL_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uNoise;
uniform float uNoiseSpeed;
uniform float uLevel;
uniform float uPulse;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying float vDisp;
varying vec3 vLocal;
${SIMPLEX_NOISE}
void main() {
  vec3 p = position;
  float t = uTime * uNoiseSpeed;
  float n1 = snoise(p * 1.7 + vec3(0.0, t * 0.6, t * 0.35));
  float n2 = snoise(p * 4.2 - vec3(t * 0.8));
  float amp = uNoise + uLevel * 0.24;
  float disp = n1 * amp + n2 * amp * 0.35 + uPulse * 0.07;
  vec3 displaced = p + normal * disp;
  vDisp = disp;
  vLocal = p;
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`

export const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uIntensity;
uniform float uTime;
uniform float uLevel;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying float vDisp;
varying vec3 vLocal;
void main() {
  float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
  float fresnel = pow(1.0 - facing, 2.4);
  float bands = 0.55 + 0.45 * sin(vLocal.y * 46.0 - uTime * 1.6);
  float ridge = smoothstep(0.02, 0.2, vDisp);
  vec3 color = uColor * (0.07 + fresnel * 1.4) + uCore * ridge * 0.55;
  color *= mix(0.72, 1.0, bands);
  color *= uIntensity * (1.0 + uLevel * 0.65);
  float alpha = clamp(0.1 + fresnel * 0.95 + ridge * 0.4, 0.0, 1.0);
  gl_FragColor = vec4(color, alpha);
}
`

export const RING_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/** Orbit rings: solid, or segmented and marching when a tool is running. */
export const RING_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uDashed;
uniform float uTime;
uniform float uSpeed;
varying vec2 vUv;
void main() {
  float seg = fract(vUv.x * 42.0 - uTime * uSpeed * 0.6);
  float dash = mix(1.0, step(0.42, seg), uDashed);
  float head = pow(fract(vUv.x - uTime * uSpeed * 0.08), 14.0);
  float alpha = uOpacity * (0.35 * dash + head * 1.4);
  gl_FragColor = vec4(uColor * (0.8 + head * 1.6), alpha);
}
`

export const RIPPLE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
}
`
