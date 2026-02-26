import path from "node:path";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}services${path.sep}renderer`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeFields(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { headline: trimmed };
    }
    return { headline: trimmed };
  }
  if (Array.isArray(raw)) {
    return { items: raw };
  }
  if (typeof raw === "object") {
    const fields = { ...raw };
    if (typeof fields.items === "string") {
      const parts = fields.items
        .split("|")
        .map(part => part.trim())
        .filter(Boolean);
      fields.items = parts;
    }
    return fields;
  }
  return {};
}

async function startStaticServer(rootDir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let filePath = url.pathname;
      if (filePath.endsWith("/")) filePath += "index.html";
      const resolved = path.join(rootDir, decodeURIComponent(filePath));
      const file = await fs.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const contentType =
        ext === ".html"
          ? "text/html"
          : ext === ".js"
            ? "application/javascript"
            : ext === ".css"
              ? "text/css"
              : ext === ".png"
                ? "image/png"
                : ext === ".jpg" || ext === ".jpeg"
                  ? "image/jpeg"
                  : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(file);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function removeWithRetries(target) {
  const delays = [100, 250, 500, 1000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err?.code === "ENOENT") return;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function safeResetDirectory(target) {
  try {
    await fs.access(target);
  } catch {
    return;
  }
  const stalePath = `${target}-stale-${Date.now()}`;
  try {
    await fs.rename(target, stalePath);
    await removeWithRetries(stalePath);
  } catch {
    await removeWithRetries(target);
  }
}

async function ensureFormatCBuild({ templateHash, zipBuffer }) {
  const repoRoot = getRepoRoot();
  const cacheRoot = process.env.RENDERER_CACHE_DIR || path.join(repoRoot, ".cache", "renderer-builds");
  const templateDir = path.join(cacheRoot, templateHash);
  const distIndex = path.join(templateDir, "dist", "index.html");
  const buildIndex = path.join(templateDir, "build", "index.html");

  try {
    await fs.access(distIndex);
    return { templateDir, distIndex };
  } catch {
    // continue build
  }

  await safeResetDirectory(templateDir);
  await fs.mkdir(templateDir, { recursive: true });

  const zip = await JSZip.loadAsync(zipBuffer);
  const fileEntries = Object.values(zip.files).filter(entry => !entry.dir);
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

  const pkgLock = path.join(templateDir, "package-lock.json");
  let hasLock = false;
  try {
    await fs.access(pkgLock);
    hasLock = true;
  } catch {
    hasLock = false;
  }

  const installArgs = hasLock ? ["ci", "--no-fund", "--no-audit"] : ["install", "--no-fund", "--no-audit"];
  await execFileAsync("npm", installArgs, { cwd: templateDir, env: process.env });

  try {
    await execFileAsync("npm", ["run", "build", "--", "--base=./"], { cwd: templateDir, env: process.env });
  } catch {
    await execFileAsync("npm", ["run", "build"], { cwd: templateDir, env: process.env });
  }

  try {
    await fs.access(distIndex);
    return { templateDir, distIndex };
  } catch {
    // continue
  }
  try {
    await fs.access(buildIndex);
    return { templateDir, distIndex: buildIndex };
  } catch {
    throw new Error("format_c_build_missing_output");
  }
}

export async function renderFormatCSlides({ manifest, zipBuffer, payloads }) {
  if (!manifest?.output) throw new Error("manifest_output_missing");
  const output = manifest.output;
  const captureMode = manifest.render?.capture || "auto";
  const templateHash =
    manifest.template_hash || createHash("sha256").update(zipBuffer).digest("hex");

  const { distIndex } = await ensureFormatCBuild({ templateHash, zipBuffer });
  const rootDir = path.dirname(distIndex);
  const server = await startStaticServer(rootDir);

  const slideCount = manifest.slide_count || payloads.length;
  const { width, height, format, quality } = output;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });

  const payloadMap = new Map();
  for (const payload of payloads || []) {
    if (payload?.slide_index) payloadMap.set(payload.slide_index, payload);
  }

  const buffers = [];
  for (let i = 1; i <= slideCount; i += 1) {
    const payload = payloadMap.get(i);
    if (!payload) {
      throw new Error(`slide_payload_missing:${i}`);
    }
    const fields = normalizeFields(payload.fields);
    const data = {
      output,
      post: {
        slide_index: payload.slide_index,
        slide_count: payload.slide_count,
        fields
      }
    };
    const encoded = base64UrlEncode(JSON.stringify(data));
    const slideParam = manifest.render?.query?.slide || "slide";
    const dataParam = manifest.render?.query?.data || "data";
    const url = `${server.baseUrl}/index.html?${encodeURIComponent(slideParam)}=${i}&${encodeURIComponent(dataParam)}=${encoded}`;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector(`#slide-${i}`, { timeout: 8000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    await page.evaluate(({ slideIndex, slideCount, width, height, fields, capture }) => {
      const allSlides = Array.from(document.querySelectorAll("[id^='slide-']"))
        .filter(node => node instanceof HTMLElement);
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

      const findSlideByIndex = (index) =>
        parsedSlides.find(slide => slide.index === index)?.node || null;
      const contentSlides = parsedSlides.filter(
        slide => slide.index !== null && slide.index !== 1 && slide.index !== slideCount
      );
      const findSlideByLayout = (layout) =>
        contentSlides.find(slide => slide.layout === layout)?.node || null;
      const fallbackContentSlide = contentSlides[0]?.node || null;

      const safeFields = (fields || {});
      const layoutHint = String(
        safeFields.layout ||
          (safeFields.quote ? "quote" : Array.isArray(safeFields.items) && safeFields.items.length ? "checklist" : "headline")
      ).toLowerCase();

      let wrapper = null;
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
      if (!wrapper) return;

      const nodes = [wrapper, ...Array.from(wrapper.querySelectorAll("*"))].filter(
        node => node instanceof HTMLElement
      );
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
          return { node, score };
        })
        .sort((a, b) => b.score - a.score);

      const slideRoot = candidates[0]?.node ?? wrapper;
      slideRoot.setAttribute("data-render-root", "true");
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

      document.querySelectorAll("[data-render-root='true']").forEach(node => {
        if (node !== slideRoot) node.removeAttribute("data-render-root");
      });

      if (capture === "slide") {
        wrapper.setAttribute("data-render-root", "true");
      } else if (capture === "inner") {
        slideRoot.setAttribute("data-render-root", "true");
      }

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
        const getFontSize = (node) => {
          const size = Number.parseFloat(getComputedStyle(node).fontSize || "0");
          return Number.isFinite(size) ? size : 0;
        };

        const checklistBlocks = Array.from(slideRoot.querySelectorAll("*"))
          .filter(node => node instanceof HTMLElement);
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

        const pickTextNode = (root) => {
          const nodes = Array.from(root.querySelectorAll("div,span,p"))
            .filter(node => node instanceof HTMLElement)
            .filter(node => node.childElementCount === 0)
            .filter(node => (node.textContent || "").trim().length > 0);
          if (!nodes.length) return null;
          const getFontWeight = (node) => {
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
          const cards = [];
          const elements = Array.from(slideRoot.querySelectorAll("*"))
            .filter(node => node instanceof HTMLElement);
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
            const children = Array.from(el.children).filter(node => node instanceof HTMLElement);
            let leadRow = null;
            let textRow = null;
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
              const nestedChildren = Array.from(el.querySelectorAll("*")).filter(node => node instanceof HTMLElement);
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
          ? new Set(
              structuredCards.length ? structuredCards.map(card => card.root) : checklistCandidates
            )
          : new Set();

        const textNodes = Array.from(slideRoot.querySelectorAll("h1,h2,h3,p,span,div"))
          .filter(node => node instanceof HTMLElement)
          .filter(node => node.childElementCount === 0)
          .filter(node => (node.textContent || "").trim().length > 0)
          .filter(node => {
            if (!checklistRoots.size) return true;
            for (const root of checklistRoots) {
              if (root.contains(node)) return false;
            }
            return true;
          });

        const sortedBySize = [...textNodes].sort((a, b) => getFontSize(b) - getFontSize(a));

        const setText = (node, value, clearIfEmpty = false) => {
          if (!node) return;
          if (value) {
            node.textContent = value;
            return;
          }
          if (clearIfEmpty) {
            node.textContent = "";
          }
        };

        const used = new Set();
        const pickNode = (candidates) => {
          for (const candidate of candidates) {
            if (!candidate) continue;
            if (used.has(candidate)) continue;
            used.add(candidate);
            return candidate;
          }
          return null;
        };

        const headlineNode = pickNode([
          slideRoot.querySelector("[data-field='headline']"),
          textNodes.find(node => ["H1", "H2", "H3"].includes(node.tagName)),
          sortedBySize[0]
        ]);
        setText(headlineNode, headline, true);

        const subheadNode = pickNode([
          slideRoot.querySelector("[data-field='subhead']"),
          slideRoot.querySelector("[data-field='subtitle']"),
          textNodes.find(node => node.tagName === "P" && !used.has(node)),
          sortedBySize.find(node => !used.has(node))
        ]);
        const secondary = subhead || body;
        setText(subheadNode, secondary, true);

        if (body && subhead) {
          const bodyNode = pickNode([
            slideRoot.querySelector("[data-field='body']"),
            sortedBySize.find(node => !used.has(node))
          ]);
          setText(bodyNode, body, true);
        }

        const quoteNode =
          slideRoot.querySelector("blockquote") ||
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
          const existing = slideRoot.querySelector("[data-render-headline]");
          if (!existing) {
            const wrapperEl = document.createElement("div");
            wrapperEl.setAttribute("data-render-headline", "true");
            wrapperEl.style.display = "flex";
            wrapperEl.style.flexDirection = "column";
            wrapperEl.style.gap = "16px";
            wrapperEl.style.marginBottom = "32px";

            const headlineEl = document.createElement("div");
            const quoteStyle = getComputedStyle(quoteNode);
            headlineEl.style.fontFamily = quoteStyle.fontFamily || "'Space Grotesk', sans-serif";
            headlineEl.style.fontSize = "64px";
            headlineEl.style.fontWeight = "700";
            headlineEl.style.lineHeight = "1.1";
            headlineEl.style.color = quoteStyle.color || "#111827";
            headlineEl.textContent = headline;
            if (headline) wrapperEl.appendChild(headlineEl);

            if (subhead) {
              const subheadEl = document.createElement("div");
              subheadEl.style.fontFamily = quoteStyle.fontFamily || "'Inter', sans-serif";
              subheadEl.style.fontSize = "36px";
              subheadEl.style.fontWeight = "400";
              subheadEl.style.lineHeight = "1.3";
              subheadEl.style.color = quoteStyle.color || "#111827";
              subheadEl.style.opacity = "0.7";
              subheadEl.textContent = subhead;
              wrapperEl.appendChild(subheadEl);
            }

            quoteNode.parentElement?.insertBefore(wrapperEl, quoteNode);
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
              const cardRoot = card.root || card;
              const cardTextNodes = Array.from(cardRoot.querySelectorAll("div,span,p"))
                .filter(node => node instanceof HTMLElement)
                .filter(node => node.childElementCount === 0)
                .filter(node => (node.textContent || "").trim().length > 0);
              const leadNode = card.leadNode || pickTextNode(cardRoot) || cardTextNodes[0] || null;
              const textNode = card.textNode || cardTextNodes.find(node => node !== leadNode) || null;

              if (item && typeof item === "object") {
                const lead = String(item.lead || "").trim();
                const text = String(item.text || "").trim();
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
              for (let idx = items.length; idx < cardBlocks.length; idx += 1) {
                const extra = cardBlocks[idx];
                if (extra.root) {
                  extra.root.remove();
                } else {
                  extra.remove();
                }
              }
            }
          } else {
            const itemNodes = textNodes.filter(node => !used.has(node));
            let itemIndex = 0;
            for (const item of items) {
              if (itemIndex >= itemNodes.length) break;
              if (item && typeof item === "object") {
                const lead = String(item.lead || "").trim();
                const text = String(item.text || "").trim();
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
          slideRoot.querySelector("[data-field='footer']") ||
          textNodes.find(node => /footer/i.test(node.className || ""));
        setText(footerNode, footer, true);

        if (pageNumber) {
          const pageNode = textNodes.find(node => /\d+\s*\/\s*\d+/.test(node.textContent || ""));
          setText(pageNode, pageNumber, true);
        }
      }
    }, { slideIndex: i, slideCount, width, height, fields: payload.fields || {}, capture: captureMode });

    const handle = await page.$("[data-render-root='true']");
    const buf = handle
      ? await handle.screenshot({
          type: format === "png" ? "png" : "jpeg",
          quality: format === "jpeg" ? quality : undefined
        })
      : await page.screenshot({
          type: format === "png" ? "png" : "jpeg",
          quality: format === "jpeg" ? quality : undefined,
          fullPage: false
        });
    buffers.push(buf);
  }

  await browser.close();
  await server.close();

  return { buffers, output, templateHash };
}
