import browserWasm from "../.wrangler/browser/kitesurf_browser_bg.wasm";
import { createPageFactory } from "./browser-factory.ts";

export const createPage = createPageFactory(browserWasm);
