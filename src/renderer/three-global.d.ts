// Ambient global type for the vendored three.js UMD build (loaded via <script> tag).
// The UMD build exposes window.THREE at runtime; we type it as `any` because the
// vendored build is not part of the module graph. The strongly-typed surface that
// matters to the rest of the app lives in Petric3DHandle (src/shared/types.ts).
declare const THREE: any;
