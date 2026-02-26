import fs from "node:fs";
import path from "node:path";
import { renderSlides } from "./lib/render.js";

const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><style>
    body{margin:0;display:flex;align-items:center;justify-content:center;width:100vw;height:100vh;font-family:system-ui}
    .card{width:100%;height:100%;padding:80px;box-sizing:border-box}
    h1{font-size:72px;margin:0}
    p{font-size:40px}
  </style></head>
  <body>
    <div class="card">
      <h1>Hello Slide</h1>
      <p>This is a renderer example.</p>
    </div>
  </body>
</html>`;

const output = { width: 1080, height: 1350, format: "jpeg", quality: 90 };
const buffers = await renderSlides({ slideHtml: [html, html], output });

const outDir = path.resolve("./out");
fs.mkdirSync(outDir, { recursive: true });
buffers.forEach((b, i) => fs.writeFileSync(path.join(outDir, `slide_${i+1}.jpg`), b));
console.log("Wrote example slides to services/renderer/out");
