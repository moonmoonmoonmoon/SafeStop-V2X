import "@testing-library/jest-dom";

// jsdom does not implement the Canvas 2D context. The App renders a canvas on
// mount; stub getContext so the smoke test can mount the tree without noisy
// "Not implemented" errors. The sim logic itself never touches canvas.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
}
