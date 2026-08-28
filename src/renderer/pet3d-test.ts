// ============================================================================
// 3D smoke test (used only in --smoke mode via pet3d-test.html)
// The main process injects a GLB data URL and a 2D image data URL, then calls
// window.__run3DTest(glbDataUrl, imgDataUrl). Verifies:
//   - WebGL renderer init, GLB load, non-empty framebuffer, raycast hit/miss
//   - 2.5D billboard: image plane load, non-empty framebuffer, raycast hit/miss
// ============================================================================

interface Smoke3DResult {
  ok: boolean;
  error?: string;
  pixels?: number;
  hitCenter?: boolean;
  hitCorner?: boolean;
  billboard?: { pixels?: number; hitCenter?: boolean; hitCorner?: boolean };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;

w.__run3DTest = async (glbDataUrl: string, imgDataUrl: string): Promise<Smoke3DResult> => {
  const fail = (error: string): Smoke3DResult => ({ ok: false, error });
  try {
    if (!w.Petric3D) return fail('Petric3D global missing');
    const canvas = document.getElementById('test3d-canvas') as HTMLCanvasElement;
    if (!w.Petric3D.init(canvas)) return fail('WebGL init failed');

    // --- GLB model ---
    const loaded = await w.Petric3D.loadModel(glbDataUrl);
    if (!loaded) return fail('GLB load failed');
    w.Petric3D.update(0.05, 'idle', 0);
    w.Petric3D.render();
    const pixels = w.Petric3D.debugPixelCount();
    const hitCenter = w.Petric3D.isOver(150, 180);
    const hitBelow = w.Petric3D.isOver(150, 245);
    const hitCorner = w.Petric3D.isOver(15, 15);
    if (typeof pixels !== 'number' || pixels < 300) return fail(`GLB framebuffer nearly empty (pixels=${pixels})`);
    if (!hitCenter) return fail('GLB raycast missed the model center');
    if (hitBelow) return fail('GLB raycast hit below the model feet');
    if (hitCorner) return fail('GLB raycast hit an empty corner');

    // --- 2.5D billboard ---
    const bLoaded = await w.Petric3D.loadBillboard(imgDataUrl);
    if (!bLoaded) return fail('billboard load failed');
    w.Petric3D.update(0.05, 'idle', 0);
    w.Petric3D.render();
    const bPixels = w.Petric3D.debugPixelCount();
    // The test image (cat sprite sheet) has transparent margins, so scan the plane's
    // center region for at least one hit (validates geometry + texture-alpha refinement)
    let bCenter = false;
    for (let yy = 100; yy <= 220 && !bCenter; yy += 15) {
      for (let xx = 105; xx <= 195; xx += 10) {
        if (w.Petric3D.isOver(xx, yy)) {
          bCenter = true;
          break;
        }
      }
    }
    const bCorner = w.Petric3D.isOver(15, 15);
    const billboard = { pixels: bPixels, hitCenter: bCenter, hitCorner: bCorner };
    if (typeof bPixels !== 'number' || bPixels < 300) return fail(`billboard framebuffer nearly empty (pixels=${bPixels})`);
    if (!bCenter) return fail('billboard raycast missed the plane (center scan found no hit)');
    if (bCorner) return fail('billboard raycast hit an empty corner');

    return { ok: true, pixels, hitCenter, hitCorner, billboard };
  } catch (err) {
    return fail(String(err));
  }
};
