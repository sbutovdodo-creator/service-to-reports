import { cp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("dist");
const target = path.resolve("dist-node");
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
await rename(path.join(target, "server", "index.js"), path.join(target, "server", "worker.js"));
await writeFile(path.join(target, "server", "index.js"), `
import worker from "./worker.js";
import { createNodeEnv } from "../../server/node-env.mjs";

const env = await createNodeEnv();
const ctx = {
  waitUntil(promise) { Promise.resolve(promise).catch(() => undefined); },
  passThroughOnException() {},
};

export default function handle(request) {
  return worker.fetch(request, env, ctx);
}
`.trimStart());
