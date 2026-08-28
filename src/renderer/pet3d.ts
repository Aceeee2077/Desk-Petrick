// ============================================================================
// Petric 3D pet renderer (standalone script, no imports/exports).
// Uses the vendored three.js UMD build (window.THREE) + GLTFLoader.
// Exposes a single global: window.Petric3D. Only active when a custom 3D model
// skin (customImageMode === 'model') is selected; the 2D pipeline stays default.
//
// Design notes:
//  - Procedural animation mirrors the 2D single-image mode (idle breathing,
//    walking bounce, sleeping dim, click jump) so the shared state machine drives
//    both 2D and 3D with identical semantics.
//  - Hit testing uses a THREE.Raycaster instead of the 2D pixel hitmap.
// ============================================================================

// Reference the global types from three-global.d.ts (compile-time only).
// Petric3DHandle comes from src/shared/types.ts (global, shared with app.ts).
/// <reference path="./three-global.d.ts" />

const Petric3D: Petric3DHandle = (() => {
  // THREE and its classes are typed `any` (vendored UMD globals); the app-facing
  // API surface is fully typed through Petric3DHandle.
  let renderer: any = null;
  let scene: any = null;
  let camera: any = null;
  let raycaster: any = null;
  let model: any = null;
  let modelRoot: any = null; // wrapper for squash/stretch
  let dirLight: any = null;
  let canvas: HTMLCanvasElement | null = null;
  let visible = true;
  let modelHeight = 1; // fitted height in world units
  let baseScale = 1; // fitted uniform scale (from frameModel); pose animation multiplies on top
  let feetY = 0; // world y offset that places the model's feet on the ground
  let time = 0;
  let loaded = false;
  let mode: CustomImageMode = 'model'; // 'model' = GLB mesh, 'billboard' = flat image plane
  let billboardMat: any = null; // MeshBasicMaterial for the billboard plane (for sleep dimming)

  // Pointer state for the billboard (cursor-facing rotation + drag lean)
  let pointerX = 150;
  let pointerDragging = false;
  let pointerDragVelX = 0;
  let currentRotY = 0;

  const CAMERA_Z = 3.0;
  const CAMERA_Y = 1.15;
  const LOOK_Y = 0.45; // model center appears in the lower-middle of the window

  function init(c: HTMLCanvasElement): boolean {
    canvas = c;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: c, alpha: true, antialias: true });
      renderer.setClearColor(0x000000, 0); // fully transparent background
      renderer.setSize(300, 300, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
      camera.position.set(0, CAMERA_Y, CAMERA_Z);
      camera.lookAt(0, LOOK_Y, 0);

      raycaster = new THREE.Raycaster();

      scene.add(new THREE.AmbientLight(0xffffff, 0.85));
      dirLight = new THREE.DirectionalLight(0xffffff, 1.3);
      dirLight.position.set(1.2, 2.2, 1.6);
      scene.add(dirLight);
      scene.add(new THREE.DirectionalLight(0xffffff, 0.4).translateZ(-2));

      modelRoot = new THREE.Group();
      scene.add(modelRoot);
      return true;
    } catch (err) {
      console.error('[pet3d] init failed:', err);
      return false;
    }
  }

  /**
   * Fit the model into a ~1.1-unit-tall box, feet on the ground, centered on X.
   * Stores baseScale / feetY so the per-state pose animation (update) can layer
   * squash & stretch and bobbing on top without clobbering the framing.
   */
  function frameModel(root: any) {
    root.scale.setScalar(1);
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    baseScale = size.y > 0 ? 1.1 / size.y : 1;

    root.scale.setScalar(baseScale);
    root.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(root);
    const c2 = b2.getCenter(new THREE.Vector3());
    feetY = -b2.min.y;
    root.position.x = -c2.x;
    root.position.y = feetY;
    modelHeight = Math.max(0.01, b2.max.y - b2.min.y);
  }

  function loadModel(dataUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!scene || !modelRoot) {
        resolve(false);
        return;
      }
      const loader = new THREE.GLTFLoader();
      loader.load(
        dataUrl,
        (gltf: any) => {
          const next = gltf.scene || gltf.scenes?.[0] || null;
          if (!next) {
            resolve(false);
            return;
          }
          if (model) modelRoot.remove(model);
          model = next;
          modelRoot.add(model);
          mode = 'model';
          billboardMat = null;
          frameModel(modelRoot);
          loaded = true;
          currentRotY = 0;
          resolve(true);
        },
        undefined,
        (err: any) => {
          console.error('[pet3d] load error:', err);
          resolve(false);
        },
      );
    });
  }

  function setPointer(x: number, dragging: boolean, dragVelX: number) {
    pointerX = x;
    pointerDragging = dragging;
    pointerDragVelX = dragVelX;
  }

  /** 2.5D billboard: load a single 2D image onto a transparent plane in the 3D scene. */
  function loadBillboard(dataUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!scene || !modelRoot) {
        resolve(false);
        return;
      }
      const loader = new THREE.TextureLoader();
      loader.load(
        dataUrl,
        (texture: any) => {
          const imgW = texture.image?.width || 1;
          const imgH = texture.image?.height || 1;
          const aspect = imgW / imgH;
          // Basic material: unlit (the image already carries its own shading) + transparent
          billboardMat = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
          });
          const geometry = new THREE.PlaneGeometry(aspect, 1);
          const mesh = new THREE.Mesh(geometry, billboardMat);
          // Slight backward tilt so the plane reads as a standing "standee"
          mesh.rotation.x = -0.12;

          if (model) modelRoot.remove(model);
          model = mesh;
          modelRoot.add(model);
          mode = 'billboard';
          frameModel(modelRoot);
          loaded = true;
          currentRotY = 0;
          resolve(true);
        },
        undefined,
        (err: any) => {
          console.error('[pet3d] billboard load error:', err);
          resolve(false);
        },
      );
    });
  }

  function setVisible(v: boolean) {
    visible = v;
    if (canvas) canvas.style.display = v ? 'block' : 'none';
  }

  // ---------- Procedural animation (mirrors the 2D single-image mode) ----------
  function update(dt: number, state: PetState, frameIndex: number) {
    if (!modelRoot) return;
    time += dt;
    const t = time;
    let yOff = 0;
    let scaleX = 1;
    let scaleY = 1;
    let dim = 1;

    if (state === 'idle') {
      yOff = Math.sin(t * 2.2) * 0.03;
      scaleY = 1 + Math.sin(t * 2.2 + 1) * 0.015;
    } else if (state === 'walking') {
      yOff = Math.sin(t * 10) * 0.05;
      scaleX = 1 + Math.sin(t * 10) * 0.03;
    } else if (state === 'sleeping') {
      yOff = 0.02 + Math.sin(t * 1.5) * 0.012;
      scaleX = 0.97;
      scaleY = 0.94;
      dim = 0.55;
    } else if (state === 'click') {
      const jump = [-0.05, -0.22, -0.32, -0.1][frameIndex] ?? 0;
      const squash = [0.94, 1.12, 1.06, 0.9][frameIndex] ?? 1;
      yOff = jump;
      scaleY = squash;
    }

    // Apply pose animation ON TOP of the fitted framing (baseScale / feetY)
    modelRoot.position.y = feetY + yOff;
    modelRoot.scale.set(baseScale * scaleX, baseScale * scaleY, baseScale * scaleX);
    if (dirLight) dirLight.intensity = 1.3 * dim;

    // 2.5D billboard extras: cursor-facing rotation, drag lean, and sleep dimming
    if (mode === 'billboard') {
      // Face the cursor: rotate around Y toward the pointer X (max ~24 deg)
      const targetBase = ((pointerX - 150) / 150) * 0.42;
      // Lean into the drag direction while dragging (velocity-based)
      const lean = pointerDragging ? Math.max(-0.35, Math.min(0.35, pointerDragVelX * 0.9)) : 0;
      const target = targetBase + lean;
      currentRotY += (target - currentRotY) * Math.min(1, dt * 8);
      modelRoot.rotation.y = currentRotY;
      // Sleep: dim the unlit billboard via material opacity (MeshBasicMaterial ignores lights)
      if (billboardMat) {
        billboardMat.opacity = state === 'sleeping' ? 0.82 : 1;
        billboardMat.needsUpdate = true;
      }
    } else {
      modelRoot.rotation.y = 0;
      currentRotY = 0;
    }
  }

  function render() {
    if (renderer && scene && camera && visible) {
      renderer.render(scene, camera);
    }
  }

  /** Billboard texture alpha at a UV coordinate (0..1), for pixel-precise hit testing. */
  function billboardAlphaAt(u: number, v: number): number {
    if (!billboardMat || !billboardMat.map || !billboardMat.map.image) return 1;
    const img = billboardMat.map.image;
    const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)));
    const y = Math.min(img.height - 1, Math.max(0, Math.floor((1 - v) * img.height)));
    const canvas2d = document.createElement('canvas');
    canvas2d.width = 1;
    canvas2d.height = 1;
    const c2 = canvas2d.getContext('2d', { willReadFrequently: true });
    if (!c2) return 1;
    c2.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
    const d = c2.getImageData(0, 0, 1, 1).data;
    return d[3];
  }

  function isOver(clientX: number, clientY: number): boolean {
    if (!raycaster || !camera || !model || !canvas) return false;
    const ndcX = (clientX / 300) * 2 - 1;
    const ndcY = 1 - (clientY / 300) * 2;
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    // 'billboard' mode: the model IS the plane mesh (no children); GLB mode: intersect the mesh children
    const targets = mode === 'billboard' ? [model] : model.children;
    const hits = raycaster.intersectObjects(targets, true);
    if (!hits.length) return false;
    // For the billboard, refine by the texture alpha so transparent corners don't count as hits
    if (mode === 'billboard' && hits[0].uv) {
      return billboardAlphaAt(hits[0].uv.x, hits[0].uv.y) > 20;
    }
    return true;
  }

  function debugPixelCount(): number {
    render();
    if (!renderer) return -1;
    const gl = renderer.getContext() as WebGLRenderingContext | null;
    if (!gl) return -1;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] > 20) n++;
    }
    return n;
  }

  function dispose() {
    if (renderer) {
      renderer.dispose();
      renderer = null;
    }
    model = null;
    loaded = false;
  }

  return { init, loadModel, loadBillboard, setPointer, update, render, isOver, setVisible, debugPixelCount, dispose };
})();

// Global for other renderer scripts (app.ts): a single prefixed global, no collisions.
(window as unknown as { Petric3D: Petric3DHandle }).Petric3D = Petric3D;
