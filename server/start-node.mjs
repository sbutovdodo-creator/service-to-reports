import { startProdServer } from "vinext/server/prod-server";

await startProdServer({
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  outDir: "dist-node",
});
