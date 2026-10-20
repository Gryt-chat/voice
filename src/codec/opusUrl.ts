/** Where the built opus.wasm sits next to this module. Web only: Metro can't follow import.meta.url. */
export const opusWasmUrl = (): URL => new URL("./opus.wasm", import.meta.url);
