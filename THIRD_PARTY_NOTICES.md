# Third-party notices

## Application runtime

- **Tauri** — MIT OR Apache-2.0 · <https://tauri.app/> · <https://github.com/tauri-apps/tauri>
- **Rust crates** — the full dependency list is in `src-tauri/Cargo.lock`; each crate ships its own
  license text. The notable ones are `reqwest` (MIT OR Apache-2.0), `serde` / `serde_json`
  (MIT OR Apache-2.0) and the `tauri-plugin-*` family (MIT OR Apache-2.0).

Windows builds use the system **WebView2** runtime, which is a Microsoft component and is not
redistributed with this app.

## Front-end assets bundled into the app

- **three.js** — MIT · <https://threejs.org/> · vendored at `src/assets/vendor/` (three.min.js and
  GLTFLoader.js). Only the legacy 3D path loads it, which has no entry point in the Tauri build;
  it is scheduled for removal along with the rest of the 3D code.

## Pending removal (still bundled, no longer reachable)

The migration to Tauri deliberately dropped the local background-removal feature. The model file is
still copied into `dist/` by the asset build step, so it is currently shipped even though nothing
loads it. It will be removed in the cleanup pass. Until then:

- **U-2-Netp ONNX model** — Apache License 2.0 · model distribution:
  <https://huggingface.co/BritishWerewolf/U-2-Netp> · original U-2-Net project:
  <https://github.com/xuebinqin/U-2-Net>.

`onnxruntime-node` and `sharp`, which previously performed the inference and image processing, are
still declared in `package.json` but are no longer used by any code path, and they are **not**
bundled into the Tauri build:

- **ONNX Runtime** — MIT License, Copyright Microsoft Corporation.
- **Sharp** — Apache License 2.0; distributed with libvips and its applicable third-party notices.

The complete dependency license texts are included with their packages in
`node_modules` and in packaged application resources where required.
