import * as fs from 'fs';
import * as path from 'path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const MODEL_SIZE = 320;
const MAX_OUTPUT_EDGE = 2048;
const MAX_INPUT_PIXELS = 40_000_000;
const MODEL_PATH = path.join(__dirname, '../assets/models/u2netp/model.onnx');
const MODEL_INPUT = 'input.1';
const MODEL_OUTPUT = '1959';
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  // Passing the bytes keeps the model usable from inside Electron's app.asar.
  sessionPromise ??= ort.InferenceSession.create(fs.readFileSync(MODEL_PATH), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  return sessionPromise;
}

function smoothstep(low: number, high: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return x * x * (3 - 2 * x);
}

/**
 * Remove the background from a raster image with the lightweight U-2-Netp
 * salient-object model and write a cropped transparent PNG.
 */
export async function removeImageBackground(
  inputPath: string,
  outputPath: string,
  sensitivity: number,
): Promise<void> {
  const source = await sharp(inputPath, {
    page: 0,
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .resize({
      width: MAX_OUTPUT_EDGE,
      height: MAX_OUTPUT_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = source.info;
  if (!width || !height || channels !== 4) throw new Error('Invalid raster image');

  // Respect images that already contain a useful transparency mask.
  let transparentPixels = 0;
  for (let i = 3; i < source.data.length; i += 4) {
    if (source.data[i] < 245) transparentPixels++;
  }
  const alreadyCutOut = transparentPixels > width * height * 0.002;

  if (!alreadyCutOut) {
    const scale = Math.min(MODEL_SIZE / width, MODEL_SIZE / height);
    const resizedWidth = Math.max(1, Math.round(width * scale));
    const resizedHeight = Math.max(1, Math.round(height * scale));
    const left = Math.floor((MODEL_SIZE - resizedWidth) / 2);
    const top = Math.floor((MODEL_SIZE - resizedHeight) / 2);

    const modelPixels = await sharp(source.data, {
      raw: { width, height, channels: 4 },
    })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .resize(MODEL_SIZE, MODEL_SIZE, {
        fit: 'contain',
        position: 'centre',
        background: { r: 0, g: 0, b: 0 },
      })
      .removeAlpha()
      .raw()
      .toBuffer();

    const plane = MODEL_SIZE * MODEL_SIZE;
    const input = new Float32Array(plane * 3);
    for (let p = 0; p < plane; p++) {
      input[p] = (modelPixels[p * 3] / 255 - MEAN[0]) / STD[0];
      input[plane + p] = (modelPixels[p * 3 + 1] / 255 - MEAN[1]) / STD[1];
      input[plane * 2 + p] = (modelPixels[p * 3 + 2] / 255 - MEAN[2]) / STD[2];
    }

    const session = await getSession();
    const result = await session.run({
      [MODEL_INPUT]: new ort.Tensor('float32', input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    });
    const prediction = result[MODEL_OUTPUT]?.data;
    if (!(prediction instanceof Float32Array) || prediction.length !== plane) {
      throw new Error('Invalid segmentation output');
    }

    // Higher sensitivity removes more low-confidence background pixels while
    // preserving the model's soft edge for hair, fur and anti-aliased outlines.
    const strength = Math.max(8, Math.min(60, sensitivity));
    const low = 0.025 + ((strength - 8) / 52) * 0.2;
    const mask320 = Buffer.allocUnsafe(plane);
    for (let i = 0; i < plane; i++) {
      mask320[i] = Math.round(smoothstep(low, 0.92, prediction[i]) * 255);
    }

    const mask = await sharp(mask320, {
      raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 1 },
    })
      .extract({ left, top, width: resizedWidth, height: resizedHeight })
      .resize(width, height, { fit: 'fill', kernel: sharp.kernel.cubic })
      .toColourspace('b-w')
      .raw()
      .toBuffer();

    if (mask.length !== width * height) throw new Error('Invalid resized mask');

    let visiblePixels = 0;
    for (let p = 0; p < width * height; p++) {
      const alpha = Math.round((source.data[p * 4 + 3] * mask[p]) / 255);
      source.data[p * 4 + 3] = alpha;
      if (alpha > 20) visiblePixels++;
    }
    if (visiblePixels < width * height * 0.001) {
      throw new Error('No foreground subject detected');
    }
  }

  const temporaryPath = outputPath + '.tmp';
  try {
    await sharp(source.data, { raw: { width, height, channels: 4 } })
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 12 })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(temporaryPath);
    try {
      fs.unlinkSync(outputPath);
    } catch {
      /* The first import has no previous output. */
    }
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The successful rename already removed the temporary file.
    }
  }
}
