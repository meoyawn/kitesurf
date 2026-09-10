declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.txt" {
  const content: string;
  export default content;
}
