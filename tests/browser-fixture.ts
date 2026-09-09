import { readFileSync } from "node:fs";
import { createPageFactory } from "../src/browser-factory.ts";

const module = new WebAssembly.Module(readFileSync(new URL("../.wrangler/browser/kitesurf_browser_bg.wasm", import.meta.url)));
export const makePage = createPageFactory(module);
