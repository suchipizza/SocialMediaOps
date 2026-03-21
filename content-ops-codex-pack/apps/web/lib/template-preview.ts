import path from "node:path";
import fs from "node:fs/promises";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import { createSupabaseServerClient, getSupabaseStorageBucket } from "./supabase";
import { buildSlidePreviewHtml } from "./template-pack";

const execFileAsync = promisify(execFile);

type PreviewAsset = {
  slide_index: number;
  url: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
};

type ManifestOutput = {
  width: number;
  height: number;
  format: "jpeg" | "png";
  quality: number;
};

type FormatCManifest = {
  template_format: "react-vite-v1";
  template_version: string;
  output: ManifestOutput;
  slide_count: number;
  render: {
    mode: "querystring";
    query: { slide: string; data: string };
    capture?: "slide" | "inner" | "auto";
  };
};

function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}apps${path.sep}web`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

function guessContentType(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".otf")) return "font/otf";
  return "application/octet-stream";
}

async function startStaticServer(rootDir: string) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";
      if (pathname.includes("..")) {
        res.writeHead(400);
        res.end("invalid_path");
        return;
      }

      const filePath = path.join(rootDir, pathname);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        res.writeHead(404);
        res.end("not_found");
        return;
      }

      const data = await fs.readFile(filePath);
      res.writeHead(200, { "content-type": guessContentType(filePath) });
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end("server_error");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("preview_server_failed");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () =>
      new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve()))
      )
  };
}

function base64UrlEncode(input: string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildPlaceholderPayload(slideIndex: number, slideCount: number) {
  const base = {
    headline: "SAMPLE HEADLINE",
    body: "Sample body text to test wrapping and fit. Keep this text long enough to force fitting.",
    footer: "us.v2",
    page_number: `${slideIndex}/${slideCount}`
  };
  if (slideIndex === slideCount) {
    return { ...base, body: "Sample CTA text. Link in bio." };
  }
  return base;
}

async function renderHtmlSlides(params: { slideHtml: string[]; output: ManifestOutput }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: params.output.width, height: params.output.height } });

  const buffers: Buffer[] = [];
  for (const html of params.slideHtml) {
    await page.setContent(html, { waitUntil: "load" });
    const buffer = await page.screenshot({
      type: params.output.format,
      quality: params.output.format === "jpeg" ? params.output.quality : undefined,
      fullPage: false
    });
    buffers.push(buffer);
  }

  await browser.close();
  return buffers;
}

function buildFormatBSlideHtml(params: {
  templateId: string;
  backgroundPath?: string;
  placeholders: Record<string, string>;
  slidePlaceholders: any[];
  output: ManifestOutput;
}) {
  const backgroundUrl = params.backgroundPath
    ? `/api/templates/${encodeURIComponent(params.templateId)}/asset?path=${encodeURIComponent(params.backgroundPath)}`
    : null;

  const placeholderDivs = (params.slidePlaceholders || []).map(placeholder => {
    const key = String(placeholder.key || "");
    const value = params.placeholders[key] || "";
    const align = placeholder.align || "left";
    const fitMode = placeholder.fit_mode || "SHRINK_TO_FIT";
    const dataFit = fitMode === "SHRINK_TO_FIT" ? "shrink" : "none";
    const minFont = placeholder.min_font_size || Math.max(12, Math.floor(placeholder.font_size * 0.6));
    const style = [
      `left:${placeholder.x}px`,
      `top:${placeholder.y}px`,
      `width:${placeholder.w}px`,
      `height:${placeholder.h}px`,
      `font-family:${placeholder.font_family}`,
      `font-size:${placeholder.font_size}px`,
      `line-height:${placeholder.line_height || 1.2}`,
      `text-align:${align}`
    ].join(";");

    return `<div class="box" data-fit="${dataFit}" data-min-font-size="${minFont}" style="${style}">${value}</div>`;
  });

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; width: 100%; height: 100%; }
      body { font-family: Inter, system-ui, sans-serif; background: #0b0f1f; color: #fff; }
      .slide { position: relative; width: 100%; height: 100%; overflow: hidden; }
      .box { position: absolute; display: flex; align-items: center; justify-content: center; overflow: hidden; word-break: break-word; hyphens: auto; }
      .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    </style>
    <script>
      (${shrinkToFit.toString()})();
    </script>
  </head>
  <body>
    <div class="slide">
      ${backgroundUrl ? `<img class="bg" src="${backgroundUrl}" alt="background" />` : ""}
      ${placeholderDivs.join("\n")}
    </div>
  </body>
</html>`;
}

function shrinkToFit() {
  function shrinkElement(element) {
    const minFontSize = Number(element.getAttribute("data-min-font-size") || "18");
    const computed = window.getComputedStyle(element);
    let fontSize = Number.parseFloat(computed.fontSize || "0");
    if (!Number.isFinite(fontSize) || fontSize <= 0) fontSize = 40;
    let steps = 0;
    while (steps < 80) {
      const fits =
        element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1;
      if (fits) return;
      const next = Math.max(minFontSize, fontSize - 2);
      if (next === fontSize) return;
      fontSize = next;
      element.style.fontSize = `${fontSize}px`;
      steps += 1;
    }
  }

  function apply() {
    document.querySelectorAll("[data-fit='shrink']").forEach(el => shrinkElement(el));
  }

  window.addEventListener("load", () => apply());
}

async function ensureFormatCBuild(params: { templateHash: string; zip: JSZip }) {
  const repoRoot = getRepoRoot();
  const cacheRoot = path.join(repoRoot, ".cache", "template-builds");
  const templateDir = path.join(cacheRoot, params.templateHash);
  const findBuiltEntry = async () => {
    const distIndex = path.join(templateDir, "dist", "index.html");
    const buildIndex = path.join(templateDir, "build", "index.html");
    try {
      await fs.access(distIndex);
      return distIndex;
    } catch {
      // continue
    }
    try {
      await fs.access(buildIndex);
      return buildIndex;
    } catch {
      return null;
    }
  };

  async function removeWithRetries(target: string) {
    const maxAttempts = 4;
    const delays = [100, 250, 500, 1000];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await fs.rm(target, { recursive: true, force: true });
        return;
      } catch (err: any) {
        if (err?.code === "ENOENT") return;
        if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(err?.code)) throw err;
        await new Promise(resolve => setTimeout(resolve, delays[Math.min(attempt, delays.length - 1)]));
      }
    }
  }

  async function safeResetDirectory(target: string) {
    try {
      await fs.access(target);
    } catch {
      return;
    }

    const stalePath = `${target}-stale-${Date.now()}`;
    try {
      await fs.rename(target, stalePath);
      await removeWithRetries(stalePath);
      return;
    } catch {
      await removeWithRetries(target);
    }
  }

  const cachedBuilt = await findBuiltEntry();
  if (cachedBuilt) return { templateDir, distIndex: cachedBuilt };

  await safeResetDirectory(templateDir);
  await fs.mkdir(templateDir, { recursive: true });

  const fileEntries = Object.values(params.zip.files).filter(entry => !entry.dir);
  const filtered = fileEntries.filter(
    entry => !entry.name.startsWith("__MACOSX/") && !entry.name.includes("/._")
  );
  const parts = filtered.map(entry => entry.name.split("/").filter(Boolean));
  const firstSegments = parts.map(p => p[0]).filter(Boolean);
  const allSameRoot = firstSegments.length > 0 && firstSegments.every(seg => seg === firstSegments[0]);

  await Promise.all(
    filtered.map(async entry => {
      const normalized = allSameRoot ? entry.name.split("/").slice(1).join("/") : entry.name;
      if (!normalized) return;
      const targetPath = path.join(templateDir, normalized);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const buf = await entry.async("nodebuffer");
      await fs.writeFile(targetPath, buf);
    })
  );

  const extractedBuilt = await findBuiltEntry();
  if (extractedBuilt) {
    return { templateDir, distIndex: extractedBuilt };
  }

  const packageJson = path.join(templateDir, "package.json");
  try {
    await fs.access(packageJson);
  } catch {
    throw new Error("format_c_build_missing_output (expected dist/index.html or build/index.html)");
  }

  const pkgLock = path.join(templateDir, "package-lock.json");
  let hasLock = false;
  try {
    await fs.access(pkgLock);
    hasLock = true;
  } catch {
    hasLock = false;
  }

  const installArgs = hasLock
    ? ["ci", "--include=dev", "--no-fund", "--no-audit"]
    : ["install", "--include=dev", "--no-fund", "--no-audit"];
  const buildEnv = {
    ...process.env,
    NODE_ENV: "development",
    npm_config_production: "false",
    NPM_CONFIG_PRODUCTION: "false"
  } as NodeJS.ProcessEnv;
  await execFileAsync("npm", installArgs, { cwd: templateDir, env: buildEnv });

  try {
    await execFileAsync("npm", ["run", "build", "--", "--base=./"], { cwd: templateDir, env: buildEnv });
  } catch {
    await execFileAsync("npm", ["run", "build"], { cwd: templateDir, env: buildEnv });
  }

  const builtAfterCompile = await findBuiltEntry();
  if (!builtAfterCompile) {
    throw new Error("format_c_build_missing_output (expected dist/index.html or build/index.html)");
  }
  return { templateDir, distIndex: builtAfterCompile };
}

async function renderFormatCSlides(params: {
  manifest: FormatCManifest;
  templateHash: string;
  zip: JSZip;
  payloads?: Array<{ slide_index: number; slide_count: number; fields: Record<string, unknown> }>;
}) {
  const { chromium } = await import("playwright");
  const { distIndex } = await ensureFormatCBuild({ templateHash: params.templateHash, zip: params.zip });
  const rootDir = path.dirname(distIndex);
  const server = await startStaticServer(rootDir);

  const slideCount = params.manifest.slide_count;
  const { width, height, format, quality } = params.manifest.output;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });

  const payloadMap = new Map<number, { slide_index: number; slide_count: number; fields: Record<string, unknown> }>();
  for (const payload of params.payloads || []) {
    if (payload?.slide_index) {
      payloadMap.set(payload.slide_index, payload);
    }
  }

  const buffers: Buffer[] = [];
  for (let i = 1; i <= slideCount; i += 1) {
    const payloadOverride = payloadMap.get(i);
    const placeholders = payloadOverride?.fields || buildPlaceholderPayload(i, slideCount);
    const payload = {
      output: params.manifest.output,
      post: {
        slide_index: payloadOverride?.slide_index || i,
        slide_count: payloadOverride?.slide_count || slideCount,
        fields: placeholders
      }
    };
    const encoded = base64UrlEncode(JSON.stringify(payload));
    const slideParam = params.manifest.render.query.slide || "slide";
    const dataParam = params.manifest.render.query.data || "data";
    const url = `${server.baseUrl}/index.html?${encodeURIComponent(slideParam)}=${i}&${encodeURIComponent(dataParam)}=${encoded}`;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector(`#slide-${i}`, { timeout: 8000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.evaluate(async () => {
      if ("fonts" in document && (document as any).fonts?.ready) {
        try {
          await (document as any).fonts.ready;
        } catch {
          // ignore font readiness errors
        }
      }
    });

    const selection = await page.evaluate(({ slideIndex, slideCount, width, height, fields }) => {
      const allSlides = Array.from(document.querySelectorAll("[id^='slide-']"))
        .filter(node => node instanceof HTMLElement) as HTMLElement[];
      const parsedSlides = allSlides.map(node => {
        const match = node.id.match(/slide-(\d+)/);
        const index = match ? Number(match[1]) : null;
        const hasBlockquote = !!node.querySelector("blockquote");
        const listItems = node.querySelectorAll("li").length;
        const checklistBlocks = Array.from(node.querySelectorAll("*")).filter(el => {
          if (!(el instanceof HTMLElement)) return false;
          const className = typeof el.className === "string" ? el.className : "";
          const style = getComputedStyle(el);
          const hasBackdrop = className.includes("backdrop-blur") || style.backdropFilter !== "none";
          const hasBorder = style.borderStyle !== "none" && style.borderWidth !== "0px";
          const textLength = (el.textContent || "").trim().length;
          const childTextNodes = Array.from(el.querySelectorAll("*")).filter(child => {
            if (!(child instanceof HTMLElement)) return false;
            return (child.textContent || "").trim().length > 0;
          }).length;
          return hasBackdrop && hasBorder && textLength > 0 && childTextNodes >= 2;
        }).length;
        const hasChecklist = listItems >= 2 || checklistBlocks >= 2;
        const layout = hasBlockquote ? "quote" : hasChecklist ? "checklist" : "headline";
        return { node, index, layout };
      });

      const findSlideByIndex = (index: number) =>
        parsedSlides.find(slide => slide.index === index)?.node || null;
      const contentSlides = parsedSlides.filter(
        slide => slide.index !== null && slide.index !== 1 && slide.index !== slideCount
      );
      const findSlideByLayout = (layout: string) =>
        contentSlides.find(slide => slide.layout === layout)?.node || null;
      const fallbackContentSlide = contentSlides[0]?.node || null;

      const safeFields = (fields || {}) as Record<string, unknown>;
      const layoutHint = String(
        safeFields.layout ||
          (safeFields.quote ? "quote" : Array.isArray(safeFields.items) && safeFields.items.length ? "checklist" : "headline")
      ).toLowerCase();

      let wrapper: HTMLElement | null = null;
      if (slideIndex === 1) {
        wrapper = findSlideByIndex(1);
      } else if (slideIndex === slideCount) {
        wrapper = findSlideByIndex(slideCount);
      } else if (layoutHint === "quote") {
        wrapper = findSlideByLayout("quote") || fallbackContentSlide;
      } else if (layoutHint === "checklist") {
        wrapper = findSlideByLayout("checklist") || fallbackContentSlide;
      } else if (layoutHint === "headline") {
        wrapper = findSlideByLayout("headline") || fallbackContentSlide;
      }

      if (!wrapper) {
        wrapper = parsedSlides[0]?.node || null;
      }
      if (!wrapper) return { wrapperMatches: true, selectedIsWrapper: true };
      const wrapperMatches =
        Math.abs(wrapper.offsetWidth - width) <= 2 && Math.abs(wrapper.offsetHeight - height) <= 2;

      const nodes = [wrapper, ...Array.from(wrapper.querySelectorAll("*"))].filter(
        node => node instanceof HTMLElement
      ) as HTMLElement[];
      const candidates = nodes
        .filter(node => Math.abs(node.offsetWidth - width) <= 2 && Math.abs(node.offsetHeight - height) <= 2)
        .map(node => {
          const style = getComputedStyle(node);
          const textLength = (node.textContent || "").trim().length;
          const descendantCount = node.querySelectorAll("*").length;
          const position = style.position;
          const isAbsolute = position === "absolute" || position === "fixed";
          const score =
            Math.min(textLength, 200) +
            Math.min(descendantCount, 120) +
            (style.transform === "none" ? 20 : 0) +
            (isAbsolute ? 0 : 8);
          return { node, score, background: style.backgroundColor, transform: style.transform };
        })
        .sort((a, b) => b.score - a.score);

      const slideRoot = candidates[0]?.node ?? (wrapper as HTMLElement);
      slideRoot.setAttribute("data-preview-root", "true");
      const slideStyle = getComputedStyle(slideRoot);
      if (slideStyle.transform && slideStyle.transform !== "none") {
        slideRoot.style.transform = "none";
        slideRoot.style.setProperty("--tw-scale-x", "1");
        slideRoot.style.setProperty("--tw-scale-y", "1");
      }
      slideRoot.style.position = "relative";
      slideRoot.style.left = "0";
      slideRoot.style.top = "0";
      slideRoot.style.margin = "0";
      slideRoot.style.width = `${width}px`;
      slideRoot.style.height = `${height}px`;
      const bg = slideStyle.backgroundColor;
      if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") {
        slideRoot.style.backgroundColor = "#ffffff";
      }

      document.body.style.margin = "0";
      document.body.style.padding = "0";
      document.body.style.width = `${width}px`;
      document.body.style.height = `${height}px`;

      const headline = String(safeFields.headline || safeFields.title || "").trim();
      const subhead = String(safeFields.subhead || safeFields.subtitle || "").trim();
      const body = String(safeFields.body || "").trim();
      const quote = String(safeFields.quote || "").trim();
      const attribution = String(safeFields.attribution || safeFields.author || "").trim();
      const footer = String(safeFields.footer || "").trim();
      const pageNumber = String(safeFields.page_number || "").trim();
      const itemsRaw = safeFields.items;
      const items = Array.isArray(itemsRaw)
        ? itemsRaw.map(item => item)
        : typeof itemsRaw === "string"
          ? itemsRaw
              .split("|")
              .map(part => part.trim())
              .filter(Boolean)
          : [];

      if (headline || subhead || body || quote || attribution || footer || pageNumber || items.length) {
        const getFontSize = (node: HTMLElement) => {
          const size = Number.parseFloat(getComputedStyle(node).fontSize || "0");
          return Number.isFinite(size) ? size : 0;
        };

        const checklistBlocks = Array.from(slideRoot.querySelectorAll("*"))
          .filter(node => node instanceof HTMLElement) as HTMLElement[];
        const checklistCandidates = checklistBlocks.filter(block => {
          const className = typeof block.className === "string" ? block.className : "";
          const style = getComputedStyle(block);
          const hasBackdrop = className.includes("backdrop-blur") || style.backdropFilter !== "none";
          const hasBorder = style.borderStyle !== "none" && style.borderWidth !== "0px";
          const textCount = (block.textContent || "").trim().length;
          const childTextNodes = Array.from(block.querySelectorAll("*")).filter(child => {
            if (!(child instanceof HTMLElement)) return false;
            return (child.textContent || "").trim().length > 0;
          }).length;
          if (hasBackdrop && hasBorder && textCount > 0 && childTextNodes >= 2) return true;
          const radius = Number.parseFloat(style.borderRadius || "0");
          const hasShadow = style.boxShadow && style.boxShadow !== "none";
          const background = style.backgroundColor || "";
          const hasBg =
            background !== "transparent" &&
            background !== "rgba(0, 0, 0, 0)" &&
            background !== "rgba(0, 0, 0, 0.0)";
          return radius >= 12 && (hasShadow || hasBg) && textCount > 0 && childTextNodes >= 2;
        });

        const pickTextNode = (root: HTMLElement) => {
          const nodes = Array.from(root.querySelectorAll("div,span,p"))
            .filter(node => node instanceof HTMLElement)
            .filter(node => (node as HTMLElement).childElementCount === 0)
            .filter(node => ((node as HTMLElement).textContent || "").trim().length > 0) as HTMLElement[];
          if (!nodes.length) return null;
          const getFontWeight = (node: HTMLElement) => {
            const raw = getComputedStyle(node).fontWeight || "";
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed)) return parsed;
            if (raw.toLowerCase() === "bold") return 700;
            return 400;
          };
          return [...nodes].sort((a, b) => {
            const weightDiff = getFontWeight(b) - getFontWeight(a);
            if (weightDiff !== 0) return weightDiff;
            return getFontSize(b) - getFontSize(a);
          })[0];
        };

        const getChecklistCardBlocks = () => {
          const cards: { root: HTMLElement; leadNode: HTMLElement | null; textNode: HTMLElement | null }[] = [];
          const elements = Array.from(slideRoot.querySelectorAll("*"))
            .filter(node => node instanceof HTMLElement) as HTMLElement[];
          for (const el of elements) {
            const style = getComputedStyle(el);
            const className = typeof el.className === "string" ? el.className : "";
            const textCount = (el.textContent || "").trim().length;
            if (!textCount) continue;
            const radius = Number.parseFloat(style.borderRadius || "0");
            const hasShadow = style.boxShadow && style.boxShadow !== "none";
            const hasBackdrop = className.includes("backdrop-blur") || style.backdropFilter !== "none";
            const hasBorder = style.borderStyle !== "none" && style.borderWidth !== "0px";
            const background = style.backgroundColor || "";
            const hasBg =
              background !== "transparent" &&
              background !== "rgba(0, 0, 0, 0)" &&
              background !== "rgba(0, 0, 0, 0.0)";
            const meetsCardStyle = hasBackdrop || hasBorder || hasShadow || hasBg || radius >= 12;

            if (!meetsCardStyle) continue;
            const children = Array.from(el.children).filter(node => node instanceof HTMLElement) as HTMLElement[];
            let leadRow: HTMLElement | null = null;
            let textRow: HTMLElement | null = null;
            for (const child of children) {
              const childStyle = getComputedStyle(child);
              if (
                !leadRow &&
                childStyle.display === "flex" &&
                childStyle.alignItems === "center" &&
                pickTextNode(child)
              ) {
                leadRow = child;
              }
              if (!textRow) {
                const paddingLeft = Number.parseFloat(childStyle.paddingLeft || "0");
                const marginLeft = Number.parseFloat(childStyle.marginLeft || "0");
                if ((paddingLeft >= 12 || marginLeft >= 12) && pickTextNode(child)) {
                  textRow = child;
                }
              }
            }

            if (!leadRow && !textRow) {
              const nestedChildren = Array.from(el.querySelectorAll("*")).filter(node => node instanceof HTMLElement) as HTMLElement[];
              for (const nested of nestedChildren) {
                const nestedStyle = getComputedStyle(nested);
                if (
                  !leadRow &&
                  nestedStyle.display === "flex" &&
                  nestedStyle.alignItems === "center" &&
                  pickTextNode(nested)
                ) {
                  leadRow = nested;
                }
                if (!textRow) {
                  const paddingLeft = Number.parseFloat(nestedStyle.paddingLeft || "0");
                  const marginLeft = Number.parseFloat(nestedStyle.marginLeft || "0");
                  if ((paddingLeft >= 12 || marginLeft >= 12) && pickTextNode(nested)) {
                    textRow = nested;
                  }
                }
                if (leadRow && textRow) break;
              }
            }

            if (!leadRow && !textRow) continue;
            cards.push({
              root: el,
              leadNode: leadRow ? pickTextNode(leadRow) : null,
              textNode: textRow ? pickTextNode(textRow) : null
            });
          }

          if (!cards.length) return [];
          return cards.filter(card => !cards.some(other => other.root !== card.root && card.root.contains(other.root)));
        };

        const structuredCards = getChecklistCardBlocks();
        const checklistRoots = items.length
          ? new Set<HTMLElement>(
              structuredCards.length ? structuredCards.map(card => card.root) : checklistCandidates
            )
          : new Set<HTMLElement>();

        const textNodes = Array.from(slideRoot.querySelectorAll("h1,h2,h3,p,span,div"))
          .filter(node => node instanceof HTMLElement)
          .filter(node => (node as HTMLElement).childElementCount === 0)
          .filter(node => ((node as HTMLElement).textContent || "").trim().length > 0)
          .filter(node => {
            if (!checklistRoots.size) return true;
            for (const root of checklistRoots) {
              if (root.contains(node)) return false;
            }
            return true;
          }) as HTMLElement[];

        const sortedBySize = [...textNodes].sort((a, b) => getFontSize(b) - getFontSize(a));

        const setText = (
          node: HTMLElement | null | undefined,
          value: string,
          clearIfEmpty = false,
          preserveIfEmpty = false
        ) => {
          if (!node) return;
          if (value) {
            node.textContent = value;
            return;
          }
          if (clearIfEmpty && !preserveIfEmpty) {
            node.textContent = "";
          }
        };

        const used = new Set<HTMLElement>();
        const pickNode = (candidates: (HTMLElement | null | undefined)[]) => {
          for (const candidate of candidates) {
            if (!candidate) continue;
            if (used.has(candidate)) continue;
            used.add(candidate);
            return candidate;
          }
          return null;
        };

        const preserveCtaDefaults = slideIndex === slideCount;

        const headlineNode = pickNode([
          slideRoot.querySelector("[data-field='headline']") as HTMLElement | null,
          textNodes.find(node => ["H1", "H2", "H3"].includes(node.tagName)),
          sortedBySize[0]
        ]);
        setText(headlineNode, headline, true, preserveCtaDefaults);

        const subheadNode = pickNode([
          slideRoot.querySelector("[data-field='subhead']") as HTMLElement | null,
          slideRoot.querySelector("[data-field='subtitle']") as HTMLElement | null,
          textNodes.find(node => node.tagName === "P" && !used.has(node)),
          sortedBySize.find(node => !used.has(node))
        ]);
        const secondary = subhead || body;
        setText(subheadNode, secondary, true, preserveCtaDefaults);

        if (body && subhead) {
          const bodyNode = pickNode([
            slideRoot.querySelector("[data-field='body']") as HTMLElement | null,
            sortedBySize.find(node => !used.has(node))
          ]);
          setText(bodyNode, body, true, preserveCtaDefaults);
        }

        const quoteNode =
          (slideRoot.querySelector("blockquote") as HTMLElement | null) ||
          textNodes.find(node => /“|”/.test(node.textContent || "")) ||
          null;
        if (quoteNode) {
          let quoteText = quote;
          if (quote && quoteNode.tagName === "BLOCKQUOTE") {
            const trimmed = quote.trim();
            const hasLeadingQuote = trimmed.startsWith("“") || trimmed.startsWith("\"") || trimmed.startsWith("'");
            const hasTrailingQuote = trimmed.endsWith("”") || trimmed.endsWith("\"") || trimmed.endsWith("'");
            if (!hasLeadingQuote || !hasTrailingQuote) {
              quoteText = `“${trimmed.replace(/^“|^"|'|”|"|'$/g, "")}”`;
            }
          }
          setText(quoteNode, quoteText, true);
        }

        if (quoteNode && (headline || subhead)) {
          const existing = slideRoot.querySelector("[data-preview-headline]") as HTMLElement | null;
          if (!existing) {
            const wrapper = document.createElement("div");
            wrapper.setAttribute("data-preview-headline", "true");
            wrapper.style.display = "flex";
            wrapper.style.flexDirection = "column";
            wrapper.style.gap = "16px";
            wrapper.style.marginBottom = "32px";

            const headlineEl = document.createElement("div");
            const quoteStyle = getComputedStyle(quoteNode);
            headlineEl.style.fontFamily = quoteStyle.fontFamily || "'Space Grotesk', sans-serif";
            headlineEl.style.fontSize = "64px";
            headlineEl.style.fontWeight = "700";
            headlineEl.style.lineHeight = "1.1";
            headlineEl.style.color = quoteStyle.color || "#ffffff";
            headlineEl.textContent = headline;
            if (headline) wrapper.appendChild(headlineEl);

            if (subhead) {
              const subheadEl = document.createElement("div");
              subheadEl.style.fontFamily = quoteStyle.fontFamily || "'Inter', sans-serif";
              subheadEl.style.fontSize = "36px";
              subheadEl.style.fontWeight = "400";
              subheadEl.style.lineHeight = "1.3";
              subheadEl.style.color = quoteStyle.color || "#111827";
              subheadEl.style.opacity = "0.7";
              subheadEl.textContent = subhead;
              wrapper.appendChild(subheadEl);
            }

            quoteNode.parentElement?.insertBefore(wrapper, quoteNode);
          }
        }

        const attributionNode =
          textNodes.find(node => /^—/.test((node.textContent || "").trim())) ||
          textNodes.find(node => (node.textContent || "").trim().length <= 40) ||
          null;
        if (attribution) {
          const attributionValue = attribution.startsWith("—") ? attribution : `— ${attribution}`;
          setText(attributionNode, attributionValue, true);
        } else if (quote && attributionNode) {
          attributionNode.textContent = "";
        }

        if (items.length) {
          const cardBlocks = structuredCards.length
            ? structuredCards
            : checklistCandidates.length >= 2
              ? checklistCandidates.map(card => ({ root: card, leadNode: null, textNode: null }))
              : [];
          if (cardBlocks.length) {
            cardBlocks.forEach((card, index) => {
              const item = items[index];
              const cardRoot = "root" in card ? card.root : card;
              const cardTextNodes = Array.from(cardRoot.querySelectorAll("div,span,p"))
                .filter(node => node instanceof HTMLElement)
                .filter(node => (node as HTMLElement).childElementCount === 0)
                .filter(node => ((node as HTMLElement).textContent || "").trim().length > 0) as HTMLElement[];
              const leadNode =
                "leadNode" in card && card.leadNode
                  ? card.leadNode
                  : pickTextNode(cardRoot) || cardTextNodes[0] || null;
              const textNode =
                "textNode" in card && card.textNode
                  ? card.textNode
                  : cardTextNodes.find(node => node !== leadNode) || null;

              if (item && typeof item === "object") {
                const lead = String((item as any).lead || "").trim();
                const text = String((item as any).text || "").trim();
                if (leadNode) leadNode.textContent = lead || text;
                if (textNode) textNode.textContent = text ? text : "";
                for (const node of cardTextNodes) {
                  if (node !== leadNode && node !== textNode) node.textContent = "";
                }
                return;
              }
              const value = String(item ?? "").trim();
              if (leadNode) leadNode.textContent = value;
              for (const node of cardTextNodes) {
                if (node !== leadNode) node.textContent = "";
              }
            });
            if (items.length < cardBlocks.length) {
              for (let i = items.length; i < cardBlocks.length; i += 1) {
                const extra = cardBlocks[i];
                if ("root" in extra) {
                  extra.root.remove();
                } else {
                  (extra as HTMLElement).remove();
                }
              }
            }
          } else {
            const itemNodes = textNodes.filter(node => !used.has(node));
            let itemIndex = 0;
            for (const item of items) {
              if (itemIndex >= itemNodes.length) break;
              if (item && typeof item === "object") {
                const lead = String((item as any).lead || "").trim();
                const text = String((item as any).text || "").trim();
                if (itemNodes[itemIndex]) {
                  itemNodes[itemIndex].textContent = lead || text;
                  itemIndex += 1;
                }
                if (text && itemNodes[itemIndex]) {
                  itemNodes[itemIndex].textContent = text;
                  itemIndex += 1;
                }
                continue;
              }
              itemNodes[itemIndex].textContent = String(item);
              itemIndex += 1;
            }
          }
        } else if (checklistCandidates.length >= 2) {
          for (const block of checklistCandidates) {
            block.remove();
          }
        }

        const footerNode =
          (slideRoot.querySelector("[data-field='footer']") as HTMLElement | null) ||
          textNodes.find(node => /footer/i.test(node.className || ""));
        setText(footerNode, footer, true);

        if (pageNumber) {
          const pageNode = textNodes.find(node => /\d+\s*\/\s*\d+/.test(node.textContent || ""));
          setText(pageNode, pageNumber, true);
        }
      }

      return { wrapperMatches, selectedIsWrapper: slideRoot === wrapper };
    }, { slideIndex: i, slideCount, width, height, fields: placeholders });

    if (i === 1) {
      const captureMode = params.manifest.render?.capture || "auto";
      if (captureMode === "auto" && selection) {
        params.manifest.render.capture = selection.wrapperMatches && selection.selectedIsWrapper ? "slide" : "inner";
      }
    }

    await page.waitForTimeout(50);
    const handle = await page.$("[data-preview-root='true']");
    const buffer = handle
      ? await handle.screenshot({
          type: format,
          quality: format === "jpeg" ? quality : undefined
        })
      : await page.screenshot({
          type: format,
          quality: format === "jpeg" ? quality : undefined,
          fullPage: false
        });
    buffers.push(buffer);
  }

  await browser.close();
  await server.close();
  return buffers;
}

export async function generateTemplatePreview(params: {
  templateId: string;
  templateHash: string;
  templateFormat: "A" | "B" | "C";
  manifest: any;
  zip: JSZip;
}) : Promise<PreviewAsset[]> {
  const output = params.manifest.output as ManifestOutput;
  const slideCount = params.manifest.slide_count as number;
  const placeholderPayloads = Array.from({ length: slideCount }).map((_, i) =>
    buildPlaceholderPayload(i + 1, slideCount)
  );

  let buffers: Buffer[] = [];

  if (params.templateFormat === "A") {
    const slideHtml = await Promise.all(
      placeholderPayloads.map(placeholders =>
        buildSlidePreviewHtml({ templateId: params.templateId, placeholders })
      )
    );
    buffers = await renderHtmlSlides({ slideHtml, output });
  } else if (params.templateFormat === "B") {
    const manifestSlides = params.manifest.slides || [];
    const slideHtml = manifestSlides.map((slide: any, index: number) => {
      return buildFormatBSlideHtml({
        templateId: params.templateId,
        backgroundPath: slide.background,
        placeholders: placeholderPayloads[index] || placeholderPayloads[0],
        slidePlaceholders: slide.placeholders || [],
        output
      });
    });
    buffers = await renderHtmlSlides({ slideHtml, output });
  } else {
    buffers = await renderFormatCSlides({
      manifest: params.manifest as FormatCManifest,
      templateHash: params.templateHash,
      zip: params.zip
    });
  }

  const supabase = createSupabaseServerClient();
  const bucket = getSupabaseStorageBucket();

  const previewAssets: PreviewAsset[] = [];
  for (let i = 0; i < buffers.length; i += 1) {
    const slideIndex = i + 1;
    const filename = `slide_${String(slideIndex).padStart(2, "0")}.${output.format === "png" ? "png" : "jpg"}`;
    const storagePath = `template-previews/${params.templateId}/${params.templateHash}/${filename}`;
    const mime = output.format === "png" ? "image/png" : "image/jpeg";
    const buffer = buffers[i];

    const { error } = await supabase.storage.from(bucket).upload(storagePath, buffer, {
      contentType: mime,
      upsert: true
    });
    if (error) throw new Error(`preview_upload_failed:${error.message}`);

    const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
    previewAssets.push({
      slide_index: slideIndex,
      url: publicData.publicUrl,
      width: output.width,
      height: output.height,
      bytes: buffer.length,
      mime
    });
  }

  return previewAssets;
}

export async function renderFormatCPostSlides(params: {
  manifest: FormatCManifest;
  templateHash: string;
  zip: JSZip;
  payloads: Array<{ slide_index: number; slide_count: number; fields: Record<string, unknown> }>;
}) {
  return renderFormatCSlides({
    manifest: params.manifest,
    templateHash: params.templateHash,
    zip: params.zip,
    payloads: params.payloads
  });
}
