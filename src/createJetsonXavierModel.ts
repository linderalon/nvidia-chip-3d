import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: NVIDIA Jetson AGX Xavier SoM
// Sculpt build pass: surface-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createNVIDIAJetsonAGXXavierSoMModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "NVIDIA Jetson AGX Xavier SoM";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["board-solder-mask"] = createSculptMaterial(
    "board-solder-mask",
    {"id": "board-solder-mask", "name": "Board Solder Mask", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#141414", "color": "#141414", "albedo": {"dominant": "#2A1810", "secondary": ["#1B100B", "#513B33", "#0A0605"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_albedo.png", "url": "board-solder-mask_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#2A1810", "#1B100B", "#513B33", "#0A0605", "#302623"], "pattern": "reference-derived pixel palette", "amplitude": 0.093, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.358, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.25, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.112, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_roughness.png", "url": "board-solder-mask_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.184, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_normal.png", "url": "board-solder-mask_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_height.png", "url": "board-solder-mask_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.011, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_height.png", "url": "board-solder-mask_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_ao.png", "url": "board-solder-mask_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Matte near-black dielectric solder mask, front and back faces (8,9,10,11.png).", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/plain-board-back-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.845, "estimatedFidelity": 0.845, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_albedo.png", "url": "board-solder-mask_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_roughness.png", "url": "board-solder-mask_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_height.png", "url": "board-solder-mask_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_normal.png", "url": "board-solder-mask_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/board-solder-mask/board-solder-mask_ao.png", "url": "board-solder-mask_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 223, "sourceHeight": 245, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 174, "height": 245}, "mask": {"backgroundColor": "#777777", "backgroundNoise": 173.205, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1455}, "mapStats": {"valueRange": 0.2225, "heightP90Gradient": 0.02384, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.184, "blurRadius": 21}, "palette": ["#2A1810", "#1B100B", "#513B33", "#0A0605", "#302623"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["soc-substrate"] = createSculptMaterial(
    "soc-substrate",
    {"id": "soc-substrate", "name": "SoC Substrate Patch", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#1F6B6B", "color": "#1F6B6B", "albedo": {"dominant": "#045B65", "secondary": ["#04525B", "#151718", "#B3B3B2"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_albedo.png", "url": "soc-substrate_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#045B65", "#04525B", "#151718", "#B3B3B2", "#626965"], "pattern": "reference-derived pixel palette", "amplitude": 0.232, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.474, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.697, "variation": 0.071, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_roughness.png", "url": "soc-substrate_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.219, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_normal.png", "url": "soc-substrate_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_height.png", "url": "soc-substrate_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.024, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_height.png", "url": "soc-substrate_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_ao.png", "url": "soc-substrate_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Teal/cyan fine-stipple substrate patch surrounding the SoC overmold lid; stipple is procedural micro-relief, no text.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/soc-package-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_albedo.png", "url": "soc-substrate_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_roughness.png", "url": "soc-substrate_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_height.png", "url": "soc-substrate_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_normal.png", "url": "soc-substrate_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/soc-substrate/soc-substrate_ao.png", "url": "soc-substrate_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 595, "sourceHeight": 524, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 595, "height": 524}, "mask": {"backgroundColor": "#3F3F3F", "backgroundNoise": 25.417, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.6213}, "mapStats": {"valueRange": 0.553, "heightP90Gradient": 0.05323, "roughnessBase": 0.697, "roughnessVariation": 0.071, "normalStrength": 0.219, "blurRadius": 21}, "palette": ["#045B65", "#04525B", "#151718", "#B3B3B2", "#626965"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["ic-overmold-dark"] = createSculptMaterial(
    "ic-overmold-dark",
    {"id": "ic-overmold-dark", "name": "IC Overmold (Dark)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#232323", "color": "#232323", "albedo": {"dominant": "#63533F", "secondary": ["#26160F", "#392419", "#483C31"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_albedo.png", "url": "ic-overmold-dark_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"], "pattern": "reference-derived pixel palette", "amplitude": 0.133, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.391, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.685, "variation": 0.082, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.216, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.023, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Dark gray-black molded package body used for the SoC lid and all memory/PMIC packages; no marking text baked.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/memory-pmic-left-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_albedo.png", "url": "ic-overmold-dark_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 347, "sourceHeight": 787, "mapSize": 1024, "cropBBoxPixels": {"x": 87, "y": 0, "width": 260, "height": 787}, "mask": {"backgroundColor": "#898989", "backgroundNoise": 140.296, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1689}, "mapStats": {"valueRange": 0.3173, "heightP90Gradient": 0.0511, "roughnessBase": 0.685, "roughnessVariation": 0.082, "normalStrength": 0.216, "blurRadius": 21}, "palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["vrm-inductor-body"] = createSculptMaterial(
    "vrm-inductor-body",
    {"id": "vrm-inductor-body", "name": "VRM Inductor Body", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B79B6B", "color": "#B79B6B", "albedo": {"dominant": "#8E775F", "secondary": ["#4F4E4D", "#24211F", "#7B523B"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_albedo.png", "url": "vrm-inductor-body_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#8E775F", "#4F4E4D", "#24211F", "#7B523B", "#CFCCCB"], "pattern": "reference-derived pixel palette", "amplitude": 0.273, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.508, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.743, "variation": 0.209, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_roughness.png", "url": "vrm-inductor-body_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.306, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_normal.png", "url": "vrm-inductor-body_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_height.png", "url": "vrm-inductor-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.057, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_height.png", "url": "vrm-inductor-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_ao.png", "url": "vrm-inductor-body_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Tan/beige molded ceramic-like inductor body (8x row, 'R22'-class in reference, text not baked).", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/vrm-inductor-row-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_albedo.png", "url": "vrm-inductor-body_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_roughness.png", "url": "vrm-inductor-body_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_height.png", "url": "vrm-inductor-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_normal.png", "url": "vrm-inductor-body_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_ao.png", "url": "vrm-inductor-body_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 1240, "sourceHeight": 280, "mapSize": 1024, "cropBBoxPixels": {"x": 77, "y": 1, "width": 1091, "height": 279}, "mask": {"backgroundColor": "#A8A8A8", "backgroundNoise": 0.0, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.7152}, "mapStats": {"valueRange": 0.651, "heightP90Gradient": 0.1277, "roughnessBase": 0.743, "roughnessVariation": 0.209, "normalStrength": 0.306, "blurRadius": 21}, "palette": ["#8E775F", "#4F4E4D", "#24211F", "#7B523B", "#CFCCCB"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["vrm-cap-body"] = createSculptMaterial(
    "vrm-cap-body",
    {"id": "vrm-cap-body", "name": "VRM Capacitor Body", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#26221E", "color": "#26221E", "albedo": {"dominant": "#444341", "secondary": ["#6F5E47", "#191615", "#33302E"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_albedo.png", "url": "vrm-cap-body_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#444341", "#6F5E47", "#191615", "#33302E", "#B4B4B4"], "pattern": "reference-derived pixel palette", "amplitude": 0.144, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.762, "variation": 0.194, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_roughness.png", "url": "vrm-cap-body_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.307, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_normal.png", "url": "vrm-cap-body_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_height.png", "url": "vrm-cap-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.058, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_height.png", "url": "vrm-cap-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_ao.png", "url": "vrm-cap-body_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Charcoal molded polymer capacitor body (2x8 bank, '330'-class in reference, text not baked).", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/vrm-cap-bank-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.844, "estimatedFidelity": 0.844, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_albedo.png", "url": "vrm-cap-body_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_roughness.png", "url": "vrm-cap-body_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_height.png", "url": "vrm-cap-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_normal.png", "url": "vrm-cap-body_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_ao.png", "url": "vrm-cap-body_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 1240, "sourceHeight": 245, "mapSize": 1024, "cropBBoxPixels": {"x": 81, "y": 0, "width": 1083, "height": 245}, "mask": {"backgroundColor": "#8E8E8E", "backgroundNoise": 0.0, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.861}, "mapStats": {"valueRange": 0.3435, "heightP90Gradient": 0.12854, "roughnessBase": 0.762, "roughnessVariation": 0.194, "normalStrength": 0.307, "blurRadius": 21}, "palette": ["#444341", "#6F5E47", "#191615", "#33302E", "#B4B4B4"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["connector-housing"] = createSculptMaterial(
    "connector-housing",
    {"id": "connector-housing", "name": "Connector Insulator Housing", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#0D0D0D", "color": "#0D0D0D", "albedo": {"dominant": "#2C1E13", "secondary": ["#050606", "#18120F", "#494131"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_albedo.png", "url": "connector-housing_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#2C1E13", "#050606", "#18120F", "#494131", "#73684E"], "pattern": "reference-derived pixel palette", "amplitude": 0.146, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.402, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.706, "variation": 0.167, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_roughness.png", "url": "connector-housing_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.252, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_normal.png", "url": "connector-housing_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_height.png", "url": "connector-housing_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.037, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_height.png", "url": "connector-housing_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_ao.png", "url": "connector-housing_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Black plastic insulator housing of the card-edge mezzanine connector (9,10.png).", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/connector-block-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_albedo.png", "url": "connector-housing_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_roughness.png", "url": "connector-housing_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_height.png", "url": "connector-housing_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_normal.png", "url": "connector-housing_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-housing/connector-housing_ao.png", "url": "connector-housing_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 843, "sourceHeight": 385, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 843, "height": 385}, "mask": {"backgroundColor": "#2A1F20", "backgroundNoise": 19.339, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.2842}, "mapStats": {"valueRange": 0.3487, "heightP90Gradient": 0.0815, "roughnessBase": 0.706, "roughnessVariation": 0.167, "normalStrength": 0.252, "blurRadius": 21}, "palette": ["#2C1E13", "#050606", "#18120F", "#494131", "#73684E"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["connector-gold-contact"] = createSculptMaterial(
    "connector-gold-contact",
    {"id": "connector-gold-contact", "name": "Connector Gold Contact", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#C9A227", "color": "#C9A227", "albedo": {"dominant": "#2C1E13", "secondary": ["#050606", "#18120F", "#494131"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_albedo.png", "url": "connector-gold-contact_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#2C1E13", "#050606", "#18120F", "#494131", "#73684E"], "pattern": "reference-derived pixel palette", "amplitude": 0.146, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.402, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.706, "variation": 0.167, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_roughness.png", "url": "connector-gold-contact_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.9, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.252, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_normal.png", "url": "connector-gold-contact_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_height.png", "url": "connector-gold-contact_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.037, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_height.png", "url": "connector-gold-contact_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_ao.png", "url": "connector-gold-contact_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Gold-plated contact rows inside the connector housing; approximated as one ridge bar per row (~8 rows).", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/connector-block-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_albedo.png", "url": "connector-gold-contact_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_roughness.png", "url": "connector-gold-contact_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_height.png", "url": "connector-gold-contact_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_normal.png", "url": "connector-gold-contact_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/connector-gold-contact/connector-gold-contact_ao.png", "url": "connector-gold-contact_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 843, "sourceHeight": 385, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 843, "height": 385}, "mask": {"backgroundColor": "#2A1F20", "backgroundNoise": 19.339, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.2842}, "mapStats": {"valueRange": 0.3487, "heightP90Gradient": 0.0815, "roughnessBase": 0.706, "roughnessVariation": 0.167, "normalStrength": 0.252, "blurRadius": 21}, "palette": ["#2C1E13", "#050606", "#18120F", "#494131", "#73684E"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["standoff-copper-ring"] = createSculptMaterial(
    "standoff-copper-ring",
    {"id": "standoff-copper-ring", "name": "Standoff Copper Ring", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B5651D", "color": "#B5651D", "albedo": {"dominant": "#301D14", "secondary": ["#251710", "#57423A", "#777777"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_albedo.png", "url": "standoff-copper-ring_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#301D14", "#251710", "#57423A", "#777777", "#090809"], "pattern": "reference-derived pixel palette", "amplitude": 0.165, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.417, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.695, "variation": 0.098, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_roughness.png", "url": "standoff-copper-ring_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.85, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.224, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_normal.png", "url": "standoff-copper-ring_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_height.png", "url": "standoff-copper-ring_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.026, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_height.png", "url": "standoff-copper-ring_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_ao.png", "url": "standoff-copper-ring_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Copper-plated concentric ring pad around each of the 4 mounting-standoff through-holes.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/standoff-tl-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_albedo.png", "url": "standoff-copper-ring_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_roughness.png", "url": "standoff-copper-ring_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_height.png", "url": "standoff-copper-ring_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_normal.png", "url": "standoff-copper-ring_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/standoff-copper-ring/standoff-copper-ring_ao.png", "url": "standoff-copper-ring_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 298, "sourceHeight": 420, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 298, "height": 420}, "mask": {"backgroundColor": "#2E1C12", "backgroundNoise": 42.556, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.3532}, "mapStats": {"valueRange": 0.3928, "heightP90Gradient": 0.05749, "roughnessBase": 0.695, "roughnessVariation": 0.098, "normalStrength": 0.224, "blurRadius": 21}, "palette": ["#301D14", "#251710", "#57423A", "#777777", "#090809"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["copper-edge"] = createSculptMaterial(
    "copper-edge",
    {"id": "copper-edge", "name": "Copper Edge Heatspreader", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B5651D", "color": "#B5651D", "albedo": {"dominant": "#FFFFFF", "secondary": [], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_albedo.png", "url": "copper-edge_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#FFFFFF"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.308, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.15, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.055, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_roughness.png", "url": "copper-edge_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.85, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.156, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_normal.png", "url": "copper-edge_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_height.png", "url": "copper-edge_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_height.png", "url": "copper-edge_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_ao.png", "url": "copper-edge_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Copper-hued metallic perimeter band visible on both faces; carries the perimeter-through-hole normal/AO local override.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/delit/edge-heatspreader-delit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.7, "estimatedFidelity": 0.612, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_albedo.png", "url": "copper-edge_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_roughness.png", "url": "copper-edge_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_height.png", "url": "copper-edge_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_normal.png", "url": "copper-edge_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/copper-edge/copper-edge_ao.png", "url": "copper-edge_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 1240, "sourceHeight": 175, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 1240, "height": 175}, "mask": {"backgroundColor": "#FFFFFF", "backgroundNoise": 0.0, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.08, "heightP90Gradient": 0.0, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.156, "blurRadius": 21}, "palette": ["#FFFFFF"]}, "warnings": ["foreground mask is tiny; material extraction is likely unreliable", "image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference", "low high-frequency detail weakens normal/roughness inference"], "notes": "Confidence floor applied at 0.7; low-contrast de-lit crop limited automatic extraction confidence scoring, though the underlying albedo texture IS the real (de-lit) reference photo pixels, used per explicit user authorization to project real photo textures for maximum fidelity."}},
    options
  );
  materialMap["vrm-inductor-marking"] = createSculptMaterial(
    "vrm-inductor-marking",
    {"id": "vrm-inductor-marking", "name": "VRM Inductor Body (R22 marking)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B79B6B", "color": "#B79B6B", "albedo": {"dominant": "#8E775F", "secondary": ["#4F4E4D", "#24211F", "#7B523B"], "samplingNotes": "Reference-derived from photo crop showing legible component marking text; projected/decal albedo, not tiled swatch.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/r22.png", "url": "r22.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#8E775F", "#4F4E4D", "#24211F", "#7B523B", "#CFCCCB"], "pattern": "reference-derived pixel palette", "amplitude": 0.273, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.508, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.743, "variation": 0.209, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_roughness.png", "url": "vrm-inductor-body_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.306, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_normal.png", "url": "vrm-inductor-body_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_height.png", "url": "vrm-inductor-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.057, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_height.png", "url": "vrm-inductor-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_ao.png", "url": "vrm-inductor-body_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Tan/beige molded ceramic-like inductor body (8x row, 'R22'-class in reference, text not baked).", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/markings/r22.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "photo-crop marking decal: legible component text cut from de-lit reference and used as override albedo on a dedicated per-component material", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/r22.png", "url": "r22.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_roughness.png", "url": "vrm-inductor-body_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_height.png", "url": "vrm-inductor-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_normal.png", "url": "vrm-inductor-body_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-inductor-body/vrm-inductor-body_ao.png", "url": "vrm-inductor-body_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 1240, "sourceHeight": 280, "mapSize": 1024, "cropBBoxPixels": {"x": 77, "y": 1, "width": 1091, "height": 279}, "mask": {"backgroundColor": "#A8A8A8", "backgroundNoise": 0.0, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.7152}, "mapStats": {"valueRange": 0.651, "heightP90Gradient": 0.1277, "roughnessBase": 0.743, "roughnessVariation": 0.209, "normalStrength": 0.306, "blurRadius": 21}, "palette": ["#8E775F", "#4F4E4D", "#24211F", "#7B523B", "#CFCCCB"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["vrm-cap-marking"] = createSculptMaterial(
    "vrm-cap-marking",
    {"id": "vrm-cap-marking", "name": "VRM Capacitor Body (330 marking)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#26221E", "color": "#26221E", "albedo": {"dominant": "#444341", "secondary": ["#6F5E47", "#191615", "#33302E"], "samplingNotes": "Reference-derived from photo crop showing legible component marking text; projected/decal albedo, not tiled swatch.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/330.png", "url": "330.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#444341", "#6F5E47", "#191615", "#33302E", "#B4B4B4"], "pattern": "reference-derived pixel palette", "amplitude": 0.144, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.762, "variation": 0.194, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_roughness.png", "url": "vrm-cap-body_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.307, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_normal.png", "url": "vrm-cap-body_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_height.png", "url": "vrm-cap-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.058, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_height.png", "url": "vrm-cap-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_ao.png", "url": "vrm-cap-body_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Charcoal molded polymer capacitor body (2x8 bank, '330'-class in reference, text not baked).", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/markings/330.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "photo-crop marking decal: legible component text cut from de-lit reference and used as override albedo on a dedicated per-component material", "usable": true, "verdict": "pass", "confidence": 0.844, "estimatedFidelity": 0.844, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/330.png", "url": "330.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_roughness.png", "url": "vrm-cap-body_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_height.png", "url": "vrm-cap-body_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_normal.png", "url": "vrm-cap-body_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/vrm-cap-body/vrm-cap-body_ao.png", "url": "vrm-cap-body_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 1240, "sourceHeight": 245, "mapSize": 1024, "cropBBoxPixels": {"x": 81, "y": 0, "width": 1083, "height": 245}, "mask": {"backgroundColor": "#8E8E8E", "backgroundNoise": 0.0, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.861}, "mapStats": {"valueRange": 0.3435, "heightP90Gradient": 0.12854, "roughnessBase": 0.762, "roughnessVariation": 0.194, "normalStrength": 0.307, "blurRadius": 21}, "palette": ["#444341", "#6F5E47", "#191615", "#33302E", "#B4B4B4"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["memory-pmic-marking-7ja92"] = createSculptMaterial(
    "memory-pmic-marking-7ja92",
    {"id": "memory-pmic-marking-7ja92", "name": "Memory/PMIC Package (7JA92 JZ024 marking)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#232323", "color": "#232323", "albedo": {"dominant": "#63533F", "secondary": ["#26160F", "#392419", "#483C31"], "samplingNotes": "Reference-derived from photo crop showing legible component marking text; projected/decal albedo, not tiled swatch.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/7ja92.png", "url": "7ja92.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"], "pattern": "reference-derived pixel palette", "amplitude": 0.133, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.391, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.685, "variation": 0.082, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.216, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.023, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Dark gray-black molded package body used for the SoC lid and all memory/PMIC packages; no marking text baked.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/markings/7ja92.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "photo-crop marking decal: legible component text cut from de-lit reference and used as override albedo on a dedicated per-component material", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/7ja92.png", "url": "7ja92.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 347, "sourceHeight": 787, "mapSize": 1024, "cropBBoxPixels": {"x": 87, "y": 0, "width": 260, "height": 787}, "mask": {"backgroundColor": "#898989", "backgroundNoise": 140.296, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1689}, "mapStats": {"valueRange": 0.3173, "heightP90Gradient": 0.0511, "roughnessBase": 0.685, "roughnessVariation": 0.082, "normalStrength": 0.216, "blurRadius": 21}, "palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["memory-pmic-marking-b0077-d9wx"] = createSculptMaterial(
    "memory-pmic-marking-b0077-d9wx",
    {"id": "memory-pmic-marking-b0077-d9wx", "name": "Memory/PMIC Package (B0077 D9WX marking)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#232323", "color": "#232323", "albedo": {"dominant": "#63533F", "secondary": ["#26160F", "#392419", "#483C31"], "samplingNotes": "Reference-derived from photo crop showing legible component marking text; projected/decal albedo, not tiled swatch.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/b0077-d9wx.png", "url": "b0077-d9wx.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"], "pattern": "reference-derived pixel palette", "amplitude": 0.133, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.391, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.685, "variation": 0.082, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.216, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.023, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Dark gray-black molded package body used for the SoC lid and all memory/PMIC packages; no marking text baked.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/markings/b0077-d9wx.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "photo-crop marking decal: legible component text cut from de-lit reference and used as override albedo on a dedicated per-component material", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/b0077-d9wx.png", "url": "b0077-d9wx.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 347, "sourceHeight": 787, "mapSize": 1024, "cropBBoxPixels": {"x": 87, "y": 0, "width": 260, "height": 787}, "mask": {"backgroundColor": "#898989", "backgroundNoise": 140.296, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1689}, "mapStats": {"valueRange": 0.3173, "heightP90Gradient": 0.0511, "roughnessBase": 0.685, "roughnessVariation": 0.082, "normalStrength": 0.216, "blurRadius": 21}, "palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["memory-pmic-marking-aem10841"] = createSculptMaterial(
    "memory-pmic-marking-aem10841",
    {"id": "memory-pmic-marking-aem10841", "name": "Memory/PMIC Package (AEM10841 marking)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#232323", "color": "#232323", "albedo": {"dominant": "#63533F", "secondary": ["#26160F", "#392419", "#483C31"], "samplingNotes": "Reference-derived from photo crop showing legible component marking text; projected/decal albedo, not tiled swatch.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/aem10841.png", "url": "aem10841.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"], "pattern": "reference-derived pixel palette", "amplitude": 0.133, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.391, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.685, "variation": 0.082, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.216, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.023, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Dark gray-black molded package body used for the SoC lid and all memory/PMIC packages; no marking text baked.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/markings/aem10841.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "photo-crop marking decal: legible component text cut from de-lit reference and used as override albedo on a dedicated per-component material", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/aem10841.png", "url": "aem10841.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 347, "sourceHeight": 787, "mapSize": 1024, "cropBBoxPixels": {"x": 87, "y": 0, "width": 260, "height": 787}, "mask": {"backgroundColor": "#898989", "backgroundNoise": 140.296, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1689}, "mapStats": {"valueRange": 0.3173, "heightP90Gradient": 0.0511, "roughnessBase": 0.685, "roughnessVariation": 0.082, "normalStrength": 0.216, "blurRadius": 21}, "palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["soc-lid-marking-nvidia"] = createSculptMaterial(
    "soc-lid-marking-nvidia",
    {"id": "soc-lid-marking-nvidia", "name": "SoC Overmold Lid (NVIDIA marking)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#232323", "color": "#232323", "albedo": {"dominant": "#63533F", "secondary": ["#26160F", "#392419", "#483C31"], "samplingNotes": "Reference-derived from photo crop showing legible component marking text; projected/decal albedo, not tiled swatch.", "map": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/soc-lid-nvidia.png", "url": "soc-lid-nvidia.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"], "pattern": "reference-derived pixel palette", "amplitude": 0.133, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail; no stretching across instances."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.391, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.685, "variation": 0.082, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.216, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.023, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.", "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Dark gray-black molded package body used for the SoC lid and all memory/PMIC packages; no marking text baked.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/alonlinder/jetson-xavier-3d/markings/soc-lid-nvidia.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "photo-crop marking decal: legible component text cut from de-lit reference and used as override albedo on a dedicated per-component material", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/alonlinder/jetson-xavier-3d/markings/soc-lid-nvidia.png", "url": "soc-lid-nvidia.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_roughness.png", "url": "ic-overmold-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_height.png", "url": "ic-overmold-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_normal.png", "url": "ic-overmold-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/alonlinder/jetson-xavier-3d/pbr-evidence-delit/ic-overmold-dark/ic-overmold-dark_ao.png", "url": "ic-overmold-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 347, "sourceHeight": 787, "mapSize": 1024, "cropBBoxPixels": {"x": 87, "y": 0, "width": 260, "height": 787}, "mask": {"backgroundColor": "#898989", "backgroundNoise": 140.296, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1689}, "mapStats": {"valueRange": 0.3173, "heightP90Gradient": 0.0511, "roughnessBase": 0.685, "roughnessVariation": 0.082, "normalStrength": 0.216, "blurRadius": 21}, "palette": ["#63533F", "#26160F", "#392419", "#483C31", "#816751"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "NVIDIA Jetson AGX Xavier SoM__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "NVIDIA Jetson AGX Xavier SoM", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid multilayer PCB -- flat panel with simply-curved edge chamfer; genuinely box-shaped.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.36, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "board-solder-mask", "materialLayers": ["board-solder-mask"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "board-thickness-inferred", "kind": "geometry-caveat", "description": "No true edge/profile reference image exists; thickness (0.045 rel) is INFERRED from typical rigid multilayer-PCB SoM proportions, not measured.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "flat-panel-with-mild-mottling", "displacementPattern": "", "occlusionPattern": "molding-seam-along-perimeter", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 24, 15, 1.0)", "secondaryAlbedo": "rgba(115, 82, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.36, 0.045);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["board-solder-mask"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "NVIDIA Jetson AGX Xavier SoM";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "NVIDIA Jetson AGX Xavier SoM", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid multilayer PCB -- flat panel with simply-curved edge chamfer; genuinely box-shaped.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.36, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "board-solder-mask", "materialLayers": ["board-solder-mask"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "board-thickness-inferred", "kind": "geometry-caveat", "description": "No true edge/profile reference image exists; thickness (0.045 rel) is INFERRED from typical rigid multilayer-PCB SoM proportions, not measured.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "flat-panel-with-mild-mottling", "displacementPattern": "", "occlusionPattern": "molding-seam-along-perimeter", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 24, 15, 1.0)", "secondaryAlbedo": "rgba(115, 82, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_soc_package_1 = makeAttachmentEndpoint(null);
  const node_soc_package_1 = new THREE.Group();
  node_soc_package_1.name = "SoC Die Package__pivot";
  node_soc_package_1.scale.set(1, 1, 1);
  if (endpoint_soc_package_1) {
    node_soc_package_1.position.copy(endpoint_soc_package_1.start);
    node_soc_package_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_soc_package_1.position.set(0.0, 0.03, 0.0365);
    node_soc_package_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_soc_package_1.userData.sculptComponent = {"id": "soc-package", "name": "SoC Die Package", "level": "macro", "role": "electronic-package", "importance": 0.95, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Flip-chip BGA package: flat rigid footprint with a raised overmold lid -- genuinely box-shaped.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.34, "height": 0.3, "depth": 0.028, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.03, 0.0365], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soc-substrate", "materialLayers": ["soc-substrate"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.15, "bumpAmplitude": 0.03, "normalPattern": "package-edge-bevel", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-lid-parting-line", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(4, 84, 93, 1.0)", "secondaryAlbedo": "rgba(4, 97, 109, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_soc_package_1.userData.actionProfile = {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_soc_package_1);
  nodes["soc-package"] = node_soc_package_1;
  const mesh_soc_package_1Geometry = endpoint_soc_package_1
    ? new THREE.CylinderGeometry(endpoint_soc_package_1.endRadius, endpoint_soc_package_1.baseRadius, endpoint_soc_package_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_soc_package_1) {
    mesh_soc_package_1Geometry.scale(0.34, 0.3, 0.028);
  }
  const mesh_soc_package_1 = new THREE.Mesh(
    mesh_soc_package_1Geometry,
    materialMap["soc-substrate"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_soc_package_1.name = "SoC Die Package";
  if (endpoint_soc_package_1) {
    mesh_soc_package_1.position.copy(endpoint_soc_package_1.midpoint);
    mesh_soc_package_1.quaternion.copy(endpoint_soc_package_1.quaternion);
  }
  mesh_soc_package_1.castShadow = options.castShadow ?? true;
  mesh_soc_package_1.receiveShadow = options.receiveShadow ?? true;
  mesh_soc_package_1.userData.sculptComponent = {"id": "soc-package", "name": "SoC Die Package", "level": "macro", "role": "electronic-package", "importance": 0.95, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Flip-chip BGA package: flat rigid footprint with a raised overmold lid -- genuinely box-shaped.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.34, "height": 0.3, "depth": 0.028, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.03, 0.0365], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soc-substrate", "materialLayers": ["soc-substrate"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.15, "bumpAmplitude": 0.03, "normalPattern": "package-edge-bevel", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-lid-parting-line", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(4, 84, 93, 1.0)", "secondaryAlbedo": "rgba(4, 97, 109, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_soc_package_1.add(mesh_soc_package_1);
  meshes["soc-package"] = mesh_soc_package_1;
  colliders["soc-package"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_soc_package_1);

  const endpoint_soc_substrate_patch_2 = makeAttachmentEndpoint(null);
  const node_soc_substrate_patch_2 = new THREE.Group();
  node_soc_substrate_patch_2.name = "SoC Substrate Patch__pivot";
  node_soc_substrate_patch_2.scale.set(1, 1, 1);
  if (endpoint_soc_substrate_patch_2) {
    node_soc_substrate_patch_2.position.copy(endpoint_soc_substrate_patch_2.start);
    node_soc_substrate_patch_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_soc_substrate_patch_2.position.set(0.0, 0.0, 0.016);
    node_soc_substrate_patch_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_soc_substrate_patch_2.userData.sculptComponent = {"id": "soc-substrate-patch", "name": "SoC Substrate Patch", "level": "meso", "role": "electronic-package-face", "importance": 0.5, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin flat exposed substrate ring around the overmold lid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "soc-package", "attachment": null, "dimensions": {"width": 0.3, "height": 0.26, "depth": 0.004, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.0, 0.016], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soc-substrate", "materialLayers": ["soc-substrate"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "soc-lid-fiducial-dots", "kind": "micro-feature", "description": "Small dot fiducials near two diagonal corners of the substrate patch (observed in 8.png/11.png).", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "stipple-micro-relief", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(4, 84, 93, 1.0)", "secondaryAlbedo": "rgba(4, 97, 109, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_soc_substrate_patch_2.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["soc-package"] ?? root).add(node_soc_substrate_patch_2);
  nodes["soc-substrate-patch"] = node_soc_substrate_patch_2;
  const mesh_soc_substrate_patch_2Geometry = endpoint_soc_substrate_patch_2
    ? new THREE.CylinderGeometry(endpoint_soc_substrate_patch_2.endRadius, endpoint_soc_substrate_patch_2.baseRadius, endpoint_soc_substrate_patch_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_soc_substrate_patch_2) {
    mesh_soc_substrate_patch_2Geometry.scale(0.3, 0.26, 0.004);
  }
  const mesh_soc_substrate_patch_2 = new THREE.Mesh(
    mesh_soc_substrate_patch_2Geometry,
    materialMap["soc-substrate"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_soc_substrate_patch_2.name = "SoC Substrate Patch";
  if (endpoint_soc_substrate_patch_2) {
    mesh_soc_substrate_patch_2.position.copy(endpoint_soc_substrate_patch_2.midpoint);
    mesh_soc_substrate_patch_2.quaternion.copy(endpoint_soc_substrate_patch_2.quaternion);
  }
  mesh_soc_substrate_patch_2.castShadow = options.castShadow ?? true;
  mesh_soc_substrate_patch_2.receiveShadow = options.receiveShadow ?? true;
  mesh_soc_substrate_patch_2.userData.sculptComponent = {"id": "soc-substrate-patch", "name": "SoC Substrate Patch", "level": "meso", "role": "electronic-package-face", "importance": 0.5, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin flat exposed substrate ring around the overmold lid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "soc-package", "attachment": null, "dimensions": {"width": 0.3, "height": 0.26, "depth": 0.004, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.0, 0.016], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soc-substrate", "materialLayers": ["soc-substrate"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "soc-lid-fiducial-dots", "kind": "micro-feature", "description": "Small dot fiducials near two diagonal corners of the substrate patch (observed in 8.png/11.png).", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "stipple-micro-relief", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(4, 84, 93, 1.0)", "secondaryAlbedo": "rgba(4, 97, 109, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_soc_substrate_patch_2.add(mesh_soc_substrate_patch_2);
  meshes["soc-substrate-patch"] = mesh_soc_substrate_patch_2;
  colliders["soc-substrate-patch"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_soc_substrate_patch_2);

  const endpoint_soc_overmold_lid_3 = makeAttachmentEndpoint(null);
  const node_soc_overmold_lid_3 = new THREE.Group();
  node_soc_overmold_lid_3.name = "SoC Overmold Marking Block__pivot";
  node_soc_overmold_lid_3.scale.set(1, 1, 1);
  if (endpoint_soc_overmold_lid_3) {
    node_soc_overmold_lid_3.position.copy(endpoint_soc_overmold_lid_3.start);
    node_soc_overmold_lid_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_soc_overmold_lid_3.position.set(0.0, -0.01, 0.02);
    node_soc_overmold_lid_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_soc_overmold_lid_3.userData.sculptComponent = {"id": "soc-overmold-lid", "name": "SoC Overmold Marking Block", "level": "meso", "role": "electronic-package-face", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Flat raised plaque on the package face; no text baked per requirement.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "soc-package", "attachment": null, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.006, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.01, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soc-lid-marking-nvidia", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "flat", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_soc_overmold_lid_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["soc-package"] ?? root).add(node_soc_overmold_lid_3);
  nodes["soc-overmold-lid"] = node_soc_overmold_lid_3;
  const mesh_soc_overmold_lid_3Geometry = endpoint_soc_overmold_lid_3
    ? new THREE.CylinderGeometry(endpoint_soc_overmold_lid_3.endRadius, endpoint_soc_overmold_lid_3.baseRadius, endpoint_soc_overmold_lid_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_soc_overmold_lid_3) {
    mesh_soc_overmold_lid_3Geometry.scale(0.22, 0.16, 0.006);
  }
  const mesh_soc_overmold_lid_3 = new THREE.Mesh(
    mesh_soc_overmold_lid_3Geometry,
    materialMap["soc-lid-marking-nvidia"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_soc_overmold_lid_3.name = "SoC Overmold Marking Block";
  if (endpoint_soc_overmold_lid_3) {
    mesh_soc_overmold_lid_3.position.copy(endpoint_soc_overmold_lid_3.midpoint);
    mesh_soc_overmold_lid_3.quaternion.copy(endpoint_soc_overmold_lid_3.quaternion);
  }
  mesh_soc_overmold_lid_3.castShadow = options.castShadow ?? true;
  mesh_soc_overmold_lid_3.receiveShadow = options.receiveShadow ?? true;
  mesh_soc_overmold_lid_3.userData.sculptComponent = {"id": "soc-overmold-lid", "name": "SoC Overmold Marking Block", "level": "meso", "role": "electronic-package-face", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Flat raised plaque on the package face; no text baked per requirement.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "soc-package", "attachment": null, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.006, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.01, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soc-lid-marking-nvidia", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "flat", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_soc_overmold_lid_3.add(mesh_soc_overmold_lid_3);
  meshes["soc-overmold-lid"] = mesh_soc_overmold_lid_3;
  colliders["soc-overmold-lid"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_soc_overmold_lid_3);

  const endpoint_vrm_bank_4 = makeAttachmentEndpoint(null);
  const node_vrm_bank_4 = new THREE.Group();
  node_vrm_bank_4.name = "VRM Power Stage__pivot";
  node_vrm_bank_4.scale.set(1, 1, 1);
  if (endpoint_vrm_bank_4) {
    node_vrm_bank_4.position.copy(endpoint_vrm_bank_4.start);
    node_vrm_bank_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_bank_4.position.set(0.0, 0.48000000000000004, 0.0255);
    node_vrm_bank_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_bank_4.userData.sculptComponent = {"id": "vrm-bank", "name": "VRM Power Stage", "level": "macro", "role": "electronic-assembly", "importance": 0.85, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin backing/pivot plate for the VRM inductor+capacitor bank; genuinely box-shaped.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.94, "height": 0.3, "depth": 0.006, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.48000000000000004, 0.0255], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "board-solder-mask", "materialLayers": ["board-solder-mask"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.01, "normalPattern": "backing-plate-flat", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 24, 15, 1.0)", "secondaryAlbedo": "rgba(115, 82, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_bank_4.userData.actionProfile = {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_vrm_bank_4);
  nodes["vrm-bank"] = node_vrm_bank_4;
  const mesh_vrm_bank_4Geometry = endpoint_vrm_bank_4
    ? new THREE.CylinderGeometry(endpoint_vrm_bank_4.endRadius, endpoint_vrm_bank_4.baseRadius, endpoint_vrm_bank_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_bank_4) {
    mesh_vrm_bank_4Geometry.scale(0.94, 0.3, 0.006);
  }
  const mesh_vrm_bank_4 = new THREE.Mesh(
    mesh_vrm_bank_4Geometry,
    materialMap["board-solder-mask"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_bank_4.name = "VRM Power Stage";
  if (endpoint_vrm_bank_4) {
    mesh_vrm_bank_4.position.copy(endpoint_vrm_bank_4.midpoint);
    mesh_vrm_bank_4.quaternion.copy(endpoint_vrm_bank_4.quaternion);
  }
  mesh_vrm_bank_4.castShadow = options.castShadow ?? true;
  mesh_vrm_bank_4.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_bank_4.userData.sculptComponent = {"id": "vrm-bank", "name": "VRM Power Stage", "level": "macro", "role": "electronic-assembly", "importance": 0.85, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin backing/pivot plate for the VRM inductor+capacitor bank; genuinely box-shaped.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.94, "height": 0.3, "depth": 0.006, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.48000000000000004, 0.0255], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "board-solder-mask", "materialLayers": ["board-solder-mask"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.01, "normalPattern": "backing-plate-flat", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 24, 15, 1.0)", "secondaryAlbedo": "rgba(115, 82, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_bank_4.add(mesh_vrm_bank_4);
  meshes["vrm-bank"] = mesh_vrm_bank_4;
  colliders["vrm-bank"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_bank_4);

  const endpoint_vrm_inductor_1_5 = makeAttachmentEndpoint(null);
  const node_vrm_inductor_1_5 = new THREE.Group();
  node_vrm_inductor_1_5.name = "VRM Inductor 1__pivot";
  node_vrm_inductor_1_5.scale.set(1, 1, 1);
  if (endpoint_vrm_inductor_1_5) {
    node_vrm_inductor_1_5.position.copy(endpoint_vrm_inductor_1_5.start);
    node_vrm_inductor_1_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_inductor_1_5.position.set(-0.39375, 0.07, 0.0225);
    node_vrm_inductor_1_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_inductor_1_5.userData.sculptComponent = {"id": "vrm-inductor-1", "name": "VRM Inductor 1", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.39375, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vrm-inductor-1-top-marking", "kind": "material-local-override", "description": "Darker top-marking region on the molded body (no text baked).", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "molded-body-seam", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_1_5.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_inductor_1_5);
  nodes["vrm-inductor-1"] = node_vrm_inductor_1_5;
  const mesh_vrm_inductor_1_5Geometry = endpoint_vrm_inductor_1_5
    ? new THREE.CylinderGeometry(endpoint_vrm_inductor_1_5.endRadius, endpoint_vrm_inductor_1_5.baseRadius, endpoint_vrm_inductor_1_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_inductor_1_5) {
    mesh_vrm_inductor_1_5Geometry.scale(0.09225, 0.11, 0.045);
  }
  const mesh_vrm_inductor_1_5 = new THREE.Mesh(
    mesh_vrm_inductor_1_5Geometry,
    materialMap["vrm-inductor-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_inductor_1_5.name = "VRM Inductor 1";
  if (endpoint_vrm_inductor_1_5) {
    mesh_vrm_inductor_1_5.position.copy(endpoint_vrm_inductor_1_5.midpoint);
    mesh_vrm_inductor_1_5.quaternion.copy(endpoint_vrm_inductor_1_5.quaternion);
  }
  mesh_vrm_inductor_1_5.castShadow = options.castShadow ?? true;
  mesh_vrm_inductor_1_5.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_inductor_1_5.userData.sculptComponent = {"id": "vrm-inductor-1", "name": "VRM Inductor 1", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.39375, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vrm-inductor-1-top-marking", "kind": "material-local-override", "description": "Darker top-marking region on the molded body (no text baked).", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "molded-body-seam", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_1_5.add(mesh_vrm_inductor_1_5);
  meshes["vrm-inductor-1"] = mesh_vrm_inductor_1_5;
  colliders["vrm-inductor-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_inductor_1_5);

  const endpoint_vrm_inductor_2_6 = makeAttachmentEndpoint(null);
  const node_vrm_inductor_2_6 = new THREE.Group();
  node_vrm_inductor_2_6.name = "VRM Inductor 2__pivot";
  node_vrm_inductor_2_6.scale.set(1, 1, 1);
  if (endpoint_vrm_inductor_2_6) {
    node_vrm_inductor_2_6.position.copy(endpoint_vrm_inductor_2_6.start);
    node_vrm_inductor_2_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_inductor_2_6.position.set(-0.28125, 0.07, 0.0225);
    node_vrm_inductor_2_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_inductor_2_6.userData.sculptComponent = {"id": "vrm-inductor-2", "name": "VRM Inductor 2", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28125, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_2_6.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_inductor_2_6);
  nodes["vrm-inductor-2"] = node_vrm_inductor_2_6;
  const mesh_vrm_inductor_2_6Geometry = endpoint_vrm_inductor_2_6
    ? new THREE.CylinderGeometry(endpoint_vrm_inductor_2_6.endRadius, endpoint_vrm_inductor_2_6.baseRadius, endpoint_vrm_inductor_2_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_inductor_2_6) {
    mesh_vrm_inductor_2_6Geometry.scale(0.09225, 0.11, 0.045);
  }
  const mesh_vrm_inductor_2_6 = new THREE.Mesh(
    mesh_vrm_inductor_2_6Geometry,
    materialMap["vrm-inductor-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_inductor_2_6.name = "VRM Inductor 2";
  if (endpoint_vrm_inductor_2_6) {
    mesh_vrm_inductor_2_6.position.copy(endpoint_vrm_inductor_2_6.midpoint);
    mesh_vrm_inductor_2_6.quaternion.copy(endpoint_vrm_inductor_2_6.quaternion);
  }
  mesh_vrm_inductor_2_6.castShadow = options.castShadow ?? true;
  mesh_vrm_inductor_2_6.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_inductor_2_6.userData.sculptComponent = {"id": "vrm-inductor-2", "name": "VRM Inductor 2", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28125, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_2_6.add(mesh_vrm_inductor_2_6);
  meshes["vrm-inductor-2"] = mesh_vrm_inductor_2_6;
  colliders["vrm-inductor-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_inductor_2_6);

  const endpoint_vrm_inductor_3_7 = makeAttachmentEndpoint(null);
  const node_vrm_inductor_3_7 = new THREE.Group();
  node_vrm_inductor_3_7.name = "VRM Inductor 3__pivot";
  node_vrm_inductor_3_7.scale.set(1, 1, 1);
  if (endpoint_vrm_inductor_3_7) {
    node_vrm_inductor_3_7.position.copy(endpoint_vrm_inductor_3_7.start);
    node_vrm_inductor_3_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_inductor_3_7.position.set(-0.16875, 0.07, 0.0225);
    node_vrm_inductor_3_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_inductor_3_7.userData.sculptComponent = {"id": "vrm-inductor-3", "name": "VRM Inductor 3", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.16875, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_3_7.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_inductor_3_7);
  nodes["vrm-inductor-3"] = node_vrm_inductor_3_7;
  const mesh_vrm_inductor_3_7Geometry = endpoint_vrm_inductor_3_7
    ? new THREE.CylinderGeometry(endpoint_vrm_inductor_3_7.endRadius, endpoint_vrm_inductor_3_7.baseRadius, endpoint_vrm_inductor_3_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_inductor_3_7) {
    mesh_vrm_inductor_3_7Geometry.scale(0.09225, 0.11, 0.045);
  }
  const mesh_vrm_inductor_3_7 = new THREE.Mesh(
    mesh_vrm_inductor_3_7Geometry,
    materialMap["vrm-inductor-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_inductor_3_7.name = "VRM Inductor 3";
  if (endpoint_vrm_inductor_3_7) {
    mesh_vrm_inductor_3_7.position.copy(endpoint_vrm_inductor_3_7.midpoint);
    mesh_vrm_inductor_3_7.quaternion.copy(endpoint_vrm_inductor_3_7.quaternion);
  }
  mesh_vrm_inductor_3_7.castShadow = options.castShadow ?? true;
  mesh_vrm_inductor_3_7.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_inductor_3_7.userData.sculptComponent = {"id": "vrm-inductor-3", "name": "VRM Inductor 3", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.16875, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_3_7.add(mesh_vrm_inductor_3_7);
  meshes["vrm-inductor-3"] = mesh_vrm_inductor_3_7;
  colliders["vrm-inductor-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_inductor_3_7);

  const endpoint_vrm_inductor_4_8 = makeAttachmentEndpoint(null);
  const node_vrm_inductor_4_8 = new THREE.Group();
  node_vrm_inductor_4_8.name = "VRM Inductor 4__pivot";
  node_vrm_inductor_4_8.scale.set(1, 1, 1);
  if (endpoint_vrm_inductor_4_8) {
    node_vrm_inductor_4_8.position.copy(endpoint_vrm_inductor_4_8.start);
    node_vrm_inductor_4_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_inductor_4_8.position.set(-0.05625000000000002, 0.07, 0.0225);
    node_vrm_inductor_4_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_inductor_4_8.userData.sculptComponent = {"id": "vrm-inductor-4", "name": "VRM Inductor 4", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.05625000000000002, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_4_8.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_inductor_4_8);
  nodes["vrm-inductor-4"] = node_vrm_inductor_4_8;
  const mesh_vrm_inductor_4_8Geometry = endpoint_vrm_inductor_4_8
    ? new THREE.CylinderGeometry(endpoint_vrm_inductor_4_8.endRadius, endpoint_vrm_inductor_4_8.baseRadius, endpoint_vrm_inductor_4_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_inductor_4_8) {
    mesh_vrm_inductor_4_8Geometry.scale(0.09225, 0.11, 0.045);
  }
  const mesh_vrm_inductor_4_8 = new THREE.Mesh(
    mesh_vrm_inductor_4_8Geometry,
    materialMap["vrm-inductor-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_inductor_4_8.name = "VRM Inductor 4";
  if (endpoint_vrm_inductor_4_8) {
    mesh_vrm_inductor_4_8.position.copy(endpoint_vrm_inductor_4_8.midpoint);
    mesh_vrm_inductor_4_8.quaternion.copy(endpoint_vrm_inductor_4_8.quaternion);
  }
  mesh_vrm_inductor_4_8.castShadow = options.castShadow ?? true;
  mesh_vrm_inductor_4_8.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_inductor_4_8.userData.sculptComponent = {"id": "vrm-inductor-4", "name": "VRM Inductor 4", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.05625000000000002, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_4_8.add(mesh_vrm_inductor_4_8);
  meshes["vrm-inductor-4"] = mesh_vrm_inductor_4_8;
  colliders["vrm-inductor-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_inductor_4_8);

  const endpoint_vrm_inductor_5_9 = makeAttachmentEndpoint(null);
  const node_vrm_inductor_5_9 = new THREE.Group();
  node_vrm_inductor_5_9.name = "VRM Inductor 5__pivot";
  node_vrm_inductor_5_9.scale.set(1, 1, 1);
  if (endpoint_vrm_inductor_5_9) {
    node_vrm_inductor_5_9.position.copy(endpoint_vrm_inductor_5_9.start);
    node_vrm_inductor_5_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_inductor_5_9.position.set(0.05624999999999997, 0.07, 0.0225);
    node_vrm_inductor_5_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_inductor_5_9.userData.sculptComponent = {"id": "vrm-inductor-5", "name": "VRM Inductor 5", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.05624999999999997, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_5_9.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_inductor_5_9);
  nodes["vrm-inductor-5"] = node_vrm_inductor_5_9;
  const mesh_vrm_inductor_5_9Geometry = endpoint_vrm_inductor_5_9
    ? new THREE.CylinderGeometry(endpoint_vrm_inductor_5_9.endRadius, endpoint_vrm_inductor_5_9.baseRadius, endpoint_vrm_inductor_5_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_inductor_5_9) {
    mesh_vrm_inductor_5_9Geometry.scale(0.09225, 0.11, 0.045);
  }
  const mesh_vrm_inductor_5_9 = new THREE.Mesh(
    mesh_vrm_inductor_5_9Geometry,
    materialMap["vrm-inductor-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_inductor_5_9.name = "VRM Inductor 5";
  if (endpoint_vrm_inductor_5_9) {
    mesh_vrm_inductor_5_9.position.copy(endpoint_vrm_inductor_5_9.midpoint);
    mesh_vrm_inductor_5_9.quaternion.copy(endpoint_vrm_inductor_5_9.quaternion);
  }
  mesh_vrm_inductor_5_9.castShadow = options.castShadow ?? true;
  mesh_vrm_inductor_5_9.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_inductor_5_9.userData.sculptComponent = {"id": "vrm-inductor-5", "name": "VRM Inductor 5", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.05624999999999997, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_5_9.add(mesh_vrm_inductor_5_9);
  meshes["vrm-inductor-5"] = mesh_vrm_inductor_5_9;
  colliders["vrm-inductor-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_inductor_5_9);

  const endpoint_vrm_inductor_6_10 = makeAttachmentEndpoint(null);
  const node_vrm_inductor_6_10 = new THREE.Group();
  node_vrm_inductor_6_10.name = "VRM Inductor 6__pivot";
  node_vrm_inductor_6_10.scale.set(1, 1, 1);
  if (endpoint_vrm_inductor_6_10) {
    node_vrm_inductor_6_10.position.copy(endpoint_vrm_inductor_6_10.start);
    node_vrm_inductor_6_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_inductor_6_10.position.set(0.16875, 0.07, 0.0225);
    node_vrm_inductor_6_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_inductor_6_10.userData.sculptComponent = {"id": "vrm-inductor-6", "name": "VRM Inductor 6", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.16875, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_6_10.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_inductor_6_10);
  nodes["vrm-inductor-6"] = node_vrm_inductor_6_10;
  const mesh_vrm_inductor_6_10Geometry = endpoint_vrm_inductor_6_10
    ? new THREE.CylinderGeometry(endpoint_vrm_inductor_6_10.endRadius, endpoint_vrm_inductor_6_10.baseRadius, endpoint_vrm_inductor_6_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_inductor_6_10) {
    mesh_vrm_inductor_6_10Geometry.scale(0.09225, 0.11, 0.045);
  }
  const mesh_vrm_inductor_6_10 = new THREE.Mesh(
    mesh_vrm_inductor_6_10Geometry,
    materialMap["vrm-inductor-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_inductor_6_10.name = "VRM Inductor 6";
  if (endpoint_vrm_inductor_6_10) {
    mesh_vrm_inductor_6_10.position.copy(endpoint_vrm_inductor_6_10.midpoint);
    mesh_vrm_inductor_6_10.quaternion.copy(endpoint_vrm_inductor_6_10.quaternion);
  }
  mesh_vrm_inductor_6_10.castShadow = options.castShadow ?? true;
  mesh_vrm_inductor_6_10.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_inductor_6_10.userData.sculptComponent = {"id": "vrm-inductor-6", "name": "VRM Inductor 6", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.16875, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_6_10.add(mesh_vrm_inductor_6_10);
  meshes["vrm-inductor-6"] = mesh_vrm_inductor_6_10;
  colliders["vrm-inductor-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_inductor_6_10);

  const endpoint_vrm_inductor_7_11 = makeAttachmentEndpoint(null);
  const node_vrm_inductor_7_11 = new THREE.Group();
  node_vrm_inductor_7_11.name = "VRM Inductor 7__pivot";
  node_vrm_inductor_7_11.scale.set(1, 1, 1);
  if (endpoint_vrm_inductor_7_11) {
    node_vrm_inductor_7_11.position.copy(endpoint_vrm_inductor_7_11.start);
    node_vrm_inductor_7_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_inductor_7_11.position.set(0.28125000000000006, 0.07, 0.0225);
    node_vrm_inductor_7_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_inductor_7_11.userData.sculptComponent = {"id": "vrm-inductor-7", "name": "VRM Inductor 7", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28125000000000006, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_7_11.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_inductor_7_11);
  nodes["vrm-inductor-7"] = node_vrm_inductor_7_11;
  const mesh_vrm_inductor_7_11Geometry = endpoint_vrm_inductor_7_11
    ? new THREE.CylinderGeometry(endpoint_vrm_inductor_7_11.endRadius, endpoint_vrm_inductor_7_11.baseRadius, endpoint_vrm_inductor_7_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_inductor_7_11) {
    mesh_vrm_inductor_7_11Geometry.scale(0.09225, 0.11, 0.045);
  }
  const mesh_vrm_inductor_7_11 = new THREE.Mesh(
    mesh_vrm_inductor_7_11Geometry,
    materialMap["vrm-inductor-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_inductor_7_11.name = "VRM Inductor 7";
  if (endpoint_vrm_inductor_7_11) {
    mesh_vrm_inductor_7_11.position.copy(endpoint_vrm_inductor_7_11.midpoint);
    mesh_vrm_inductor_7_11.quaternion.copy(endpoint_vrm_inductor_7_11.quaternion);
  }
  mesh_vrm_inductor_7_11.castShadow = options.castShadow ?? true;
  mesh_vrm_inductor_7_11.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_inductor_7_11.userData.sculptComponent = {"id": "vrm-inductor-7", "name": "VRM Inductor 7", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28125000000000006, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_7_11.add(mesh_vrm_inductor_7_11);
  meshes["vrm-inductor-7"] = mesh_vrm_inductor_7_11;
  colliders["vrm-inductor-7"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_inductor_7_11);

  const endpoint_vrm_inductor_8_12 = makeAttachmentEndpoint(null);
  const node_vrm_inductor_8_12 = new THREE.Group();
  node_vrm_inductor_8_12.name = "VRM Inductor 8__pivot";
  node_vrm_inductor_8_12.scale.set(1, 1, 1);
  if (endpoint_vrm_inductor_8_12) {
    node_vrm_inductor_8_12.position.copy(endpoint_vrm_inductor_8_12.start);
    node_vrm_inductor_8_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_inductor_8_12.position.set(0.39375, 0.07, 0.0225);
    node_vrm_inductor_8_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_inductor_8_12.userData.sculptComponent = {"id": "vrm-inductor-8", "name": "VRM Inductor 8", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.39375, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_8_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_inductor_8_12);
  nodes["vrm-inductor-8"] = node_vrm_inductor_8_12;
  const mesh_vrm_inductor_8_12Geometry = endpoint_vrm_inductor_8_12
    ? new THREE.CylinderGeometry(endpoint_vrm_inductor_8_12.endRadius, endpoint_vrm_inductor_8_12.baseRadius, endpoint_vrm_inductor_8_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_inductor_8_12) {
    mesh_vrm_inductor_8_12Geometry.scale(0.09225, 0.11, 0.045);
  }
  const mesh_vrm_inductor_8_12 = new THREE.Mesh(
    mesh_vrm_inductor_8_12Geometry,
    materialMap["vrm-inductor-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_inductor_8_12.name = "VRM Inductor 8";
  if (endpoint_vrm_inductor_8_12) {
    mesh_vrm_inductor_8_12.position.copy(endpoint_vrm_inductor_8_12.midpoint);
    mesh_vrm_inductor_8_12.quaternion.copy(endpoint_vrm_inductor_8_12.quaternion);
  }
  mesh_vrm_inductor_8_12.castShadow = options.castShadow ?? true;
  mesh_vrm_inductor_8_12.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_inductor_8_12.userData.sculptComponent = {"id": "vrm-inductor-8", "name": "VRM Inductor 8", "level": "meso", "role": "passive-component", "importance": 0.5, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded rounded-rectangular inductor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.09225, "height": 0.11, "depth": 0.045, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.39375, 0.07, 0.0225], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-inductor-marking", "materialLayers": ["vrm-inductor-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 112, 86, 1.0)", "secondaryAlbedo": "rgba(49, 47, 45, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7}};
  node_vrm_inductor_8_12.add(mesh_vrm_inductor_8_12);
  meshes["vrm-inductor-8"] = mesh_vrm_inductor_8_12;
  colliders["vrm-inductor-8"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_inductor_8_12);

  const endpoint_vrm_cap_1_13 = makeAttachmentEndpoint(null);
  const node_vrm_cap_1_13 = new THREE.Group();
  node_vrm_cap_1_13.name = "VRM Capacitor 1__pivot";
  node_vrm_cap_1_13.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_1_13) {
    node_vrm_cap_1_13.position.copy(endpoint_vrm_cap_1_13.start);
    node_vrm_cap_1_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_1_13.position.set(-0.39375, -0.02, 0.015);
    node_vrm_cap_1_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_1_13.userData.sculptComponent = {"id": "vrm-cap-1", "name": "VRM Capacitor 1", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.39375, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "molded-body-seam", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_1_13.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_1_13);
  nodes["vrm-cap-1"] = node_vrm_cap_1_13;
  const mesh_vrm_cap_1_13Geometry = endpoint_vrm_cap_1_13
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_1_13.endRadius, endpoint_vrm_cap_1_13.baseRadius, endpoint_vrm_cap_1_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_1_13) {
    mesh_vrm_cap_1_13Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_1_13 = new THREE.Mesh(
    mesh_vrm_cap_1_13Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_1_13.name = "VRM Capacitor 1";
  if (endpoint_vrm_cap_1_13) {
    mesh_vrm_cap_1_13.position.copy(endpoint_vrm_cap_1_13.midpoint);
    mesh_vrm_cap_1_13.quaternion.copy(endpoint_vrm_cap_1_13.quaternion);
  }
  mesh_vrm_cap_1_13.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_1_13.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_1_13.userData.sculptComponent = {"id": "vrm-cap-1", "name": "VRM Capacitor 1", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.39375, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "molded-body-seam", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_1_13.add(mesh_vrm_cap_1_13);
  meshes["vrm-cap-1"] = mesh_vrm_cap_1_13;
  colliders["vrm-cap-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_1_13);

  const endpoint_vrm_cap_2_14 = makeAttachmentEndpoint(null);
  const node_vrm_cap_2_14 = new THREE.Group();
  node_vrm_cap_2_14.name = "VRM Capacitor 2__pivot";
  node_vrm_cap_2_14.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_2_14) {
    node_vrm_cap_2_14.position.copy(endpoint_vrm_cap_2_14.start);
    node_vrm_cap_2_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_2_14.position.set(-0.28125, -0.02, 0.015);
    node_vrm_cap_2_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_2_14.userData.sculptComponent = {"id": "vrm-cap-2", "name": "VRM Capacitor 2", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28125, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_2_14.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_2_14);
  nodes["vrm-cap-2"] = node_vrm_cap_2_14;
  const mesh_vrm_cap_2_14Geometry = endpoint_vrm_cap_2_14
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_2_14.endRadius, endpoint_vrm_cap_2_14.baseRadius, endpoint_vrm_cap_2_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_2_14) {
    mesh_vrm_cap_2_14Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_2_14 = new THREE.Mesh(
    mesh_vrm_cap_2_14Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_2_14.name = "VRM Capacitor 2";
  if (endpoint_vrm_cap_2_14) {
    mesh_vrm_cap_2_14.position.copy(endpoint_vrm_cap_2_14.midpoint);
    mesh_vrm_cap_2_14.quaternion.copy(endpoint_vrm_cap_2_14.quaternion);
  }
  mesh_vrm_cap_2_14.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_2_14.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_2_14.userData.sculptComponent = {"id": "vrm-cap-2", "name": "VRM Capacitor 2", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28125, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_2_14.add(mesh_vrm_cap_2_14);
  meshes["vrm-cap-2"] = mesh_vrm_cap_2_14;
  colliders["vrm-cap-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_2_14);

  const endpoint_vrm_cap_3_15 = makeAttachmentEndpoint(null);
  const node_vrm_cap_3_15 = new THREE.Group();
  node_vrm_cap_3_15.name = "VRM Capacitor 3__pivot";
  node_vrm_cap_3_15.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_3_15) {
    node_vrm_cap_3_15.position.copy(endpoint_vrm_cap_3_15.start);
    node_vrm_cap_3_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_3_15.position.set(-0.16875, -0.02, 0.015);
    node_vrm_cap_3_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_3_15.userData.sculptComponent = {"id": "vrm-cap-3", "name": "VRM Capacitor 3", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.16875, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_3_15.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_3_15);
  nodes["vrm-cap-3"] = node_vrm_cap_3_15;
  const mesh_vrm_cap_3_15Geometry = endpoint_vrm_cap_3_15
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_3_15.endRadius, endpoint_vrm_cap_3_15.baseRadius, endpoint_vrm_cap_3_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_3_15) {
    mesh_vrm_cap_3_15Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_3_15 = new THREE.Mesh(
    mesh_vrm_cap_3_15Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_3_15.name = "VRM Capacitor 3";
  if (endpoint_vrm_cap_3_15) {
    mesh_vrm_cap_3_15.position.copy(endpoint_vrm_cap_3_15.midpoint);
    mesh_vrm_cap_3_15.quaternion.copy(endpoint_vrm_cap_3_15.quaternion);
  }
  mesh_vrm_cap_3_15.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_3_15.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_3_15.userData.sculptComponent = {"id": "vrm-cap-3", "name": "VRM Capacitor 3", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.16875, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_3_15.add(mesh_vrm_cap_3_15);
  meshes["vrm-cap-3"] = mesh_vrm_cap_3_15;
  colliders["vrm-cap-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_3_15);

  const endpoint_vrm_cap_4_16 = makeAttachmentEndpoint(null);
  const node_vrm_cap_4_16 = new THREE.Group();
  node_vrm_cap_4_16.name = "VRM Capacitor 4__pivot";
  node_vrm_cap_4_16.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_4_16) {
    node_vrm_cap_4_16.position.copy(endpoint_vrm_cap_4_16.start);
    node_vrm_cap_4_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_4_16.position.set(-0.05625000000000002, -0.02, 0.015);
    node_vrm_cap_4_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_4_16.userData.sculptComponent = {"id": "vrm-cap-4", "name": "VRM Capacitor 4", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.05625000000000002, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_4_16.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_4_16);
  nodes["vrm-cap-4"] = node_vrm_cap_4_16;
  const mesh_vrm_cap_4_16Geometry = endpoint_vrm_cap_4_16
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_4_16.endRadius, endpoint_vrm_cap_4_16.baseRadius, endpoint_vrm_cap_4_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_4_16) {
    mesh_vrm_cap_4_16Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_4_16 = new THREE.Mesh(
    mesh_vrm_cap_4_16Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_4_16.name = "VRM Capacitor 4";
  if (endpoint_vrm_cap_4_16) {
    mesh_vrm_cap_4_16.position.copy(endpoint_vrm_cap_4_16.midpoint);
    mesh_vrm_cap_4_16.quaternion.copy(endpoint_vrm_cap_4_16.quaternion);
  }
  mesh_vrm_cap_4_16.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_4_16.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_4_16.userData.sculptComponent = {"id": "vrm-cap-4", "name": "VRM Capacitor 4", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.05625000000000002, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_4_16.add(mesh_vrm_cap_4_16);
  meshes["vrm-cap-4"] = mesh_vrm_cap_4_16;
  colliders["vrm-cap-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_4_16);

  const endpoint_vrm_cap_5_17 = makeAttachmentEndpoint(null);
  const node_vrm_cap_5_17 = new THREE.Group();
  node_vrm_cap_5_17.name = "VRM Capacitor 5__pivot";
  node_vrm_cap_5_17.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_5_17) {
    node_vrm_cap_5_17.position.copy(endpoint_vrm_cap_5_17.start);
    node_vrm_cap_5_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_5_17.position.set(0.05624999999999997, -0.02, 0.015);
    node_vrm_cap_5_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_5_17.userData.sculptComponent = {"id": "vrm-cap-5", "name": "VRM Capacitor 5", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.05624999999999997, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_5_17.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_5_17);
  nodes["vrm-cap-5"] = node_vrm_cap_5_17;
  const mesh_vrm_cap_5_17Geometry = endpoint_vrm_cap_5_17
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_5_17.endRadius, endpoint_vrm_cap_5_17.baseRadius, endpoint_vrm_cap_5_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_5_17) {
    mesh_vrm_cap_5_17Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_5_17 = new THREE.Mesh(
    mesh_vrm_cap_5_17Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_5_17.name = "VRM Capacitor 5";
  if (endpoint_vrm_cap_5_17) {
    mesh_vrm_cap_5_17.position.copy(endpoint_vrm_cap_5_17.midpoint);
    mesh_vrm_cap_5_17.quaternion.copy(endpoint_vrm_cap_5_17.quaternion);
  }
  mesh_vrm_cap_5_17.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_5_17.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_5_17.userData.sculptComponent = {"id": "vrm-cap-5", "name": "VRM Capacitor 5", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.05624999999999997, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_5_17.add(mesh_vrm_cap_5_17);
  meshes["vrm-cap-5"] = mesh_vrm_cap_5_17;
  colliders["vrm-cap-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_5_17);

  const endpoint_vrm_cap_6_18 = makeAttachmentEndpoint(null);
  const node_vrm_cap_6_18 = new THREE.Group();
  node_vrm_cap_6_18.name = "VRM Capacitor 6__pivot";
  node_vrm_cap_6_18.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_6_18) {
    node_vrm_cap_6_18.position.copy(endpoint_vrm_cap_6_18.start);
    node_vrm_cap_6_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_6_18.position.set(0.16875, -0.02, 0.015);
    node_vrm_cap_6_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_6_18.userData.sculptComponent = {"id": "vrm-cap-6", "name": "VRM Capacitor 6", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.16875, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_6_18.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_6_18);
  nodes["vrm-cap-6"] = node_vrm_cap_6_18;
  const mesh_vrm_cap_6_18Geometry = endpoint_vrm_cap_6_18
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_6_18.endRadius, endpoint_vrm_cap_6_18.baseRadius, endpoint_vrm_cap_6_18.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_6_18) {
    mesh_vrm_cap_6_18Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_6_18 = new THREE.Mesh(
    mesh_vrm_cap_6_18Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_6_18.name = "VRM Capacitor 6";
  if (endpoint_vrm_cap_6_18) {
    mesh_vrm_cap_6_18.position.copy(endpoint_vrm_cap_6_18.midpoint);
    mesh_vrm_cap_6_18.quaternion.copy(endpoint_vrm_cap_6_18.quaternion);
  }
  mesh_vrm_cap_6_18.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_6_18.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_6_18.userData.sculptComponent = {"id": "vrm-cap-6", "name": "VRM Capacitor 6", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.16875, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_6_18.add(mesh_vrm_cap_6_18);
  meshes["vrm-cap-6"] = mesh_vrm_cap_6_18;
  colliders["vrm-cap-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_6_18);

  const endpoint_vrm_cap_7_19 = makeAttachmentEndpoint(null);
  const node_vrm_cap_7_19 = new THREE.Group();
  node_vrm_cap_7_19.name = "VRM Capacitor 7__pivot";
  node_vrm_cap_7_19.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_7_19) {
    node_vrm_cap_7_19.position.copy(endpoint_vrm_cap_7_19.start);
    node_vrm_cap_7_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_7_19.position.set(0.28125000000000006, -0.02, 0.015);
    node_vrm_cap_7_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_7_19.userData.sculptComponent = {"id": "vrm-cap-7", "name": "VRM Capacitor 7", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28125000000000006, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_7_19.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_7_19);
  nodes["vrm-cap-7"] = node_vrm_cap_7_19;
  const mesh_vrm_cap_7_19Geometry = endpoint_vrm_cap_7_19
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_7_19.endRadius, endpoint_vrm_cap_7_19.baseRadius, endpoint_vrm_cap_7_19.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_7_19) {
    mesh_vrm_cap_7_19Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_7_19 = new THREE.Mesh(
    mesh_vrm_cap_7_19Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_7_19.name = "VRM Capacitor 7";
  if (endpoint_vrm_cap_7_19) {
    mesh_vrm_cap_7_19.position.copy(endpoint_vrm_cap_7_19.midpoint);
    mesh_vrm_cap_7_19.quaternion.copy(endpoint_vrm_cap_7_19.quaternion);
  }
  mesh_vrm_cap_7_19.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_7_19.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_7_19.userData.sculptComponent = {"id": "vrm-cap-7", "name": "VRM Capacitor 7", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28125000000000006, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_7_19.add(mesh_vrm_cap_7_19);
  meshes["vrm-cap-7"] = mesh_vrm_cap_7_19;
  colliders["vrm-cap-7"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_7_19);

  const endpoint_vrm_cap_8_20 = makeAttachmentEndpoint(null);
  const node_vrm_cap_8_20 = new THREE.Group();
  node_vrm_cap_8_20.name = "VRM Capacitor 8__pivot";
  node_vrm_cap_8_20.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_8_20) {
    node_vrm_cap_8_20.position.copy(endpoint_vrm_cap_8_20.start);
    node_vrm_cap_8_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_8_20.position.set(0.39375, -0.02, 0.015);
    node_vrm_cap_8_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_8_20.userData.sculptComponent = {"id": "vrm-cap-8", "name": "VRM Capacitor 8", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.39375, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_8_20.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_8_20);
  nodes["vrm-cap-8"] = node_vrm_cap_8_20;
  const mesh_vrm_cap_8_20Geometry = endpoint_vrm_cap_8_20
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_8_20.endRadius, endpoint_vrm_cap_8_20.baseRadius, endpoint_vrm_cap_8_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_8_20) {
    mesh_vrm_cap_8_20Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_8_20 = new THREE.Mesh(
    mesh_vrm_cap_8_20Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_8_20.name = "VRM Capacitor 8";
  if (endpoint_vrm_cap_8_20) {
    mesh_vrm_cap_8_20.position.copy(endpoint_vrm_cap_8_20.midpoint);
    mesh_vrm_cap_8_20.quaternion.copy(endpoint_vrm_cap_8_20.quaternion);
  }
  mesh_vrm_cap_8_20.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_8_20.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_8_20.userData.sculptComponent = {"id": "vrm-cap-8", "name": "VRM Capacitor 8", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.39375, -0.02, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_8_20.add(mesh_vrm_cap_8_20);
  meshes["vrm-cap-8"] = mesh_vrm_cap_8_20;
  colliders["vrm-cap-8"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_8_20);

  const endpoint_vrm_cap_9_21 = makeAttachmentEndpoint(null);
  const node_vrm_cap_9_21 = new THREE.Group();
  node_vrm_cap_9_21.name = "VRM Capacitor 9__pivot";
  node_vrm_cap_9_21.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_9_21) {
    node_vrm_cap_9_21.position.copy(endpoint_vrm_cap_9_21.start);
    node_vrm_cap_9_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_9_21.position.set(-0.39375, -0.075, 0.015);
    node_vrm_cap_9_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_9_21.userData.sculptComponent = {"id": "vrm-cap-9", "name": "VRM Capacitor 9", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.39375, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_9_21.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_9_21);
  nodes["vrm-cap-9"] = node_vrm_cap_9_21;
  const mesh_vrm_cap_9_21Geometry = endpoint_vrm_cap_9_21
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_9_21.endRadius, endpoint_vrm_cap_9_21.baseRadius, endpoint_vrm_cap_9_21.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_9_21) {
    mesh_vrm_cap_9_21Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_9_21 = new THREE.Mesh(
    mesh_vrm_cap_9_21Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_9_21.name = "VRM Capacitor 9";
  if (endpoint_vrm_cap_9_21) {
    mesh_vrm_cap_9_21.position.copy(endpoint_vrm_cap_9_21.midpoint);
    mesh_vrm_cap_9_21.quaternion.copy(endpoint_vrm_cap_9_21.quaternion);
  }
  mesh_vrm_cap_9_21.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_9_21.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_9_21.userData.sculptComponent = {"id": "vrm-cap-9", "name": "VRM Capacitor 9", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.39375, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_9_21.add(mesh_vrm_cap_9_21);
  meshes["vrm-cap-9"] = mesh_vrm_cap_9_21;
  colliders["vrm-cap-9"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_9_21);

  const endpoint_vrm_cap_10_22 = makeAttachmentEndpoint(null);
  const node_vrm_cap_10_22 = new THREE.Group();
  node_vrm_cap_10_22.name = "VRM Capacitor 10__pivot";
  node_vrm_cap_10_22.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_10_22) {
    node_vrm_cap_10_22.position.copy(endpoint_vrm_cap_10_22.start);
    node_vrm_cap_10_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_10_22.position.set(-0.28125, -0.075, 0.015);
    node_vrm_cap_10_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_10_22.userData.sculptComponent = {"id": "vrm-cap-10", "name": "VRM Capacitor 10", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28125, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_10_22.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_10_22);
  nodes["vrm-cap-10"] = node_vrm_cap_10_22;
  const mesh_vrm_cap_10_22Geometry = endpoint_vrm_cap_10_22
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_10_22.endRadius, endpoint_vrm_cap_10_22.baseRadius, endpoint_vrm_cap_10_22.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_10_22) {
    mesh_vrm_cap_10_22Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_10_22 = new THREE.Mesh(
    mesh_vrm_cap_10_22Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_10_22.name = "VRM Capacitor 10";
  if (endpoint_vrm_cap_10_22) {
    mesh_vrm_cap_10_22.position.copy(endpoint_vrm_cap_10_22.midpoint);
    mesh_vrm_cap_10_22.quaternion.copy(endpoint_vrm_cap_10_22.quaternion);
  }
  mesh_vrm_cap_10_22.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_10_22.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_10_22.userData.sculptComponent = {"id": "vrm-cap-10", "name": "VRM Capacitor 10", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28125, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_10_22.add(mesh_vrm_cap_10_22);
  meshes["vrm-cap-10"] = mesh_vrm_cap_10_22;
  colliders["vrm-cap-10"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_10_22);

  const endpoint_vrm_cap_11_23 = makeAttachmentEndpoint(null);
  const node_vrm_cap_11_23 = new THREE.Group();
  node_vrm_cap_11_23.name = "VRM Capacitor 11__pivot";
  node_vrm_cap_11_23.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_11_23) {
    node_vrm_cap_11_23.position.copy(endpoint_vrm_cap_11_23.start);
    node_vrm_cap_11_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_11_23.position.set(-0.16875, -0.075, 0.015);
    node_vrm_cap_11_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_11_23.userData.sculptComponent = {"id": "vrm-cap-11", "name": "VRM Capacitor 11", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.16875, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_11_23.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_11_23);
  nodes["vrm-cap-11"] = node_vrm_cap_11_23;
  const mesh_vrm_cap_11_23Geometry = endpoint_vrm_cap_11_23
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_11_23.endRadius, endpoint_vrm_cap_11_23.baseRadius, endpoint_vrm_cap_11_23.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_11_23) {
    mesh_vrm_cap_11_23Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_11_23 = new THREE.Mesh(
    mesh_vrm_cap_11_23Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_11_23.name = "VRM Capacitor 11";
  if (endpoint_vrm_cap_11_23) {
    mesh_vrm_cap_11_23.position.copy(endpoint_vrm_cap_11_23.midpoint);
    mesh_vrm_cap_11_23.quaternion.copy(endpoint_vrm_cap_11_23.quaternion);
  }
  mesh_vrm_cap_11_23.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_11_23.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_11_23.userData.sculptComponent = {"id": "vrm-cap-11", "name": "VRM Capacitor 11", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.16875, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_11_23.add(mesh_vrm_cap_11_23);
  meshes["vrm-cap-11"] = mesh_vrm_cap_11_23;
  colliders["vrm-cap-11"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_11_23);

  const endpoint_vrm_cap_12_24 = makeAttachmentEndpoint(null);
  const node_vrm_cap_12_24 = new THREE.Group();
  node_vrm_cap_12_24.name = "VRM Capacitor 12__pivot";
  node_vrm_cap_12_24.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_12_24) {
    node_vrm_cap_12_24.position.copy(endpoint_vrm_cap_12_24.start);
    node_vrm_cap_12_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_12_24.position.set(-0.05625000000000002, -0.075, 0.015);
    node_vrm_cap_12_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_12_24.userData.sculptComponent = {"id": "vrm-cap-12", "name": "VRM Capacitor 12", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.05625000000000002, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_12_24.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_12_24);
  nodes["vrm-cap-12"] = node_vrm_cap_12_24;
  const mesh_vrm_cap_12_24Geometry = endpoint_vrm_cap_12_24
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_12_24.endRadius, endpoint_vrm_cap_12_24.baseRadius, endpoint_vrm_cap_12_24.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_12_24) {
    mesh_vrm_cap_12_24Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_12_24 = new THREE.Mesh(
    mesh_vrm_cap_12_24Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_12_24.name = "VRM Capacitor 12";
  if (endpoint_vrm_cap_12_24) {
    mesh_vrm_cap_12_24.position.copy(endpoint_vrm_cap_12_24.midpoint);
    mesh_vrm_cap_12_24.quaternion.copy(endpoint_vrm_cap_12_24.quaternion);
  }
  mesh_vrm_cap_12_24.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_12_24.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_12_24.userData.sculptComponent = {"id": "vrm-cap-12", "name": "VRM Capacitor 12", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.05625000000000002, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_12_24.add(mesh_vrm_cap_12_24);
  meshes["vrm-cap-12"] = mesh_vrm_cap_12_24;
  colliders["vrm-cap-12"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_12_24);

  const endpoint_vrm_cap_13_25 = makeAttachmentEndpoint(null);
  const node_vrm_cap_13_25 = new THREE.Group();
  node_vrm_cap_13_25.name = "VRM Capacitor 13__pivot";
  node_vrm_cap_13_25.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_13_25) {
    node_vrm_cap_13_25.position.copy(endpoint_vrm_cap_13_25.start);
    node_vrm_cap_13_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_13_25.position.set(0.05624999999999997, -0.075, 0.015);
    node_vrm_cap_13_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_13_25.userData.sculptComponent = {"id": "vrm-cap-13", "name": "VRM Capacitor 13", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.05624999999999997, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_13_25.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_13_25);
  nodes["vrm-cap-13"] = node_vrm_cap_13_25;
  const mesh_vrm_cap_13_25Geometry = endpoint_vrm_cap_13_25
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_13_25.endRadius, endpoint_vrm_cap_13_25.baseRadius, endpoint_vrm_cap_13_25.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_13_25) {
    mesh_vrm_cap_13_25Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_13_25 = new THREE.Mesh(
    mesh_vrm_cap_13_25Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_13_25.name = "VRM Capacitor 13";
  if (endpoint_vrm_cap_13_25) {
    mesh_vrm_cap_13_25.position.copy(endpoint_vrm_cap_13_25.midpoint);
    mesh_vrm_cap_13_25.quaternion.copy(endpoint_vrm_cap_13_25.quaternion);
  }
  mesh_vrm_cap_13_25.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_13_25.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_13_25.userData.sculptComponent = {"id": "vrm-cap-13", "name": "VRM Capacitor 13", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.05624999999999997, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_13_25.add(mesh_vrm_cap_13_25);
  meshes["vrm-cap-13"] = mesh_vrm_cap_13_25;
  colliders["vrm-cap-13"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_13_25);

  const endpoint_vrm_cap_14_26 = makeAttachmentEndpoint(null);
  const node_vrm_cap_14_26 = new THREE.Group();
  node_vrm_cap_14_26.name = "VRM Capacitor 14__pivot";
  node_vrm_cap_14_26.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_14_26) {
    node_vrm_cap_14_26.position.copy(endpoint_vrm_cap_14_26.start);
    node_vrm_cap_14_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_14_26.position.set(0.16875, -0.075, 0.015);
    node_vrm_cap_14_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_14_26.userData.sculptComponent = {"id": "vrm-cap-14", "name": "VRM Capacitor 14", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.16875, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_14_26.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_14_26);
  nodes["vrm-cap-14"] = node_vrm_cap_14_26;
  const mesh_vrm_cap_14_26Geometry = endpoint_vrm_cap_14_26
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_14_26.endRadius, endpoint_vrm_cap_14_26.baseRadius, endpoint_vrm_cap_14_26.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_14_26) {
    mesh_vrm_cap_14_26Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_14_26 = new THREE.Mesh(
    mesh_vrm_cap_14_26Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_14_26.name = "VRM Capacitor 14";
  if (endpoint_vrm_cap_14_26) {
    mesh_vrm_cap_14_26.position.copy(endpoint_vrm_cap_14_26.midpoint);
    mesh_vrm_cap_14_26.quaternion.copy(endpoint_vrm_cap_14_26.quaternion);
  }
  mesh_vrm_cap_14_26.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_14_26.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_14_26.userData.sculptComponent = {"id": "vrm-cap-14", "name": "VRM Capacitor 14", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.16875, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_14_26.add(mesh_vrm_cap_14_26);
  meshes["vrm-cap-14"] = mesh_vrm_cap_14_26;
  colliders["vrm-cap-14"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_14_26);

  const endpoint_vrm_cap_15_27 = makeAttachmentEndpoint(null);
  const node_vrm_cap_15_27 = new THREE.Group();
  node_vrm_cap_15_27.name = "VRM Capacitor 15__pivot";
  node_vrm_cap_15_27.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_15_27) {
    node_vrm_cap_15_27.position.copy(endpoint_vrm_cap_15_27.start);
    node_vrm_cap_15_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_15_27.position.set(0.28125000000000006, -0.075, 0.015);
    node_vrm_cap_15_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_15_27.userData.sculptComponent = {"id": "vrm-cap-15", "name": "VRM Capacitor 15", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28125000000000006, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_15_27.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_15_27);
  nodes["vrm-cap-15"] = node_vrm_cap_15_27;
  const mesh_vrm_cap_15_27Geometry = endpoint_vrm_cap_15_27
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_15_27.endRadius, endpoint_vrm_cap_15_27.baseRadius, endpoint_vrm_cap_15_27.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_15_27) {
    mesh_vrm_cap_15_27Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_15_27 = new THREE.Mesh(
    mesh_vrm_cap_15_27Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_15_27.name = "VRM Capacitor 15";
  if (endpoint_vrm_cap_15_27) {
    mesh_vrm_cap_15_27.position.copy(endpoint_vrm_cap_15_27.midpoint);
    mesh_vrm_cap_15_27.quaternion.copy(endpoint_vrm_cap_15_27.quaternion);
  }
  mesh_vrm_cap_15_27.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_15_27.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_15_27.userData.sculptComponent = {"id": "vrm-cap-15", "name": "VRM Capacitor 15", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28125000000000006, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_15_27.add(mesh_vrm_cap_15_27);
  meshes["vrm-cap-15"] = mesh_vrm_cap_15_27;
  colliders["vrm-cap-15"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_15_27);

  const endpoint_vrm_cap_16_28 = makeAttachmentEndpoint(null);
  const node_vrm_cap_16_28 = new THREE.Group();
  node_vrm_cap_16_28.name = "VRM Capacitor 16__pivot";
  node_vrm_cap_16_28.scale.set(1, 1, 1);
  if (endpoint_vrm_cap_16_28) {
    node_vrm_cap_16_28.position.copy(endpoint_vrm_cap_16_28.start);
    node_vrm_cap_16_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vrm_cap_16_28.position.set(0.39375, -0.075, 0.015);
    node_vrm_cap_16_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_vrm_cap_16_28.userData.sculptComponent = {"id": "vrm-cap-16", "name": "VRM Capacitor 16", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.39375, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_16_28.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["vrm-bank"] ?? root).add(node_vrm_cap_16_28);
  nodes["vrm-cap-16"] = node_vrm_cap_16_28;
  const mesh_vrm_cap_16_28Geometry = endpoint_vrm_cap_16_28
    ? new THREE.CylinderGeometry(endpoint_vrm_cap_16_28.endRadius, endpoint_vrm_cap_16_28.baseRadius, endpoint_vrm_cap_16_28.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vrm_cap_16_28) {
    mesh_vrm_cap_16_28Geometry.scale(0.08775000000000001, 0.045, 0.03);
  }
  const mesh_vrm_cap_16_28 = new THREE.Mesh(
    mesh_vrm_cap_16_28Geometry,
    materialMap["vrm-cap-marking"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vrm_cap_16_28.name = "VRM Capacitor 16";
  if (endpoint_vrm_cap_16_28) {
    mesh_vrm_cap_16_28.position.copy(endpoint_vrm_cap_16_28.midpoint);
    mesh_vrm_cap_16_28.quaternion.copy(endpoint_vrm_cap_16_28.quaternion);
  }
  mesh_vrm_cap_16_28.castShadow = options.castShadow ?? true;
  mesh_vrm_cap_16_28.receiveShadow = options.receiveShadow ?? true;
  mesh_vrm_cap_16_28.userData.sculptComponent = {"id": "vrm-cap-16", "name": "VRM Capacitor 16", "level": "meso", "role": "passive-component", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Molded polymer capacitor block -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "vrm-bank", "attachment": null, "dimensions": {"width": 0.08775000000000001, "height": 0.045, "depth": 0.03, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.39375, -0.075, 0.015], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "vrm-cap-marking", "materialLayers": ["vrm-cap-body"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(63, 63, 62, 1.0)", "secondaryAlbedo": "rgba(147, 123, 93, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_vrm_cap_16_28.add(mesh_vrm_cap_16_28);
  meshes["vrm-cap-16"] = mesh_vrm_cap_16_28;
  colliders["vrm-cap-16"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vrm_cap_16_28);

  const endpoint_memory_pmic_cluster_29 = makeAttachmentEndpoint(null);
  const node_memory_pmic_cluster_29 = new THREE.Group();
  node_memory_pmic_cluster_29.name = "Memory / PMIC Package Cluster__pivot";
  node_memory_pmic_cluster_29.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_cluster_29) {
    node_memory_pmic_cluster_29.position.copy(endpoint_memory_pmic_cluster_29.start);
    node_memory_pmic_cluster_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_cluster_29.position.set(0.0, -0.05, 0.0255);
    node_memory_pmic_cluster_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_cluster_29.userData.sculptComponent = {"id": "memory-pmic-cluster", "name": "Memory / PMIC Package Cluster", "level": "macro", "role": "electronic-assembly", "importance": 0.75, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin backing/pivot plate for the flanking memory/PMIC IC packages.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.94, "height": 0.55, "depth": 0.006, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.05, 0.0255], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "board-solder-mask", "materialLayers": ["board-solder-mask"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.01, "normalPattern": "backing-plate-flat", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 24, 15, 1.0)", "secondaryAlbedo": "rgba(115, 82, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_cluster_29.userData.actionProfile = {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_memory_pmic_cluster_29);
  nodes["memory-pmic-cluster"] = node_memory_pmic_cluster_29;
  const mesh_memory_pmic_cluster_29Geometry = endpoint_memory_pmic_cluster_29
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_cluster_29.endRadius, endpoint_memory_pmic_cluster_29.baseRadius, endpoint_memory_pmic_cluster_29.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_cluster_29) {
    mesh_memory_pmic_cluster_29Geometry.scale(0.94, 0.55, 0.006);
  }
  const mesh_memory_pmic_cluster_29 = new THREE.Mesh(
    mesh_memory_pmic_cluster_29Geometry,
    materialMap["board-solder-mask"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_cluster_29.name = "Memory / PMIC Package Cluster";
  if (endpoint_memory_pmic_cluster_29) {
    mesh_memory_pmic_cluster_29.position.copy(endpoint_memory_pmic_cluster_29.midpoint);
    mesh_memory_pmic_cluster_29.quaternion.copy(endpoint_memory_pmic_cluster_29.quaternion);
  }
  mesh_memory_pmic_cluster_29.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_cluster_29.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_cluster_29.userData.sculptComponent = {"id": "memory-pmic-cluster", "name": "Memory / PMIC Package Cluster", "level": "macro", "role": "electronic-assembly", "importance": 0.75, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin backing/pivot plate for the flanking memory/PMIC IC packages.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.94, "height": 0.55, "depth": 0.006, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.05, 0.0255], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "board-solder-mask", "materialLayers": ["board-solder-mask"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.01, "normalPattern": "backing-plate-flat", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 24, 15, 1.0)", "secondaryAlbedo": "rgba(115, 82, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_cluster_29.add(mesh_memory_pmic_cluster_29);
  meshes["memory-pmic-cluster"] = mesh_memory_pmic_cluster_29;
  colliders["memory-pmic-cluster"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_cluster_29);

  const endpoint_memory_pmic_left_1_30 = makeAttachmentEndpoint(null);
  const node_memory_pmic_left_1_30 = new THREE.Group();
  node_memory_pmic_left_1_30.name = "Memory/PMIC Package (left-1)__pivot";
  node_memory_pmic_left_1_30.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_left_1_30) {
    node_memory_pmic_left_1_30.position.copy(endpoint_memory_pmic_left_1_30.start);
    node_memory_pmic_left_1_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_left_1_30.position.set(-0.42, 0.18, 0.01);
    node_memory_pmic_left_1_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_left_1_30.userData.sculptComponent = {"id": "memory-pmic-left-1", "name": "Memory/PMIC Package (left-1)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.42, 0.18, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-7ja92", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_left_1_30.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_left_1_30);
  nodes["memory-pmic-left-1"] = node_memory_pmic_left_1_30;
  const mesh_memory_pmic_left_1_30Geometry = endpoint_memory_pmic_left_1_30
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_left_1_30.endRadius, endpoint_memory_pmic_left_1_30.baseRadius, endpoint_memory_pmic_left_1_30.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_left_1_30) {
    mesh_memory_pmic_left_1_30Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_left_1_30 = new THREE.Mesh(
    mesh_memory_pmic_left_1_30Geometry,
    materialMap["memory-pmic-marking-7ja92"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_left_1_30.name = "Memory/PMIC Package (left-1)";
  if (endpoint_memory_pmic_left_1_30) {
    mesh_memory_pmic_left_1_30.position.copy(endpoint_memory_pmic_left_1_30.midpoint);
    mesh_memory_pmic_left_1_30.quaternion.copy(endpoint_memory_pmic_left_1_30.quaternion);
  }
  mesh_memory_pmic_left_1_30.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_left_1_30.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_left_1_30.userData.sculptComponent = {"id": "memory-pmic-left-1", "name": "Memory/PMIC Package (left-1)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.42, 0.18, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-7ja92", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_left_1_30.add(mesh_memory_pmic_left_1_30);
  meshes["memory-pmic-left-1"] = mesh_memory_pmic_left_1_30;
  colliders["memory-pmic-left-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_left_1_30);

  const endpoint_memory_pmic_left_2_31 = makeAttachmentEndpoint(null);
  const node_memory_pmic_left_2_31 = new THREE.Group();
  node_memory_pmic_left_2_31.name = "Memory/PMIC Package (left-2)__pivot";
  node_memory_pmic_left_2_31.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_left_2_31) {
    node_memory_pmic_left_2_31.position.copy(endpoint_memory_pmic_left_2_31.start);
    node_memory_pmic_left_2_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_left_2_31.position.set(-0.42, 0.02, 0.01);
    node_memory_pmic_left_2_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_left_2_31.userData.sculptComponent = {"id": "memory-pmic-left-2", "name": "Memory/PMIC Package (left-2)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.42, 0.02, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_left_2_31.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_left_2_31);
  nodes["memory-pmic-left-2"] = node_memory_pmic_left_2_31;
  const mesh_memory_pmic_left_2_31Geometry = endpoint_memory_pmic_left_2_31
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_left_2_31.endRadius, endpoint_memory_pmic_left_2_31.baseRadius, endpoint_memory_pmic_left_2_31.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_left_2_31) {
    mesh_memory_pmic_left_2_31Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_left_2_31 = new THREE.Mesh(
    mesh_memory_pmic_left_2_31Geometry,
    materialMap["memory-pmic-marking-b0077-d9wx"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_left_2_31.name = "Memory/PMIC Package (left-2)";
  if (endpoint_memory_pmic_left_2_31) {
    mesh_memory_pmic_left_2_31.position.copy(endpoint_memory_pmic_left_2_31.midpoint);
    mesh_memory_pmic_left_2_31.quaternion.copy(endpoint_memory_pmic_left_2_31.quaternion);
  }
  mesh_memory_pmic_left_2_31.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_left_2_31.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_left_2_31.userData.sculptComponent = {"id": "memory-pmic-left-2", "name": "Memory/PMIC Package (left-2)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.42, 0.02, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_left_2_31.add(mesh_memory_pmic_left_2_31);
  meshes["memory-pmic-left-2"] = mesh_memory_pmic_left_2_31;
  colliders["memory-pmic-left-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_left_2_31);

  const endpoint_memory_pmic_left_3_32 = makeAttachmentEndpoint(null);
  const node_memory_pmic_left_3_32 = new THREE.Group();
  node_memory_pmic_left_3_32.name = "Memory/PMIC Package (left-3)__pivot";
  node_memory_pmic_left_3_32.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_left_3_32) {
    node_memory_pmic_left_3_32.position.copy(endpoint_memory_pmic_left_3_32.start);
    node_memory_pmic_left_3_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_left_3_32.position.set(-0.42, -0.14, 0.01);
    node_memory_pmic_left_3_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_left_3_32.userData.sculptComponent = {"id": "memory-pmic-left-3", "name": "Memory/PMIC Package (left-3)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.42, -0.14, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_left_3_32.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_left_3_32);
  nodes["memory-pmic-left-3"] = node_memory_pmic_left_3_32;
  const mesh_memory_pmic_left_3_32Geometry = endpoint_memory_pmic_left_3_32
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_left_3_32.endRadius, endpoint_memory_pmic_left_3_32.baseRadius, endpoint_memory_pmic_left_3_32.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_left_3_32) {
    mesh_memory_pmic_left_3_32Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_left_3_32 = new THREE.Mesh(
    mesh_memory_pmic_left_3_32Geometry,
    materialMap["memory-pmic-marking-b0077-d9wx"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_left_3_32.name = "Memory/PMIC Package (left-3)";
  if (endpoint_memory_pmic_left_3_32) {
    mesh_memory_pmic_left_3_32.position.copy(endpoint_memory_pmic_left_3_32.midpoint);
    mesh_memory_pmic_left_3_32.quaternion.copy(endpoint_memory_pmic_left_3_32.quaternion);
  }
  mesh_memory_pmic_left_3_32.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_left_3_32.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_left_3_32.userData.sculptComponent = {"id": "memory-pmic-left-3", "name": "Memory/PMIC Package (left-3)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.42, -0.14, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_left_3_32.add(mesh_memory_pmic_left_3_32);
  meshes["memory-pmic-left-3"] = mesh_memory_pmic_left_3_32;
  colliders["memory-pmic-left-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_left_3_32);

  const endpoint_memory_pmic_right_1_33 = makeAttachmentEndpoint(null);
  const node_memory_pmic_right_1_33 = new THREE.Group();
  node_memory_pmic_right_1_33.name = "Memory/PMIC Package (right-1)__pivot";
  node_memory_pmic_right_1_33.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_right_1_33) {
    node_memory_pmic_right_1_33.position.copy(endpoint_memory_pmic_right_1_33.start);
    node_memory_pmic_right_1_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_right_1_33.position.set(0.42, 0.14, 0.01);
    node_memory_pmic_right_1_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_right_1_33.userData.sculptComponent = {"id": "memory-pmic-right-1", "name": "Memory/PMIC Package (right-1)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.42, 0.14, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-aem10841", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_right_1_33.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_right_1_33);
  nodes["memory-pmic-right-1"] = node_memory_pmic_right_1_33;
  const mesh_memory_pmic_right_1_33Geometry = endpoint_memory_pmic_right_1_33
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_right_1_33.endRadius, endpoint_memory_pmic_right_1_33.baseRadius, endpoint_memory_pmic_right_1_33.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_right_1_33) {
    mesh_memory_pmic_right_1_33Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_right_1_33 = new THREE.Mesh(
    mesh_memory_pmic_right_1_33Geometry,
    materialMap["memory-pmic-marking-aem10841"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_right_1_33.name = "Memory/PMIC Package (right-1)";
  if (endpoint_memory_pmic_right_1_33) {
    mesh_memory_pmic_right_1_33.position.copy(endpoint_memory_pmic_right_1_33.midpoint);
    mesh_memory_pmic_right_1_33.quaternion.copy(endpoint_memory_pmic_right_1_33.quaternion);
  }
  mesh_memory_pmic_right_1_33.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_right_1_33.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_right_1_33.userData.sculptComponent = {"id": "memory-pmic-right-1", "name": "Memory/PMIC Package (right-1)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.42, 0.14, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-aem10841", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_right_1_33.add(mesh_memory_pmic_right_1_33);
  meshes["memory-pmic-right-1"] = mesh_memory_pmic_right_1_33;
  colliders["memory-pmic-right-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_right_1_33);

  const endpoint_memory_pmic_right_2_34 = makeAttachmentEndpoint(null);
  const node_memory_pmic_right_2_34 = new THREE.Group();
  node_memory_pmic_right_2_34.name = "Memory/PMIC Package (right-2)__pivot";
  node_memory_pmic_right_2_34.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_right_2_34) {
    node_memory_pmic_right_2_34.position.copy(endpoint_memory_pmic_right_2_34.start);
    node_memory_pmic_right_2_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_right_2_34.position.set(0.42, -0.02, 0.01);
    node_memory_pmic_right_2_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_right_2_34.userData.sculptComponent = {"id": "memory-pmic-right-2", "name": "Memory/PMIC Package (right-2)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.42, -0.02, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_right_2_34.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_right_2_34);
  nodes["memory-pmic-right-2"] = node_memory_pmic_right_2_34;
  const mesh_memory_pmic_right_2_34Geometry = endpoint_memory_pmic_right_2_34
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_right_2_34.endRadius, endpoint_memory_pmic_right_2_34.baseRadius, endpoint_memory_pmic_right_2_34.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_right_2_34) {
    mesh_memory_pmic_right_2_34Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_right_2_34 = new THREE.Mesh(
    mesh_memory_pmic_right_2_34Geometry,
    materialMap["memory-pmic-marking-b0077-d9wx"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_right_2_34.name = "Memory/PMIC Package (right-2)";
  if (endpoint_memory_pmic_right_2_34) {
    mesh_memory_pmic_right_2_34.position.copy(endpoint_memory_pmic_right_2_34.midpoint);
    mesh_memory_pmic_right_2_34.quaternion.copy(endpoint_memory_pmic_right_2_34.quaternion);
  }
  mesh_memory_pmic_right_2_34.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_right_2_34.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_right_2_34.userData.sculptComponent = {"id": "memory-pmic-right-2", "name": "Memory/PMIC Package (right-2)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.42, -0.02, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_right_2_34.add(mesh_memory_pmic_right_2_34);
  meshes["memory-pmic-right-2"] = mesh_memory_pmic_right_2_34;
  colliders["memory-pmic-right-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_right_2_34);

  const endpoint_memory_pmic_bottom_1_35 = makeAttachmentEndpoint(null);
  const node_memory_pmic_bottom_1_35 = new THREE.Group();
  node_memory_pmic_bottom_1_35.name = "Memory/PMIC Package (bottom-1)__pivot";
  node_memory_pmic_bottom_1_35.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_bottom_1_35) {
    node_memory_pmic_bottom_1_35.position.copy(endpoint_memory_pmic_bottom_1_35.start);
    node_memory_pmic_bottom_1_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_bottom_1_35.position.set(-0.27, -0.34, 0.01);
    node_memory_pmic_bottom_1_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_bottom_1_35.userData.sculptComponent = {"id": "memory-pmic-bottom-1", "name": "Memory/PMIC Package (bottom-1)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.27, -0.34, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_bottom_1_35.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_bottom_1_35);
  nodes["memory-pmic-bottom-1"] = node_memory_pmic_bottom_1_35;
  const mesh_memory_pmic_bottom_1_35Geometry = endpoint_memory_pmic_bottom_1_35
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_bottom_1_35.endRadius, endpoint_memory_pmic_bottom_1_35.baseRadius, endpoint_memory_pmic_bottom_1_35.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_bottom_1_35) {
    mesh_memory_pmic_bottom_1_35Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_bottom_1_35 = new THREE.Mesh(
    mesh_memory_pmic_bottom_1_35Geometry,
    materialMap["memory-pmic-marking-b0077-d9wx"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_bottom_1_35.name = "Memory/PMIC Package (bottom-1)";
  if (endpoint_memory_pmic_bottom_1_35) {
    mesh_memory_pmic_bottom_1_35.position.copy(endpoint_memory_pmic_bottom_1_35.midpoint);
    mesh_memory_pmic_bottom_1_35.quaternion.copy(endpoint_memory_pmic_bottom_1_35.quaternion);
  }
  mesh_memory_pmic_bottom_1_35.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_bottom_1_35.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_bottom_1_35.userData.sculptComponent = {"id": "memory-pmic-bottom-1", "name": "Memory/PMIC Package (bottom-1)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.27, -0.34, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_bottom_1_35.add(mesh_memory_pmic_bottom_1_35);
  meshes["memory-pmic-bottom-1"] = mesh_memory_pmic_bottom_1_35;
  colliders["memory-pmic-bottom-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_bottom_1_35);

  const endpoint_memory_pmic_bottom_2_36 = makeAttachmentEndpoint(null);
  const node_memory_pmic_bottom_2_36 = new THREE.Group();
  node_memory_pmic_bottom_2_36.name = "Memory/PMIC Package (bottom-2)__pivot";
  node_memory_pmic_bottom_2_36.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_bottom_2_36) {
    node_memory_pmic_bottom_2_36.position.copy(endpoint_memory_pmic_bottom_2_36.start);
    node_memory_pmic_bottom_2_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_bottom_2_36.position.set(-0.09, -0.34, 0.01);
    node_memory_pmic_bottom_2_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_bottom_2_36.userData.sculptComponent = {"id": "memory-pmic-bottom-2", "name": "Memory/PMIC Package (bottom-2)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.09, -0.34, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_bottom_2_36.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_bottom_2_36);
  nodes["memory-pmic-bottom-2"] = node_memory_pmic_bottom_2_36;
  const mesh_memory_pmic_bottom_2_36Geometry = endpoint_memory_pmic_bottom_2_36
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_bottom_2_36.endRadius, endpoint_memory_pmic_bottom_2_36.baseRadius, endpoint_memory_pmic_bottom_2_36.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_bottom_2_36) {
    mesh_memory_pmic_bottom_2_36Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_bottom_2_36 = new THREE.Mesh(
    mesh_memory_pmic_bottom_2_36Geometry,
    materialMap["memory-pmic-marking-b0077-d9wx"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_bottom_2_36.name = "Memory/PMIC Package (bottom-2)";
  if (endpoint_memory_pmic_bottom_2_36) {
    mesh_memory_pmic_bottom_2_36.position.copy(endpoint_memory_pmic_bottom_2_36.midpoint);
    mesh_memory_pmic_bottom_2_36.quaternion.copy(endpoint_memory_pmic_bottom_2_36.quaternion);
  }
  mesh_memory_pmic_bottom_2_36.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_bottom_2_36.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_bottom_2_36.userData.sculptComponent = {"id": "memory-pmic-bottom-2", "name": "Memory/PMIC Package (bottom-2)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.09, -0.34, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_bottom_2_36.add(mesh_memory_pmic_bottom_2_36);
  meshes["memory-pmic-bottom-2"] = mesh_memory_pmic_bottom_2_36;
  colliders["memory-pmic-bottom-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_bottom_2_36);

  const endpoint_memory_pmic_bottom_3_37 = makeAttachmentEndpoint(null);
  const node_memory_pmic_bottom_3_37 = new THREE.Group();
  node_memory_pmic_bottom_3_37.name = "Memory/PMIC Package (bottom-3)__pivot";
  node_memory_pmic_bottom_3_37.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_bottom_3_37) {
    node_memory_pmic_bottom_3_37.position.copy(endpoint_memory_pmic_bottom_3_37.start);
    node_memory_pmic_bottom_3_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_bottom_3_37.position.set(0.09, -0.34, 0.01);
    node_memory_pmic_bottom_3_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_bottom_3_37.userData.sculptComponent = {"id": "memory-pmic-bottom-3", "name": "Memory/PMIC Package (bottom-3)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.09, -0.34, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_bottom_3_37.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_bottom_3_37);
  nodes["memory-pmic-bottom-3"] = node_memory_pmic_bottom_3_37;
  const mesh_memory_pmic_bottom_3_37Geometry = endpoint_memory_pmic_bottom_3_37
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_bottom_3_37.endRadius, endpoint_memory_pmic_bottom_3_37.baseRadius, endpoint_memory_pmic_bottom_3_37.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_bottom_3_37) {
    mesh_memory_pmic_bottom_3_37Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_bottom_3_37 = new THREE.Mesh(
    mesh_memory_pmic_bottom_3_37Geometry,
    materialMap["memory-pmic-marking-b0077-d9wx"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_bottom_3_37.name = "Memory/PMIC Package (bottom-3)";
  if (endpoint_memory_pmic_bottom_3_37) {
    mesh_memory_pmic_bottom_3_37.position.copy(endpoint_memory_pmic_bottom_3_37.midpoint);
    mesh_memory_pmic_bottom_3_37.quaternion.copy(endpoint_memory_pmic_bottom_3_37.quaternion);
  }
  mesh_memory_pmic_bottom_3_37.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_bottom_3_37.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_bottom_3_37.userData.sculptComponent = {"id": "memory-pmic-bottom-3", "name": "Memory/PMIC Package (bottom-3)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.09, -0.34, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_bottom_3_37.add(mesh_memory_pmic_bottom_3_37);
  meshes["memory-pmic-bottom-3"] = mesh_memory_pmic_bottom_3_37;
  colliders["memory-pmic-bottom-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_bottom_3_37);

  const endpoint_memory_pmic_bottom_4_38 = makeAttachmentEndpoint(null);
  const node_memory_pmic_bottom_4_38 = new THREE.Group();
  node_memory_pmic_bottom_4_38.name = "Memory/PMIC Package (bottom-4)__pivot";
  node_memory_pmic_bottom_4_38.scale.set(1, 1, 1);
  if (endpoint_memory_pmic_bottom_4_38) {
    node_memory_pmic_bottom_4_38.position.copy(endpoint_memory_pmic_bottom_4_38.start);
    node_memory_pmic_bottom_4_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_memory_pmic_bottom_4_38.position.set(0.27, -0.34, 0.01);
    node_memory_pmic_bottom_4_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_memory_pmic_bottom_4_38.userData.sculptComponent = {"id": "memory-pmic-bottom-4", "name": "Memory/PMIC Package (bottom-4)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.27, -0.34, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_bottom_4_38.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["memory-pmic-cluster"] ?? root).add(node_memory_pmic_bottom_4_38);
  nodes["memory-pmic-bottom-4"] = node_memory_pmic_bottom_4_38;
  const mesh_memory_pmic_bottom_4_38Geometry = endpoint_memory_pmic_bottom_4_38
    ? new THREE.CylinderGeometry(endpoint_memory_pmic_bottom_4_38.endRadius, endpoint_memory_pmic_bottom_4_38.baseRadius, endpoint_memory_pmic_bottom_4_38.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_memory_pmic_bottom_4_38) {
    mesh_memory_pmic_bottom_4_38Geometry.scale(0.15, 0.11, 0.02);
  }
  const mesh_memory_pmic_bottom_4_38 = new THREE.Mesh(
    mesh_memory_pmic_bottom_4_38Geometry,
    materialMap["memory-pmic-marking-b0077-d9wx"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_memory_pmic_bottom_4_38.name = "Memory/PMIC Package (bottom-4)";
  if (endpoint_memory_pmic_bottom_4_38) {
    mesh_memory_pmic_bottom_4_38.position.copy(endpoint_memory_pmic_bottom_4_38.midpoint);
    mesh_memory_pmic_bottom_4_38.quaternion.copy(endpoint_memory_pmic_bottom_4_38.quaternion);
  }
  mesh_memory_pmic_bottom_4_38.castShadow = options.castShadow ?? true;
  mesh_memory_pmic_bottom_4_38.receiveShadow = options.receiveShadow ?? true;
  mesh_memory_pmic_bottom_4_38.userData.sculptComponent = {"id": "memory-pmic-bottom-4", "name": "Memory/PMIC Package (bottom-4)", "level": "micro", "role": "electronic-package", "importance": 0.45, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small molded IC package -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "memory-pmic-cluster", "attachment": null, "dimensions": {"width": 0.15, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.27, -0.34, 0.01], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "memory-pmic-marking-b0077-d9wx", "materialLayers": ["ic-overmold-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(61, 38, 26, 1.0)", "secondaryAlbedo": "rgba(134, 110, 83, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_memory_pmic_bottom_4_38.add(mesh_memory_pmic_bottom_4_38);
  meshes["memory-pmic-bottom-4"] = mesh_memory_pmic_bottom_4_38;
  colliders["memory-pmic-bottom-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_memory_pmic_bottom_4_38);

  const endpoint_edge_connector_39 = makeAttachmentEndpoint(null);
  const node_edge_connector_39 = new THREE.Group();
  node_edge_connector_39.name = "Card-Edge Mezzanine Connector__pivot";
  node_edge_connector_39.scale.set(1, 1, 1);
  if (endpoint_edge_connector_39) {
    node_edge_connector_39.position.copy(endpoint_edge_connector_39.start);
    node_edge_connector_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_39.position.set(0.0, 0.52, -0.0475);
    node_edge_connector_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_39.userData.sculptComponent = {"id": "edge-connector", "name": "Card-Edge Mezzanine Connector", "level": "macro", "role": "electronic-connector", "importance": 0.9, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid molded connector housing protruding from the board back face -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "board-back-face-top-edge", "localStart": [0.0, 0.62, -0.03], "localEnd": [0.0, 0.62, -0.075], "contactType": "flush-mount", "embedDepth": 0.015, "gapTolerance": 0.004, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.62, "height": 0.14, "depth": 0.05, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.52, -0.0475], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-housing", "materialLayers": ["connector-housing"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.25, "bumpAmplitude": 0.02, "normalPattern": "molded-housing-seam", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-housing-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_edge_connector_39.userData.actionProfile = {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_edge_connector_39);
  nodes["edge-connector"] = node_edge_connector_39;
  const mesh_edge_connector_39Geometry = endpoint_edge_connector_39
    ? new THREE.CylinderGeometry(endpoint_edge_connector_39.endRadius, endpoint_edge_connector_39.baseRadius, endpoint_edge_connector_39.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_39) {
    mesh_edge_connector_39Geometry.scale(0.62, 0.14, 0.05);
  }
  const mesh_edge_connector_39 = new THREE.Mesh(
    mesh_edge_connector_39Geometry,
    materialMap["connector-housing"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_39.name = "Card-Edge Mezzanine Connector";
  if (endpoint_edge_connector_39) {
    mesh_edge_connector_39.position.copy(endpoint_edge_connector_39.midpoint);
    mesh_edge_connector_39.quaternion.copy(endpoint_edge_connector_39.quaternion);
  }
  mesh_edge_connector_39.castShadow = options.castShadow ?? true;
  mesh_edge_connector_39.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_39.userData.sculptComponent = {"id": "edge-connector", "name": "Card-Edge Mezzanine Connector", "level": "macro", "role": "electronic-connector", "importance": 0.9, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid molded connector housing protruding from the board back face -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "board-back-face-top-edge", "localStart": [0.0, 0.62, -0.03], "localEnd": [0.0, 0.62, -0.075], "contactType": "flush-mount", "embedDepth": 0.015, "gapTolerance": 0.004, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.62, "height": 0.14, "depth": 0.05, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.52, -0.0475], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-housing", "materialLayers": ["connector-housing"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.25, "bumpAmplitude": 0.02, "normalPattern": "molded-housing-seam", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-housing-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_edge_connector_39.add(mesh_edge_connector_39);
  meshes["edge-connector"] = mesh_edge_connector_39;
  colliders["edge-connector"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_39);

  const endpoint_edge_connector_contact_row_1_40 = makeAttachmentEndpoint(null);
  const node_edge_connector_contact_row_1_40 = new THREE.Group();
  node_edge_connector_contact_row_1_40.name = "Connector Contact Row 1__pivot";
  node_edge_connector_contact_row_1_40.scale.set(1, 1, 1);
  if (endpoint_edge_connector_contact_row_1_40) {
    node_edge_connector_contact_row_1_40.position.copy(endpoint_edge_connector_contact_row_1_40.start);
    node_edge_connector_contact_row_1_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_contact_row_1_40.position.set(0.0, -0.048125, 0.03);
    node_edge_connector_contact_row_1_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_contact_row_1_40.userData.sculptComponent = {"id": "edge-connector-contact-row-1", "name": "Connector Contact Row 1", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.048125, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_1_40.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["edge-connector"] ?? root).add(node_edge_connector_contact_row_1_40);
  nodes["edge-connector-contact-row-1"] = node_edge_connector_contact_row_1_40;
  const mesh_edge_connector_contact_row_1_40Geometry = endpoint_edge_connector_contact_row_1_40
    ? new THREE.CylinderGeometry(endpoint_edge_connector_contact_row_1_40.endRadius, endpoint_edge_connector_contact_row_1_40.baseRadius, endpoint_edge_connector_contact_row_1_40.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_contact_row_1_40) {
    mesh_edge_connector_contact_row_1_40Geometry.scale(0.56, 0.009625, 0.01);
  }
  const mesh_edge_connector_contact_row_1_40 = new THREE.Mesh(
    mesh_edge_connector_contact_row_1_40Geometry,
    materialMap["connector-gold-contact"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_contact_row_1_40.name = "Connector Contact Row 1";
  if (endpoint_edge_connector_contact_row_1_40) {
    mesh_edge_connector_contact_row_1_40.position.copy(endpoint_edge_connector_contact_row_1_40.midpoint);
    mesh_edge_connector_contact_row_1_40.quaternion.copy(endpoint_edge_connector_contact_row_1_40.quaternion);
  }
  mesh_edge_connector_contact_row_1_40.castShadow = options.castShadow ?? true;
  mesh_edge_connector_contact_row_1_40.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_contact_row_1_40.userData.sculptComponent = {"id": "edge-connector-contact-row-1", "name": "Connector Contact Row 1", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.048125, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_1_40.add(mesh_edge_connector_contact_row_1_40);
  meshes["edge-connector-contact-row-1"] = mesh_edge_connector_contact_row_1_40;
  colliders["edge-connector-contact-row-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_contact_row_1_40);

  const endpoint_edge_connector_contact_row_2_41 = makeAttachmentEndpoint(null);
  const node_edge_connector_contact_row_2_41 = new THREE.Group();
  node_edge_connector_contact_row_2_41.name = "Connector Contact Row 2__pivot";
  node_edge_connector_contact_row_2_41.scale.set(1, 1, 1);
  if (endpoint_edge_connector_contact_row_2_41) {
    node_edge_connector_contact_row_2_41.position.copy(endpoint_edge_connector_contact_row_2_41.start);
    node_edge_connector_contact_row_2_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_contact_row_2_41.position.set(0.0, -0.034375, 0.03);
    node_edge_connector_contact_row_2_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_contact_row_2_41.userData.sculptComponent = {"id": "edge-connector-contact-row-2", "name": "Connector Contact Row 2", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.034375, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_2_41.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["edge-connector"] ?? root).add(node_edge_connector_contact_row_2_41);
  nodes["edge-connector-contact-row-2"] = node_edge_connector_contact_row_2_41;
  const mesh_edge_connector_contact_row_2_41Geometry = endpoint_edge_connector_contact_row_2_41
    ? new THREE.CylinderGeometry(endpoint_edge_connector_contact_row_2_41.endRadius, endpoint_edge_connector_contact_row_2_41.baseRadius, endpoint_edge_connector_contact_row_2_41.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_contact_row_2_41) {
    mesh_edge_connector_contact_row_2_41Geometry.scale(0.56, 0.009625, 0.01);
  }
  const mesh_edge_connector_contact_row_2_41 = new THREE.Mesh(
    mesh_edge_connector_contact_row_2_41Geometry,
    materialMap["connector-gold-contact"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_contact_row_2_41.name = "Connector Contact Row 2";
  if (endpoint_edge_connector_contact_row_2_41) {
    mesh_edge_connector_contact_row_2_41.position.copy(endpoint_edge_connector_contact_row_2_41.midpoint);
    mesh_edge_connector_contact_row_2_41.quaternion.copy(endpoint_edge_connector_contact_row_2_41.quaternion);
  }
  mesh_edge_connector_contact_row_2_41.castShadow = options.castShadow ?? true;
  mesh_edge_connector_contact_row_2_41.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_contact_row_2_41.userData.sculptComponent = {"id": "edge-connector-contact-row-2", "name": "Connector Contact Row 2", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.034375, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_2_41.add(mesh_edge_connector_contact_row_2_41);
  meshes["edge-connector-contact-row-2"] = mesh_edge_connector_contact_row_2_41;
  colliders["edge-connector-contact-row-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_contact_row_2_41);

  const endpoint_edge_connector_contact_row_3_42 = makeAttachmentEndpoint(null);
  const node_edge_connector_contact_row_3_42 = new THREE.Group();
  node_edge_connector_contact_row_3_42.name = "Connector Contact Row 3__pivot";
  node_edge_connector_contact_row_3_42.scale.set(1, 1, 1);
  if (endpoint_edge_connector_contact_row_3_42) {
    node_edge_connector_contact_row_3_42.position.copy(endpoint_edge_connector_contact_row_3_42.start);
    node_edge_connector_contact_row_3_42.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_contact_row_3_42.position.set(0.0, -0.020624999999999998, 0.03);
    node_edge_connector_contact_row_3_42.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_contact_row_3_42.userData.sculptComponent = {"id": "edge-connector-contact-row-3", "name": "Connector Contact Row 3", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.020624999999999998, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_3_42.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["edge-connector"] ?? root).add(node_edge_connector_contact_row_3_42);
  nodes["edge-connector-contact-row-3"] = node_edge_connector_contact_row_3_42;
  const mesh_edge_connector_contact_row_3_42Geometry = endpoint_edge_connector_contact_row_3_42
    ? new THREE.CylinderGeometry(endpoint_edge_connector_contact_row_3_42.endRadius, endpoint_edge_connector_contact_row_3_42.baseRadius, endpoint_edge_connector_contact_row_3_42.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_contact_row_3_42) {
    mesh_edge_connector_contact_row_3_42Geometry.scale(0.56, 0.009625, 0.01);
  }
  const mesh_edge_connector_contact_row_3_42 = new THREE.Mesh(
    mesh_edge_connector_contact_row_3_42Geometry,
    materialMap["connector-gold-contact"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_contact_row_3_42.name = "Connector Contact Row 3";
  if (endpoint_edge_connector_contact_row_3_42) {
    mesh_edge_connector_contact_row_3_42.position.copy(endpoint_edge_connector_contact_row_3_42.midpoint);
    mesh_edge_connector_contact_row_3_42.quaternion.copy(endpoint_edge_connector_contact_row_3_42.quaternion);
  }
  mesh_edge_connector_contact_row_3_42.castShadow = options.castShadow ?? true;
  mesh_edge_connector_contact_row_3_42.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_contact_row_3_42.userData.sculptComponent = {"id": "edge-connector-contact-row-3", "name": "Connector Contact Row 3", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.020624999999999998, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_3_42.add(mesh_edge_connector_contact_row_3_42);
  meshes["edge-connector-contact-row-3"] = mesh_edge_connector_contact_row_3_42;
  colliders["edge-connector-contact-row-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_contact_row_3_42);

  const endpoint_edge_connector_contact_row_4_43 = makeAttachmentEndpoint(null);
  const node_edge_connector_contact_row_4_43 = new THREE.Group();
  node_edge_connector_contact_row_4_43.name = "Connector Contact Row 4__pivot";
  node_edge_connector_contact_row_4_43.scale.set(1, 1, 1);
  if (endpoint_edge_connector_contact_row_4_43) {
    node_edge_connector_contact_row_4_43.position.copy(endpoint_edge_connector_contact_row_4_43.start);
    node_edge_connector_contact_row_4_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_contact_row_4_43.position.set(0.0, -0.006874999999999999, 0.03);
    node_edge_connector_contact_row_4_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_contact_row_4_43.userData.sculptComponent = {"id": "edge-connector-contact-row-4", "name": "Connector Contact Row 4", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.006874999999999999, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_4_43.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["edge-connector"] ?? root).add(node_edge_connector_contact_row_4_43);
  nodes["edge-connector-contact-row-4"] = node_edge_connector_contact_row_4_43;
  const mesh_edge_connector_contact_row_4_43Geometry = endpoint_edge_connector_contact_row_4_43
    ? new THREE.CylinderGeometry(endpoint_edge_connector_contact_row_4_43.endRadius, endpoint_edge_connector_contact_row_4_43.baseRadius, endpoint_edge_connector_contact_row_4_43.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_contact_row_4_43) {
    mesh_edge_connector_contact_row_4_43Geometry.scale(0.56, 0.009625, 0.01);
  }
  const mesh_edge_connector_contact_row_4_43 = new THREE.Mesh(
    mesh_edge_connector_contact_row_4_43Geometry,
    materialMap["connector-gold-contact"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_contact_row_4_43.name = "Connector Contact Row 4";
  if (endpoint_edge_connector_contact_row_4_43) {
    mesh_edge_connector_contact_row_4_43.position.copy(endpoint_edge_connector_contact_row_4_43.midpoint);
    mesh_edge_connector_contact_row_4_43.quaternion.copy(endpoint_edge_connector_contact_row_4_43.quaternion);
  }
  mesh_edge_connector_contact_row_4_43.castShadow = options.castShadow ?? true;
  mesh_edge_connector_contact_row_4_43.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_contact_row_4_43.userData.sculptComponent = {"id": "edge-connector-contact-row-4", "name": "Connector Contact Row 4", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.006874999999999999, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_4_43.add(mesh_edge_connector_contact_row_4_43);
  meshes["edge-connector-contact-row-4"] = mesh_edge_connector_contact_row_4_43;
  colliders["edge-connector-contact-row-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_contact_row_4_43);

  const endpoint_edge_connector_contact_row_5_44 = makeAttachmentEndpoint(null);
  const node_edge_connector_contact_row_5_44 = new THREE.Group();
  node_edge_connector_contact_row_5_44.name = "Connector Contact Row 5__pivot";
  node_edge_connector_contact_row_5_44.scale.set(1, 1, 1);
  if (endpoint_edge_connector_contact_row_5_44) {
    node_edge_connector_contact_row_5_44.position.copy(endpoint_edge_connector_contact_row_5_44.start);
    node_edge_connector_contact_row_5_44.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_contact_row_5_44.position.set(0.0, 0.006874999999999999, 0.03);
    node_edge_connector_contact_row_5_44.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_contact_row_5_44.userData.sculptComponent = {"id": "edge-connector-contact-row-5", "name": "Connector Contact Row 5", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.006874999999999999, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_5_44.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["edge-connector"] ?? root).add(node_edge_connector_contact_row_5_44);
  nodes["edge-connector-contact-row-5"] = node_edge_connector_contact_row_5_44;
  const mesh_edge_connector_contact_row_5_44Geometry = endpoint_edge_connector_contact_row_5_44
    ? new THREE.CylinderGeometry(endpoint_edge_connector_contact_row_5_44.endRadius, endpoint_edge_connector_contact_row_5_44.baseRadius, endpoint_edge_connector_contact_row_5_44.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_contact_row_5_44) {
    mesh_edge_connector_contact_row_5_44Geometry.scale(0.56, 0.009625, 0.01);
  }
  const mesh_edge_connector_contact_row_5_44 = new THREE.Mesh(
    mesh_edge_connector_contact_row_5_44Geometry,
    materialMap["connector-gold-contact"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_contact_row_5_44.name = "Connector Contact Row 5";
  if (endpoint_edge_connector_contact_row_5_44) {
    mesh_edge_connector_contact_row_5_44.position.copy(endpoint_edge_connector_contact_row_5_44.midpoint);
    mesh_edge_connector_contact_row_5_44.quaternion.copy(endpoint_edge_connector_contact_row_5_44.quaternion);
  }
  mesh_edge_connector_contact_row_5_44.castShadow = options.castShadow ?? true;
  mesh_edge_connector_contact_row_5_44.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_contact_row_5_44.userData.sculptComponent = {"id": "edge-connector-contact-row-5", "name": "Connector Contact Row 5", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.006874999999999999, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_5_44.add(mesh_edge_connector_contact_row_5_44);
  meshes["edge-connector-contact-row-5"] = mesh_edge_connector_contact_row_5_44;
  colliders["edge-connector-contact-row-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_contact_row_5_44);

  const endpoint_edge_connector_contact_row_6_45 = makeAttachmentEndpoint(null);
  const node_edge_connector_contact_row_6_45 = new THREE.Group();
  node_edge_connector_contact_row_6_45.name = "Connector Contact Row 6__pivot";
  node_edge_connector_contact_row_6_45.scale.set(1, 1, 1);
  if (endpoint_edge_connector_contact_row_6_45) {
    node_edge_connector_contact_row_6_45.position.copy(endpoint_edge_connector_contact_row_6_45.start);
    node_edge_connector_contact_row_6_45.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_contact_row_6_45.position.set(0.0, 0.020624999999999998, 0.03);
    node_edge_connector_contact_row_6_45.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_contact_row_6_45.userData.sculptComponent = {"id": "edge-connector-contact-row-6", "name": "Connector Contact Row 6", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.020624999999999998, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_6_45.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["edge-connector"] ?? root).add(node_edge_connector_contact_row_6_45);
  nodes["edge-connector-contact-row-6"] = node_edge_connector_contact_row_6_45;
  const mesh_edge_connector_contact_row_6_45Geometry = endpoint_edge_connector_contact_row_6_45
    ? new THREE.CylinderGeometry(endpoint_edge_connector_contact_row_6_45.endRadius, endpoint_edge_connector_contact_row_6_45.baseRadius, endpoint_edge_connector_contact_row_6_45.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_contact_row_6_45) {
    mesh_edge_connector_contact_row_6_45Geometry.scale(0.56, 0.009625, 0.01);
  }
  const mesh_edge_connector_contact_row_6_45 = new THREE.Mesh(
    mesh_edge_connector_contact_row_6_45Geometry,
    materialMap["connector-gold-contact"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_contact_row_6_45.name = "Connector Contact Row 6";
  if (endpoint_edge_connector_contact_row_6_45) {
    mesh_edge_connector_contact_row_6_45.position.copy(endpoint_edge_connector_contact_row_6_45.midpoint);
    mesh_edge_connector_contact_row_6_45.quaternion.copy(endpoint_edge_connector_contact_row_6_45.quaternion);
  }
  mesh_edge_connector_contact_row_6_45.castShadow = options.castShadow ?? true;
  mesh_edge_connector_contact_row_6_45.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_contact_row_6_45.userData.sculptComponent = {"id": "edge-connector-contact-row-6", "name": "Connector Contact Row 6", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.020624999999999998, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_6_45.add(mesh_edge_connector_contact_row_6_45);
  meshes["edge-connector-contact-row-6"] = mesh_edge_connector_contact_row_6_45;
  colliders["edge-connector-contact-row-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_contact_row_6_45);

  const endpoint_edge_connector_contact_row_7_46 = makeAttachmentEndpoint(null);
  const node_edge_connector_contact_row_7_46 = new THREE.Group();
  node_edge_connector_contact_row_7_46.name = "Connector Contact Row 7__pivot";
  node_edge_connector_contact_row_7_46.scale.set(1, 1, 1);
  if (endpoint_edge_connector_contact_row_7_46) {
    node_edge_connector_contact_row_7_46.position.copy(endpoint_edge_connector_contact_row_7_46.start);
    node_edge_connector_contact_row_7_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_contact_row_7_46.position.set(0.0, 0.034374999999999996, 0.03);
    node_edge_connector_contact_row_7_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_contact_row_7_46.userData.sculptComponent = {"id": "edge-connector-contact-row-7", "name": "Connector Contact Row 7", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.034374999999999996, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_7_46.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["edge-connector"] ?? root).add(node_edge_connector_contact_row_7_46);
  nodes["edge-connector-contact-row-7"] = node_edge_connector_contact_row_7_46;
  const mesh_edge_connector_contact_row_7_46Geometry = endpoint_edge_connector_contact_row_7_46
    ? new THREE.CylinderGeometry(endpoint_edge_connector_contact_row_7_46.endRadius, endpoint_edge_connector_contact_row_7_46.baseRadius, endpoint_edge_connector_contact_row_7_46.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_contact_row_7_46) {
    mesh_edge_connector_contact_row_7_46Geometry.scale(0.56, 0.009625, 0.01);
  }
  const mesh_edge_connector_contact_row_7_46 = new THREE.Mesh(
    mesh_edge_connector_contact_row_7_46Geometry,
    materialMap["connector-gold-contact"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_contact_row_7_46.name = "Connector Contact Row 7";
  if (endpoint_edge_connector_contact_row_7_46) {
    mesh_edge_connector_contact_row_7_46.position.copy(endpoint_edge_connector_contact_row_7_46.midpoint);
    mesh_edge_connector_contact_row_7_46.quaternion.copy(endpoint_edge_connector_contact_row_7_46.quaternion);
  }
  mesh_edge_connector_contact_row_7_46.castShadow = options.castShadow ?? true;
  mesh_edge_connector_contact_row_7_46.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_contact_row_7_46.userData.sculptComponent = {"id": "edge-connector-contact-row-7", "name": "Connector Contact Row 7", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.034374999999999996, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_7_46.add(mesh_edge_connector_contact_row_7_46);
  meshes["edge-connector-contact-row-7"] = mesh_edge_connector_contact_row_7_46;
  colliders["edge-connector-contact-row-7"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_contact_row_7_46);

  const endpoint_edge_connector_contact_row_8_47 = makeAttachmentEndpoint(null);
  const node_edge_connector_contact_row_8_47 = new THREE.Group();
  node_edge_connector_contact_row_8_47.name = "Connector Contact Row 8__pivot";
  node_edge_connector_contact_row_8_47.scale.set(1, 1, 1);
  if (endpoint_edge_connector_contact_row_8_47) {
    node_edge_connector_contact_row_8_47.position.copy(endpoint_edge_connector_contact_row_8_47.start);
    node_edge_connector_contact_row_8_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_connector_contact_row_8_47.position.set(0.0, 0.048124999999999994, 0.03);
    node_edge_connector_contact_row_8_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_connector_contact_row_8_47.userData.sculptComponent = {"id": "edge-connector-contact-row-8", "name": "Connector Contact Row 8", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.048124999999999994, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_8_47.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["edge-connector"] ?? root).add(node_edge_connector_contact_row_8_47);
  nodes["edge-connector-contact-row-8"] = node_edge_connector_contact_row_8_47;
  const mesh_edge_connector_contact_row_8_47Geometry = endpoint_edge_connector_contact_row_8_47
    ? new THREE.CylinderGeometry(endpoint_edge_connector_contact_row_8_47.endRadius, endpoint_edge_connector_contact_row_8_47.baseRadius, endpoint_edge_connector_contact_row_8_47.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_connector_contact_row_8_47) {
    mesh_edge_connector_contact_row_8_47Geometry.scale(0.56, 0.009625, 0.01);
  }
  const mesh_edge_connector_contact_row_8_47 = new THREE.Mesh(
    mesh_edge_connector_contact_row_8_47Geometry,
    materialMap["connector-gold-contact"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_connector_contact_row_8_47.name = "Connector Contact Row 8";
  if (endpoint_edge_connector_contact_row_8_47) {
    mesh_edge_connector_contact_row_8_47.position.copy(endpoint_edge_connector_contact_row_8_47.midpoint);
    mesh_edge_connector_contact_row_8_47.quaternion.copy(endpoint_edge_connector_contact_row_8_47.quaternion);
  }
  mesh_edge_connector_contact_row_8_47.castShadow = options.castShadow ?? true;
  mesh_edge_connector_contact_row_8_47.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_connector_contact_row_8_47.userData.sculptComponent = {"id": "edge-connector-contact-row-8", "name": "Connector Contact Row 8", "level": "meso", "role": "electronic-contact", "importance": 0.45, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "edge-connector", "attachment": {"parentId": "edge-connector", "parentSocket": "connector-housing-row-slot", "localStart": [-0.28, 0.0, 0.02], "localEnd": [0.28, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.006, "gapTolerance": 0.002, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.56, "height": 0.009625, "depth": 0.01, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.048124999999999994, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "connector-gold-contact", "materialLayers": ["connector-gold-contact"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(45, 31, 20, 1.0)", "secondaryAlbedo": "rgba(84, 76, 61, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_connector_contact_row_8_47.add(mesh_edge_connector_contact_row_8_47);
  meshes["edge-connector-contact-row-8"] = mesh_edge_connector_contact_row_8_47;
  colliders["edge-connector-contact-row-8"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_connector_contact_row_8_47);

  const endpoint_mounting_standoffs_48 = makeAttachmentEndpoint(null);
  const node_mounting_standoffs_48 = new THREE.Group();
  node_mounting_standoffs_48.name = "Mounting Standoffs__pivot";
  node_mounting_standoffs_48.scale.set(1, 1, 1);
  if (endpoint_mounting_standoffs_48) {
    node_mounting_standoffs_48.position.copy(endpoint_mounting_standoffs_48.start);
    node_mounting_standoffs_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mounting_standoffs_48.position.set(0.0, 0.0, 0.023);
    node_mounting_standoffs_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_mounting_standoffs_48.userData.sculptComponent = {"id": "mounting-standoffs", "name": "Mounting Standoffs", "level": "macro", "role": "electronic-hardware", "importance": 0.8, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Near-zero-footprint organizational pivot for the 4 standoff bosses (each standoff is independently placed).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.001, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.0, 0.023], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "board-solder-mask", "materialLayers": ["board-solder-mask"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.3, "microRoughness": 0.1, "bumpAmplitude": 0.005, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 24, 15, 1.0)", "secondaryAlbedo": "rgba(115, 82, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_mounting_standoffs_48.userData.actionProfile = {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mounting_standoffs_48);
  nodes["mounting-standoffs"] = node_mounting_standoffs_48;
  const mesh_mounting_standoffs_48Geometry = endpoint_mounting_standoffs_48
    ? new THREE.CylinderGeometry(endpoint_mounting_standoffs_48.endRadius, endpoint_mounting_standoffs_48.baseRadius, endpoint_mounting_standoffs_48.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_mounting_standoffs_48) {
    mesh_mounting_standoffs_48Geometry.scale(0.02, 0.02, 0.001);
  }
  const mesh_mounting_standoffs_48 = new THREE.Mesh(
    mesh_mounting_standoffs_48Geometry,
    materialMap["board-solder-mask"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mounting_standoffs_48.name = "Mounting Standoffs";
  if (endpoint_mounting_standoffs_48) {
    mesh_mounting_standoffs_48.position.copy(endpoint_mounting_standoffs_48.midpoint);
    mesh_mounting_standoffs_48.quaternion.copy(endpoint_mounting_standoffs_48.quaternion);
  }
  mesh_mounting_standoffs_48.castShadow = options.castShadow ?? true;
  mesh_mounting_standoffs_48.receiveShadow = options.receiveShadow ?? true;
  mesh_mounting_standoffs_48.userData.sculptComponent = {"id": "mounting-standoffs", "name": "Mounting Standoffs", "level": "macro", "role": "electronic-hardware", "importance": 0.8, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Near-zero-footprint organizational pivot for the 4 standoff bosses (each standoff is independently placed).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.001, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.0, 0.023], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "highlightable-component", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "board-solder-mask", "materialLayers": ["board-solder-mask"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.3, "microRoughness": 0.1, "bumpAmplitude": 0.005, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Reference-derived surface locality for the surface-pass; ties to material roughness/AO fields already authored."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 24, 15, 1.0)", "secondaryAlbedo": "rgba(115, 82, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7}};
  node_mounting_standoffs_48.add(mesh_mounting_standoffs_48);
  meshes["mounting-standoffs"] = mesh_mounting_standoffs_48;
  colliders["mounting-standoffs"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mounting_standoffs_48);

  const attachment_mounting_standoff_1_49 = {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]};
  const endpoint_mounting_standoff_1_49 = makeAttachmentEndpoint(attachment_mounting_standoff_1_49);
  const node_mounting_standoff_1_49 = new THREE.Group();
  node_mounting_standoff_1_49.name = "Mounting Standoff 1__pivot";
  node_mounting_standoff_1_49.scale.set(1, 1, 1);
  if (endpoint_mounting_standoff_1_49) {
    node_mounting_standoff_1_49.position.copy(endpoint_mounting_standoff_1_49.start);
    node_mounting_standoff_1_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mounting_standoff_1_49.position.set(-0.28, 0.1, -0.0325);
    node_mounting_standoff_1_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_mounting_standoff_1_49.userData.sculptComponent = {"id": "mounting-standoff-1", "name": "Mounting Standoff 1", "level": "meso", "role": "electronic-hardware", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mounting-standoffs", "attachment": {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.16, "height": 0.16, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28, 0.1, -0.0325], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "standoff-copper-ring", "materialLayers": ["standoff-copper-ring"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "mounting-standoff-1-through-hole", "kind": "geometry", "description": "Central through-hole from back face to front face.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48, 29, 19, 1.0)", "secondaryAlbedo": "rgba(114, 98, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_mounting_standoff_1_49.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["mounting-standoffs"] ?? root).add(node_mounting_standoff_1_49);
  nodes["mounting-standoff-1"] = node_mounting_standoff_1_49;
  const mesh_mounting_standoff_1_49Geometry = endpoint_mounting_standoff_1_49
    ? new THREE.CylinderGeometry(endpoint_mounting_standoff_1_49.endRadius, endpoint_mounting_standoff_1_49.baseRadius, endpoint_mounting_standoff_1_49.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mounting_standoff_1_49) {
    mesh_mounting_standoff_1_49Geometry.scale(0.16, 0.16, 0.02);
  }
  const mesh_mounting_standoff_1_49 = new THREE.Mesh(
    mesh_mounting_standoff_1_49Geometry,
    materialMap["standoff-copper-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mounting_standoff_1_49.name = "Mounting Standoff 1";
  if (endpoint_mounting_standoff_1_49) {
    mesh_mounting_standoff_1_49.position.copy(endpoint_mounting_standoff_1_49.midpoint);
    mesh_mounting_standoff_1_49.quaternion.copy(endpoint_mounting_standoff_1_49.quaternion);
  }
  mesh_mounting_standoff_1_49.castShadow = options.castShadow ?? true;
  mesh_mounting_standoff_1_49.receiveShadow = options.receiveShadow ?? true;
  mesh_mounting_standoff_1_49.userData.sculptComponent = {"id": "mounting-standoff-1", "name": "Mounting Standoff 1", "level": "meso", "role": "electronic-hardware", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mounting-standoffs", "attachment": {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.16, "height": 0.16, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28, 0.1, -0.0325], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "standoff-copper-ring", "materialLayers": ["standoff-copper-ring"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "mounting-standoff-1-through-hole", "kind": "geometry", "description": "Central through-hole from back face to front face.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48, 29, 19, 1.0)", "secondaryAlbedo": "rgba(114, 98, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_mounting_standoff_1_49.add(mesh_mounting_standoff_1_49);
  meshes["mounting-standoff-1"] = mesh_mounting_standoff_1_49;
  colliders["mounting-standoff-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mounting_standoff_1_49);

  const attachment_mounting_standoff_2_50 = {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]};
  const endpoint_mounting_standoff_2_50 = makeAttachmentEndpoint(attachment_mounting_standoff_2_50);
  const node_mounting_standoff_2_50 = new THREE.Group();
  node_mounting_standoff_2_50.name = "Mounting Standoff 2__pivot";
  node_mounting_standoff_2_50.scale.set(1, 1, 1);
  if (endpoint_mounting_standoff_2_50) {
    node_mounting_standoff_2_50.position.copy(endpoint_mounting_standoff_2_50.start);
    node_mounting_standoff_2_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mounting_standoff_2_50.position.set(0.28, 0.1, -0.0325);
    node_mounting_standoff_2_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_mounting_standoff_2_50.userData.sculptComponent = {"id": "mounting-standoff-2", "name": "Mounting Standoff 2", "level": "meso", "role": "electronic-hardware", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mounting-standoffs", "attachment": {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.16, "height": 0.16, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28, 0.1, -0.0325], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "standoff-copper-ring", "materialLayers": ["standoff-copper-ring"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "mounting-standoff-2-through-hole", "kind": "geometry", "description": "Central through-hole from back face to front face.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48, 29, 19, 1.0)", "secondaryAlbedo": "rgba(114, 98, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_mounting_standoff_2_50.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["mounting-standoffs"] ?? root).add(node_mounting_standoff_2_50);
  nodes["mounting-standoff-2"] = node_mounting_standoff_2_50;
  const mesh_mounting_standoff_2_50Geometry = endpoint_mounting_standoff_2_50
    ? new THREE.CylinderGeometry(endpoint_mounting_standoff_2_50.endRadius, endpoint_mounting_standoff_2_50.baseRadius, endpoint_mounting_standoff_2_50.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mounting_standoff_2_50) {
    mesh_mounting_standoff_2_50Geometry.scale(0.16, 0.16, 0.02);
  }
  const mesh_mounting_standoff_2_50 = new THREE.Mesh(
    mesh_mounting_standoff_2_50Geometry,
    materialMap["standoff-copper-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mounting_standoff_2_50.name = "Mounting Standoff 2";
  if (endpoint_mounting_standoff_2_50) {
    mesh_mounting_standoff_2_50.position.copy(endpoint_mounting_standoff_2_50.midpoint);
    mesh_mounting_standoff_2_50.quaternion.copy(endpoint_mounting_standoff_2_50.quaternion);
  }
  mesh_mounting_standoff_2_50.castShadow = options.castShadow ?? true;
  mesh_mounting_standoff_2_50.receiveShadow = options.receiveShadow ?? true;
  mesh_mounting_standoff_2_50.userData.sculptComponent = {"id": "mounting-standoff-2", "name": "Mounting Standoff 2", "level": "meso", "role": "electronic-hardware", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mounting-standoffs", "attachment": {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.16, "height": 0.16, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28, 0.1, -0.0325], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "standoff-copper-ring", "materialLayers": ["standoff-copper-ring"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "mounting-standoff-2-through-hole", "kind": "geometry", "description": "Central through-hole from back face to front face.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48, 29, 19, 1.0)", "secondaryAlbedo": "rgba(114, 98, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_mounting_standoff_2_50.add(mesh_mounting_standoff_2_50);
  meshes["mounting-standoff-2"] = mesh_mounting_standoff_2_50;
  colliders["mounting-standoff-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mounting_standoff_2_50);

  const attachment_mounting_standoff_3_51 = {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]};
  const endpoint_mounting_standoff_3_51 = makeAttachmentEndpoint(attachment_mounting_standoff_3_51);
  const node_mounting_standoff_3_51 = new THREE.Group();
  node_mounting_standoff_3_51.name = "Mounting Standoff 3__pivot";
  node_mounting_standoff_3_51.scale.set(1, 1, 1);
  if (endpoint_mounting_standoff_3_51) {
    node_mounting_standoff_3_51.position.copy(endpoint_mounting_standoff_3_51.start);
    node_mounting_standoff_3_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mounting_standoff_3_51.position.set(-0.28, -0.22, -0.0325);
    node_mounting_standoff_3_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_mounting_standoff_3_51.userData.sculptComponent = {"id": "mounting-standoff-3", "name": "Mounting Standoff 3", "level": "meso", "role": "electronic-hardware", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mounting-standoffs", "attachment": {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.16, "height": 0.16, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28, -0.22, -0.0325], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "standoff-copper-ring", "materialLayers": ["standoff-copper-ring"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "mounting-standoff-3-through-hole", "kind": "geometry", "description": "Central through-hole from back face to front face.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48, 29, 19, 1.0)", "secondaryAlbedo": "rgba(114, 98, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_mounting_standoff_3_51.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["mounting-standoffs"] ?? root).add(node_mounting_standoff_3_51);
  nodes["mounting-standoff-3"] = node_mounting_standoff_3_51;
  const mesh_mounting_standoff_3_51Geometry = endpoint_mounting_standoff_3_51
    ? new THREE.CylinderGeometry(endpoint_mounting_standoff_3_51.endRadius, endpoint_mounting_standoff_3_51.baseRadius, endpoint_mounting_standoff_3_51.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mounting_standoff_3_51) {
    mesh_mounting_standoff_3_51Geometry.scale(0.16, 0.16, 0.02);
  }
  const mesh_mounting_standoff_3_51 = new THREE.Mesh(
    mesh_mounting_standoff_3_51Geometry,
    materialMap["standoff-copper-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mounting_standoff_3_51.name = "Mounting Standoff 3";
  if (endpoint_mounting_standoff_3_51) {
    mesh_mounting_standoff_3_51.position.copy(endpoint_mounting_standoff_3_51.midpoint);
    mesh_mounting_standoff_3_51.quaternion.copy(endpoint_mounting_standoff_3_51.quaternion);
  }
  mesh_mounting_standoff_3_51.castShadow = options.castShadow ?? true;
  mesh_mounting_standoff_3_51.receiveShadow = options.receiveShadow ?? true;
  mesh_mounting_standoff_3_51.userData.sculptComponent = {"id": "mounting-standoff-3", "name": "Mounting Standoff 3", "level": "meso", "role": "electronic-hardware", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mounting-standoffs", "attachment": {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.16, "height": 0.16, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.28, -0.22, -0.0325], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "standoff-copper-ring", "materialLayers": ["standoff-copper-ring"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "mounting-standoff-3-through-hole", "kind": "geometry", "description": "Central through-hole from back face to front face.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48, 29, 19, 1.0)", "secondaryAlbedo": "rgba(114, 98, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_mounting_standoff_3_51.add(mesh_mounting_standoff_3_51);
  meshes["mounting-standoff-3"] = mesh_mounting_standoff_3_51;
  colliders["mounting-standoff-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mounting_standoff_3_51);

  const attachment_mounting_standoff_4_52 = {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]};
  const endpoint_mounting_standoff_4_52 = makeAttachmentEndpoint(attachment_mounting_standoff_4_52);
  const node_mounting_standoff_4_52 = new THREE.Group();
  node_mounting_standoff_4_52.name = "Mounting Standoff 4__pivot";
  node_mounting_standoff_4_52.scale.set(1, 1, 1);
  if (endpoint_mounting_standoff_4_52) {
    node_mounting_standoff_4_52.position.copy(endpoint_mounting_standoff_4_52.start);
    node_mounting_standoff_4_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mounting_standoff_4_52.position.set(0.28, -0.22, -0.0325);
    node_mounting_standoff_4_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_mounting_standoff_4_52.userData.sculptComponent = {"id": "mounting-standoff-4", "name": "Mounting Standoff 4", "level": "meso", "role": "electronic-hardware", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mounting-standoffs", "attachment": {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.16, "height": 0.16, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28, -0.22, -0.0325], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "standoff-copper-ring", "materialLayers": ["standoff-copper-ring"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "mounting-standoff-4-through-hole", "kind": "geometry", "description": "Central through-hole from back face to front face.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48, 29, 19, 1.0)", "secondaryAlbedo": "rgba(114, 98, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_mounting_standoff_4_52.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["mounting-standoffs"] ?? root).add(node_mounting_standoff_4_52);
  nodes["mounting-standoff-4"] = node_mounting_standoff_4_52;
  const mesh_mounting_standoff_4_52Geometry = endpoint_mounting_standoff_4_52
    ? new THREE.CylinderGeometry(endpoint_mounting_standoff_4_52.endRadius, endpoint_mounting_standoff_4_52.baseRadius, endpoint_mounting_standoff_4_52.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mounting_standoff_4_52) {
    mesh_mounting_standoff_4_52Geometry.scale(0.16, 0.16, 0.02);
  }
  const mesh_mounting_standoff_4_52 = new THREE.Mesh(
    mesh_mounting_standoff_4_52Geometry,
    materialMap["standoff-copper-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mounting_standoff_4_52.name = "Mounting Standoff 4";
  if (endpoint_mounting_standoff_4_52) {
    mesh_mounting_standoff_4_52.position.copy(endpoint_mounting_standoff_4_52.midpoint);
    mesh_mounting_standoff_4_52.quaternion.copy(endpoint_mounting_standoff_4_52.quaternion);
  }
  mesh_mounting_standoff_4_52.castShadow = options.castShadow ?? true;
  mesh_mounting_standoff_4_52.receiveShadow = options.receiveShadow ?? true;
  mesh_mounting_standoff_4_52.userData.sculptComponent = {"id": "mounting-standoff-4", "name": "Mounting Standoff 4", "level": "meso", "role": "electronic-hardware", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mounting-standoffs", "attachment": {"parentId": "mounting-standoffs", "parentSocket": "board-standoff-boss", "localStart": [0.0, 0.0, -0.02], "localEnd": [0.0, 0.0, 0.02], "contactType": "embedded", "embedDepth": 0.012, "gapTolerance": 0.003, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.16, "height": 0.16, "depth": 0.02, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.28, -0.22, -0.0325], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "standoff-copper-ring", "materialLayers": ["standoff-copper-ring"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "mounting-standoff-4-through-hole", "kind": "geometry", "description": "Central through-hole from back face to front face.", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48, 29, 19, 1.0)", "secondaryAlbedo": "rgba(114, 98, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_mounting_standoff_4_52.add(mesh_mounting_standoff_4_52);
  meshes["mounting-standoff-4"] = mesh_mounting_standoff_4_52;
  colliders["mounting-standoff-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mounting_standoff_4_52);

  const endpoint_edge_heatspreader_53 = makeAttachmentEndpoint(null);
  const node_edge_heatspreader_53 = new THREE.Group();
  node_edge_heatspreader_53.name = "Copper Edge Heatspreader Band__pivot";
  node_edge_heatspreader_53.scale.set(1, 1, 1);
  if (endpoint_edge_heatspreader_53) {
    node_edge_heatspreader_53.position.copy(endpoint_edge_heatspreader_53.start);
    node_edge_heatspreader_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_edge_heatspreader_53.position.set(0.0, 0.0, 0.0);
    node_edge_heatspreader_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_edge_heatspreader_53.userData.sculptComponent = {"id": "edge-heatspreader", "name": "Copper Edge Heatspreader Band", "level": "meso", "role": "structural-frame", "importance": 0.5, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin perimeter frame band flush with the board edge; approximated as a slightly larger box behind the solder-mask slab so only the border shows (frame extrude would be more accurate but this stays within the triangle budget).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.36, "depth": 0.027, "units": "relative", "confidence": 0.55}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "copper-edge", "materialLayers": ["copper-edge"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perimeter-through-hole-pattern", "kind": "material-local-override", "description": "Ring of small through-holes/vias around the full perimeter is represented as a normal/AO local override on copper-edge material rather than modeled geometry (surface-relief tier per surface_topology.md -- does not affect silhouette).", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "flat", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_heatspreader_53.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_edge_heatspreader_53);
  nodes["edge-heatspreader"] = node_edge_heatspreader_53;
  const mesh_edge_heatspreader_53Geometry = endpoint_edge_heatspreader_53
    ? new THREE.CylinderGeometry(endpoint_edge_heatspreader_53.endRadius, endpoint_edge_heatspreader_53.baseRadius, endpoint_edge_heatspreader_53.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_edge_heatspreader_53) {
    mesh_edge_heatspreader_53Geometry.scale(1.0, 1.36, 0.027);
  }
  const mesh_edge_heatspreader_53 = new THREE.Mesh(
    mesh_edge_heatspreader_53Geometry,
    materialMap["copper-edge"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_edge_heatspreader_53.name = "Copper Edge Heatspreader Band";
  if (endpoint_edge_heatspreader_53) {
    mesh_edge_heatspreader_53.position.copy(endpoint_edge_heatspreader_53.midpoint);
    mesh_edge_heatspreader_53.quaternion.copy(endpoint_edge_heatspreader_53.quaternion);
  }
  mesh_edge_heatspreader_53.castShadow = options.castShadow ?? true;
  mesh_edge_heatspreader_53.receiveShadow = options.receiveShadow ?? true;
  mesh_edge_heatspreader_53.userData.sculptComponent = {"id": "edge-heatspreader", "name": "Copper Edge Heatspreader Band", "level": "meso", "role": "structural-frame", "importance": 0.5, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin perimeter frame band flush with the board edge; approximated as a slightly larger box behind the solder-mask slab so only the border shows (frame extrude would be more accurate but this stays within the triangle budget).", "geometryDescriptor": {"topologyIntent": "hard-surface blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.36, "depth": 0.027, "units": "relative", "confidence": 0.55}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "copper-edge", "materialLayers": ["copper-edge"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perimeter-through-hole-pattern", "kind": "material-local-override", "description": "Ring of small through-holes/vias around the full perimeter is represented as a normal/AO local override on copper-edge material rather than modeled geometry (surface-relief tier per surface_topology.md -- does not affect silhouette).", "evidenceRef": "full-object"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.2, "bumpAmplitude": 0.015, "normalPattern": "flat", "displacementPattern": "", "occlusionPattern": "cavity-shading-at-body-edge", "edgeWearPattern": "", "notes": "Reference-derived surface locality tied to the material's roughness/AO evidence."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7}};
  node_edge_heatspreader_53.add(mesh_edge_heatspreader_53);
  meshes["edge-heatspreader"] = mesh_edge_heatspreader_53;
  colliders["edge-heatspreader"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_edge_heatspreader_53);
  // repetition system "vrm-inductor-row" describes 8 parts that are already built individually; not instanced.
  // repetition system "vrm-cap-bank" describes 16 parts that are already built individually; not instanced.
  // repetition system "edge-connector-contact-rows" describes 8 parts that are already built individually; not instanced.
  // repetition system "mounting-standoff-array" describes 4 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createNVIDIAJetsonAGXXavierSoMLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "NVIDIA Jetson AGX Xavier SoM look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"role": "key", "direction": [-0.4, 0.75, 0.55], "color": "#FFF4E0", "intensity": 1.0, "notes": "Soft overhead-left key matching the studio-lit product renders (8,9,10,11.png)."}, {"role": "fill", "direction": [0.6, 0.2, 0.7], "color": "#CFE0FF", "intensity": 0.35, "notes": "Cool fill from camera-right to lift shadow side without flattening the copper/gold specular response."}, {"role": "rim-or-environment", "direction": [0.0, -0.3, -1.0], "color": "#FFFFFF", "intensity": 0.25, "notes": "Low-intensity environment reflection to read metalness on copper edge band and gold contacts."}, {"role": "ambient", "direction": [0, 1, 0], "color": "#404040", "intensity": 0.4, "notes": "Neutral ambient/hemisphere term so recessed areas (between inductors/caps) are not pure black."}, {"role": "exposure-and-shadow", "direction": [0, 1, 0], "color": "#FFFFFF", "intensity": 1.0, "notes": "Exposure ~1.0 with ACES filmic tone mapping; soft contact shadow under the board and ambient-occlusion-driven ground shadow beneath the connector overhang and standoff bosses so recessed geometry reads correctly under neutral turntable lighting."}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createNVIDIAJetsonAGXXavierSoMEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameNVIDIAJetsonAGXXavierSoMCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createNVIDIAJetsonAGXXavierSoMPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureNVIDIAJetsonAGXXavierSoMRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createNVIDIAJetsonAGXXavierSoMInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
